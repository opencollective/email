import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
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
/** ids of the messages rendered folded, in page order */
const folded = (html: string) =>
  [...html.matchAll(/class="msg \w+ folded" id="m(\d+)"/g)].map((m) => Number(m[1]))

test('a thread you have read folds what you have already seen, keeping the last word on each side', async () => {
  const fx = await fixture()

  // first visit: nothing has been read yet, so nothing is folded
  const first = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.deepEqual(folded(first), [], 'nothing folds before you have read anything')

  // she read up to message 4; message 5 arrived after
  await run('UPDATE thread_reads SET last_seen_at = ? WHERE thread_id = ? AND member_id = ?',
    [fx.t0 + 3 * 3600 + 60, fx.threadId, fx.alice.id])
  const second = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.deepEqual(folded(second), [fx.ids[0], fx.ids[1], fx.ids[2]],
    'read messages fold, except the last from each side; the unread one stays open')

  // Bob has never opened it — his view is untouched
  const bobs = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)).text()
  assert.deepEqual(folded(bobs), [], 'folding is per member, not per thread')
})

test('folding a message is remembered for that member alone', async () => {
  const fx = await fixture()
  await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)
  await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)
  await run('UPDATE thread_reads SET last_seen_at = ? WHERE thread_id = ?', [fx.t0 + 3 * 3600 + 60, fx.threadId])

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
  await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)
  await run('UPDATE thread_reads SET last_seen_at = ? WHERE thread_id = ?', [fx.t0 + 3 * 3600 + 60, fx.threadId])
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
