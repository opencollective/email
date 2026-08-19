import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { addTag, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

/** A thread with five messages, alternating sides, oldest first. */
async function fixture() {
  const slug = `tv${uniq()}`
  const collective = await createCollective(slug, 'Thread View Co')
  const mk = async (name: string) => {
    const email = `${name.toLowerCase()}-${uniq()}@example.org`
    const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, email, name, 'admin', 'every', now()])
    return { id: r.lastId, email, sid: await createSession(email) }
  }
  const alice = await mk('Alice')
  const bob = await mk('Bob')
  const t0 = now() - 6 * 3600
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
    first_message_at, last_message_at, last_direction, created_at, updated_at) VALUES (?, 'Room booking', 'needs_reply', 'miriam@out.test', 'Miriam Dean', ?, ?, 'inbound', ?, ?)`,
    [collective.id, t0, t0 + 4 * 3600, t0, now()])
  const threadId = t.lastId
  const ids: number[] = []
  for (const [i, dir] of ['inbound', 'outbound', 'inbound', 'outbound', 'inbound'].entries()) {
    const r = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, body_text, sent_at, created_at, sent_by_member_id)
      VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      [threadId, `<tv${uniq()}@x>`, dir,
        dir === 'inbound' ? 'Miriam Dean' : 'Thread View Co',
        dir === 'inbound' ? 'miriam@out.test' : `${slug}@collective.email`,
        `message number ${i + 1} of this conversation`, t0 + i * 3600, t0 + i * 3600,
        dir === 'outbound' ? alice.id : null])
    ids.push(r.lastId)
  }
  return { slug, collective, alice, bob, threadId, ids, t0 }
}

const page = (path: string, sid: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })
const post = (path: string, sid: string, body: string) => app.request(path, {
  method: 'POST',
  headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
  body,
})
const seenBeacon = (slug: string, threadId: number, sid: string, upTo: number) => app.request(`/inbox/${slug}/thread/${threadId}/seen`, {
  method: 'POST', headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: `up_to=${upTo}`,
})

/** ids of the messages rendered folded, in page order */
const folded = (html: string) =>
  [...html.matchAll(/class="msg \w+ folded" id="m(\d+)"/g)].map((m) => Number(m[1]))

test('a thread you have read folds what you have already seen, keeping the last word on each side', async () => {
  const fx = await fixture()

  // first visit: nothing has been read yet, so nothing is folded
  const first = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.deepEqual(folded(first), [], 'nothing folds before you have read anything')

  // she read up to message 4; message 5 arrived after
  await seenBeacon(fx.slug, fx.threadId, fx.alice.sid, fx.t0 + 3 * 3600 + 60)
  const second = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.deepEqual(folded(second), [fx.ids[0], fx.ids[1], fx.ids[2]],
    'read messages fold, except the last from each side; the unread one stays open')

  // Bob has never opened it — his view is untouched
  const bobs = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)).text()
  assert.deepEqual(folded(bobs), [], 'folding is per member, not per thread')
})

test('folding a message is remembered for that member alone', async () => {
  const fx = await fixture()
  await seenBeacon(fx.slug, fx.threadId, fx.alice.sid, fx.t0 + 3 * 3600 + 60)
  await seenBeacon(fx.slug, fx.threadId, fx.bob.sid, fx.t0 + 3 * 3600 + 60)

  // she folds the newest message away, and unfolds the oldest one
  const r = await post(`/inbox/${fx.slug}/thread/${fx.threadId}/fold`, fx.alice.sid, `message_id=${fx.ids[4]}&collapsed=1`)
  assert.equal(r.status, 302)
  assert.match(r.headers.get('location')!, new RegExp(`#m${fx.ids[4]}$`), 'comes back to the message')
  await post(`/inbox/${fx.slug}/thread/${fx.threadId}/fold`, fx.alice.sid, `message_id=${fx.ids[0]}&collapsed=0`)

  const hers = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.deepEqual(folded(hers), [fx.ids[1], fx.ids[2], fx.ids[4]],
    'her choices win over the defaults, in both directions')

  const his = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)).text()
  assert.deepEqual(folded(his), [fx.ids[0], fx.ids[1], fx.ids[2]], 'Bob still sees the defaults')

  // a message from another thread cannot be folded through this one
  const other = await createCollective(`tvx${uniq()}`, 'Elsewhere')
  const ot = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Other', 'needs_reply', 'x@y.test', ?, ?, 'inbound', ?, ?)`, [other.id, now(), now(), now(), now()])
  const om = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'x@y.test', '[]', 'hi', ?, ?)`, [ot.lastId, `<o${uniq()}@x>`, now(), now()])
  const bad = await post(`/inbox/${fx.slug}/thread/${fx.threadId}/fold`, fx.alice.sid, `message_id=${om.lastId}&collapsed=1`)
  assert.equal(bad.status, 404)
  assert.equal(await get('SELECT * FROM message_folds WHERE message_id = ?', [om.lastId]), undefined)
})

test('a folded message still shows its first line', async () => {
  const fx = await fixture()
  await seenBeacon(fx.slug, fx.threadId, fx.alice.sid, fx.t0 + 3 * 3600 + 60)
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.match(html, /class="msg-peek" data-peek="true">message number 1 of this conversation</)
})

test('the sidebar lists what is attached, images apart from files', async () => {
  const fx = await fixture()
  const att = async (messageId: number, filename: string, type: string, size: number) =>
    run('INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, ?, ?, ?, ?)',
      [messageId, filename, type, size, `/tmp/${filename}`])
  const empty = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.doesNotMatch(empty, /class="label">Files|class="label">Images/, 'no sections when nothing is attached')

  await att(fx.ids[1], 'contract.pdf', 'application/pdf', 20480)
  await att(fx.ids[4], 'floorplan.png', 'image/png', 4096)
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const side = html.slice(html.indexOf('thread-side'))
  assert.match(side, /class="label">Images<\/span>[\s\S]*floorplan\.png/)
  assert.match(side, /class="label">Files<\/span>[\s\S]*contract\.pdf/)
  assert.match(side, /20 KB/, 'files carry their size')
  assert.doesNotMatch(side.slice(side.indexOf('>Files<')), /floorplan/, 'an image is not listed twice as a file')
})

test('the sender card carries the full address and the rest of their history', async () => {
  const fx = await fixture()
  // a second thread with the same person, so there is something to link to
  await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Invoice', 'needs_reply', 'miriam@out.test', ?, ?, 'inbound', ?, ?)`,
    [fx.collective.id, now(), now(), now(), now()])

  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const card = html.slice(html.indexOf('person-card'), html.indexOf('person-card') + 1400)
  assert.match(card, /class="pc-addr">miriam@out\.test</, 'the full address, not the display name')
  assert.match(card, /data-copy="miriam@out\.test"/, 'one click copies it')
  assert.match(card, /1 other thread/, 'and says where else they appear')

  // the member who sent the reply gets a card too, with their own address
  const mine = html.slice(html.indexOf(`data-copy="${fx.alice.email}"`) - 400, html.indexOf(`data-copy="${fx.alice.email}"`) + 1200)
  assert.match(mine, /Alice/)
  assert.match(mine, /Admin of Thread View Co/)
})

test('the Next block states one action and when the last message landed', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const next = html.slice(html.indexOf('next-block'), html.indexOf('next-block') + 900)
  assert.match(next, /Reply to Miriam/)
  assert.match(next, /Last message today/)
  assert.match(next, /mark as closed/)
  assert.doesNotMatch(next, /waiting|Waiting|⚠/, 'no countdown, no warning sign')

  // closed threads say so, and stop offering to close again
  await post(`/inbox/${fx.slug}/thread/${fx.threadId}/status`, fx.alice.sid, 'status=closed')
  const closed = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const nextClosed = closed.slice(closed.indexOf('next-block'), closed.indexOf('next-block') + 900)
  assert.match(nextClosed, /Closed/)
  assert.doesNotMatch(nextClosed, /mark as closed/)
})

test('who has seen a thread is said by name, up to three of them', async () => {
  const fx = await fixture()
  const extra = []
  for (const name of ['Miriam', 'Carla', 'Ruta']) {
    const email = `${name.toLowerCase()}-${uniq()}@example.org`
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [fx.collective.id, email, `${name} Dean`, 'member', 'every', now()])
    extra.push(await createSession(email))
  }
  await seenBeacon(fx.slug, fx.threadId, fx.alice.sid, now())
  const seen = async () => {
    const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
    return [...html.matchAll(/seen by ([^<]+)</g)].map((m) => m[1])
  }
  await seenBeacon(fx.slug, fx.threadId, extra[0], now())
  assert.ok((await seen()).every((s) => /Alice|Miriam/.test(s)), 'two readers, named')
  assert.ok((await seen()).some((s) => s.includes(' and ')), '"X and Y", not "2 people"')

  await seenBeacon(fx.slug, fx.threadId, extra[1], now())
  await seenBeacon(fx.slug, fx.threadId, extra[2], now())
  const four = await seen()
  assert.ok(four.some((s) => /Ruta/.test(s) && !/other/.test(s)),
    `four readers all named — "and 1 other" is never shorter than the name — got ${JSON.stringify(four)}`)

  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.collective.id, `eve-${uniq()}@example.org`, 'Eve Dean', 'member', 'every', now()])
  const eve = await createSession((await get<any>('SELECT email FROM members WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [fx.collective.id])).email)
  await seenBeacon(fx.slug, fx.threadId, eve, now())
  const many = await seen()
  assert.ok(many.some((s) => /and \d+ others$/.test(s)), `five+ readers: three names then a plural count — got ${JSON.stringify(many)}`)
  assert.ok(many.every((s) => !s.includes('Dean')), 'first names only')
})

test('an admin can set who mail from this sender goes to, straight from their card', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const card = html.slice(html.indexOf('person-card'), html.indexOf('person-card') + 2000)
  assert.match(card, /New threads from them go to/)

  const r = await post(`/inbox/${fx.slug}/contact/miriam%40out.test/auto-assign`, fx.alice.sid,
    `member_id=${fx.bob.id}&back=${encodeURIComponent(`/inbox/${fx.slug}/thread/${fx.threadId}`)}`)
  assert.equal(r.status, 302)
  assert.match(r.headers.get('location')!, new RegExp(`/inbox/${fx.slug}/thread/${fx.threadId}\\?m=`), 'back to the thread, not the contact page')
  const rule = await get<any>('SELECT * FROM rules WHERE collective_id = ? AND lower(match_from) = ?', [fx.collective.id, 'miriam@out.test'])
  assert.equal(rule.assign_member_id, fx.bob.id)

  // and the card comes back with that member selected
  const after = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const card2 = after.slice(after.indexOf('person-card'), after.indexOf('person-card') + 2000)
  assert.match(card2, new RegExp(`<option value="${fx.bob.id}" selected="">Bob</option>`))

  // an off-site "back" is ignored
  const evil = await post(`/inbox/${fx.slug}/contact/miriam%40out.test/auto-assign`, fx.alice.sid,
    `member_id=${fx.bob.id}&back=${encodeURIComponent('https://evil.test/steal')}`)
  assert.doesNotMatch(evil.headers.get('location')!, /evil\.test/)
})

test('an answer from an address that is neither ours nor a member\'s is shown under that address', async () => {
  const fx = await fixture()
  // exactly the shape ingest files as an "unknown answer": not from a member,
  // not from our own address, but addressed to the thread's counterpart
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, body_text, sent_at, created_at, sent_by_member_id)
    VALUES (?, ?, 'outbound', 'Front Desk', 'hello@theirdomain.test', '["miriam@out.test"]', 'Forwarding this on.', ?, ?, NULL)`,
    [fx.threadId, `<u${uniq()}@x>`, now(), now()])
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()

  const heads = [...html.matchAll(/class="person-hit"[\s\S]{0,600}?<b>([^<]+)<\/b>/g)].map((m) => m[1])
  assert.ok(heads.includes('Front Desk'), `shown under its real sender — got ${JSON.stringify(heads)}`)
  const card = html.slice(html.lastIndexOf('person-card'))
  assert.match(card, /hello@theirdomain\.test/, 'the card carries the address we actually stored')
  assert.doesNotMatch(card.slice(0, 400), /Thread View Co<\/b>/, 'not presented as the collective')
})

test('each message has a menu: copy link, reply, forward — and the link opens focused', async () => {
  const fx = await fixture()
  await seenBeacon(fx.slug, fx.threadId, fx.alice.sid, fx.t0 + 5 * 3600)
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.doesNotMatch(html, /class="icon-btn fold-btn"/, 'the caret is gone')
  assert.match(html, new RegExp(`data-copy="[^"]*/thread/${fx.threadId}\\?focus=${fx.ids[2]}#m${fx.ids[2]}"`), 'copy link, anchored at the message')
  assert.match(html, /class="menu-item" href="#composer">Reply</)
  assert.match(html, /Forward…/)

  // the copied link opens with everything else folded, whatever was read
  const focused = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}?focus=${fx.ids[2]}`, fx.alice.sid)).text()
  assert.deepEqual(folded(focused), [fx.ids[0], fx.ids[1], fx.ids[3], fx.ids[4]], 'only the focused message is open')
})

test('bare URLs in a message become links; the text around them stays escaped', async () => {
  const fx = await fixture()
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'Miriam Dean', 'miriam@out.test', '[]', ?, ?, ?)`,
    [fx.threadId, `<l${uniq()}@x>`,
      'See photos here: https://commonshub.brussels/rooms/satoshi. Also <script>alert(1)</script> should stay text.',
      now(), now()])
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.match(html, /<a href="https:\/\/commonshub\.brussels\/rooms\/satoshi" target="_blank" rel="noopener noreferrer nofollow">/,
    'the URL is a link, without the sentence full stop')
  assert.doesNotMatch(html, /<script>alert/, 'surrounding text is still escaped')
})

test('HTML or text is a per-member choice remembered for the sender', async () => {
  const fx = await fixture()
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, body_text, body_html, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'Miriam Dean', 'miriam@out.test', '[]', 'plain fallback', '<table><tr><td>fancy newsletter layout</td></tr></table>', ?, ?)`,
    [fx.threadId, `<h${uniq()}@x>`, now(), now()])

  // default for ordinary mail: text, with the option to switch
  let html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.doesNotMatch(html, /class="msg-frame"/)
  assert.match(html, /Show HTML email/)

  const r = await post(`/inbox/${fx.slug}/thread/${fx.threadId}/view`, fx.alice.sid, 'email=miriam%40out.test&mode=html')
  assert.equal(r.status, 302)
  html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.match(html, /class="msg-frame"/, 'now rendered as HTML')
  assert.match(html, /Show text email/, 'and the menu offers the way back')

  // Bob never chose anything — he still gets text
  const bobs = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)).text()
  assert.doesNotMatch(bobs, /class="msg-frame"/, 'the preference is per member')
})

test('the assign modal carries the create-a-rule form; the sidebar no longer does', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  const modal = html.slice(html.indexOf('assign-modal'), html.indexOf('</dialog>'))
  assert.match(modal, /Create a rule for similar messages/)
  const aside = html.slice(html.indexOf('class="thread-side"'))
  assert.doesNotMatch(aside, /Create a rule for similar messages/)
})

test('the inbox opens on needs-reply; pills reach mine, unassigned, and tags without a #', async () => {
  const fx = await fixture()
  // fixture thread needs a reply; add an answered one and an assigned one
  await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Old news', 'answered', 'x@y.test', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, now(), now(), now(), now()])
  await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [fx.bob.id, fx.threadId])

  const dflt = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  assert.match(dflt, /Room booking/, 'the open thread is there')
  assert.doesNotMatch(dflt, /Old news/, 'the answered one waits behind the All pill')
  assert.match(dflt, /class="chip tag-chip[^>]*>Alice</, 'the mine pill carries the first name')
  assert.match(dflt, />Unassigned</, 'without a warning sign')
  assert.doesNotMatch(dflt, /⚠ Unassigned/)

  const alls = await (await page(`/inbox/${fx.slug}?f=all`, fx.alice.sid)).text()
  assert.match(alls, /Old news/)

  // the modal's per-person filter: Bob's threads only
  const bobs = await (await page(`/inbox/${fx.slug}?f=all&a=${fx.bob.id}`, fx.alice.sid)).text()
  assert.match(bobs, /Room booking/)
  assert.doesNotMatch(bobs, /Old news/)

  // tag pills drop the leading #
  await addTag(fx.collective.id, fx.threadId, 'venue-rental', null)
  const tagged = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  const bar = tagged.slice(tagged.indexOf('class="tag-bar"'), tagged.indexOf('<dialog id="filter-modal"'))
  assert.match(bar, />venue-rental <span/, 'the tag pill is just the name')
  assert.doesNotMatch(bar, /#venue-rental/)
})

test('a same-day closed thread still shows its date in the list', async () => {
  const fx = await fixture()
  await run("UPDATE threads SET status = 'closed', first_message_at = last_message_at WHERE id = ?", [fx.threadId])
  const html = await (await page(`/inbox/${fx.slug}?f=closed`, fx.alice.sid)).text()
  const row = html.slice(html.indexOf('class="row'), html.indexOf('r-name'))
  assert.match(row, /<b class="r-d2">\d/, 'the bold date every layout shows is never blank')
})

test('the filter modal narrows by tags, including the untagged', async () => {
  const fx = await fixture()
  const mk = async (subj: string) => (await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, ?, 'needs_reply', 'x@y.test', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, subj, now(), now(), now(), now()])).lastId
  const a = await mk('Tagged venue')
  const b = await mk('Tagged press')
  await mk('Bare thread')
  await addTag(fx.collective.id, a, 'venue-rental', null)
  await addTag(fx.collective.id, b, 'press', null)

  const get2 = async (qs: string) => await (await page(`/inbox/${fx.slug}?f=all&${qs}`, fx.alice.sid)).text()
  const one = await get2('tags=venue-rental')
  assert.match(one, /Tagged venue/); assert.doesNotMatch(one, /Tagged press|Bare thread/)
  const two = await get2('tags=venue-rental&tags=press')
  assert.match(two, /Tagged venue/); assert.match(two, /Tagged press/); assert.doesNotMatch(two, /Bare thread/)
  const bare = await get2('untagged=1')
  assert.match(bare, /Bare thread/); assert.doesNotMatch(bare, /Tagged venue|Tagged press/)
  const mixed = await get2('tags=press&untagged=1')
  assert.match(mixed, /Tagged press/); assert.match(mixed, /Bare thread/); assert.doesNotMatch(mixed, /Tagged venue/)
})

test('unassigned wears no warning triangle anywhere', async () => {
  const fx = await fixture()
  await run('UPDATE threads SET assignee_member_id = NULL WHERE id = ?', [fx.threadId])
  const inbox = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  const thread = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  for (const html of [inbox, thread]) {
    assert.doesNotMatch(html, /⚠ ?unassigned/i)
    assert.match(html, /unassigned/i, 'the state is still named, just not shouted')
  }
})
