import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import { addTag, all, createCollective, get, run, type Thread } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { createRule, matchingRule } from '../src/rules.js'
import { sanitizeEmailHtml } from '../src/sanitize.js'
import { ingestInbound } from '../src/ingest.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function addMember(collectiveId: number, email: string, role = 'member'): Promise<number> {
  const r = await run(
    'INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, email, email.split('@')[0], role, 'every', now()])
  return r.lastId
}

const lastThread = async (collectiveId: number) =>
  (await get<Thread>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [collectiveId]))!

// ---------- sanitizer ----------

test('sanitizeEmailHtml: keeps newsletter layout, kills execution vectors', () => {
  const dirty = `
    <table width="600" cellpadding="0" style="background-color:#fff"><tr><td align="center" style="padding:12px;color:rgb(20,20,20)">
      <h1 style="font-size:22px">Hello</h1>
      <img src="https://cdn.example.com/banner.png" width="560" alt="banner">
      <a href="https://example.com/read">Read more</a>
      <a href="javascript:alert(1)">bad link</a>
      <script>alert(1)</script>
      <div onclick="alert(1)" style="background:url(https://evil.test/track)">click</div>
      <iframe src="https://evil.test"></iframe>
      <form action="https://evil.test/phish"><input name="password"></form>
      <style>body{display:none}</style>
    </td></tr></table>`
  const clean = sanitizeEmailHtml(dirty)
  assert.match(clean, /<table width="600"/)
  assert.match(clean, /<img src="https:\/\/cdn\.example\.com\/banner\.png"/)
  assert.match(clean, /<a href="https:\/\/example\.com\/read" target="_blank" rel="noopener noreferrer nofollow"/)
  assert.match(clean, /color:rgb\(20,20,20\)/, 'rgb() colors survive')
  assert.doesNotMatch(clean, /<script|<iframe|<form|<input|<style/)
  assert.doesNotMatch(clean, /onclick|javascript:/)
  assert.doesNotMatch(clean, /url\(/, 'CSS url() is stripped')
  assert.doesNotMatch(clean, /display:none/)
})

// ---------- rules ----------

test('rule files matching mail: tagged, closed, unassigned, HTML kept; domain rules too', async () => {
  const col = await createCollective(`nws${uniq()}`, 'News Co')
  await addMember(col.id, `reader-${uniq()}@t.test`)
  await createRule(col, { from: 'update@nws.eventplanner.test', tag: 'newsletter' }, null)

  assert.ok(await matchingRule(col.id, 'update@nws.eventplanner.test', 'anything'))
  assert.equal(await matchingRule(col.id, 'other@nws.eventplanner.test', 'x'), undefined, 'exact rule does not match siblings')

  await ingestInbound(col, await simpleParser([
    'From: eventplanner <update@nws.eventplanner.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Weekly tips',
    `Message-ID: <n-${uniq()}@nws.test>`,
    'Content-Type: text/html; charset=utf-8',
    '', '<table><tr><td><h1>News!</h1><a href="https://eventplanner.test">site</a></td></tr></table>',
  ].join('\r\n')))
  const thread = await lastThread(col.id)
  assert.equal(thread.status, 'closed', 'filed, not needs_reply')
  assert.equal(thread.assignee_member_id, null)
  const tags = await all<any>('SELECT t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ?', [thread.id])
  assert.deepEqual(tags.map((t) => t.name), ['newsletter'])
  const msg = (await get<any>('SELECT * FROM messages WHERE thread_id = ?', [thread.id]))!
  assert.match(msg.body_html, /<h1>News!<\/h1>/)
  assert.match(msg.body_html, /target="_blank"/)

  // domain-wide rule
  await createRule(col, { from: '@news.koro.test', tag: 'newsletter' }, null)
  assert.ok(await matchingRule(col.id, 'anything@news.koro.test', 'x'))
})

test('creating a rule retro-applies to existing threads from that sender', async () => {
  const col = await createCollective(`retro${uniq()}`, 'Retro Co')
  const memberId = await addMember(col.id, `m-${uniq()}@t.test`)
  await ingestInbound(col, await simpleParser([
    'From: KoRo <marketing@news.koro.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: 50% off',
    `Message-ID: <k-${uniq()}@koro.test>`,
    '', 'Buy now',
  ].join('\r\n')))
  const thread = await lastThread(col.id)
  await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [memberId, thread.id])
  assert.equal(thread.status, 'needs_reply')

  const { applied } = await createRule(col, { from: 'marketing@news.koro.test', tag: 'newsletter' }, null)
  assert.equal(applied, 1)
  const after = (await get<Thread>('SELECT * FROM threads WHERE id = ?', [thread.id]))!
  assert.equal(after.status, 'closed')
  assert.equal(after.assignee_member_id, null)
  const tags = await all<any>('SELECT t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ?', [thread.id])
  assert.deepEqual(tags.map((t) => t.name), ['newsletter'])
})

test('rules pages: admins manage rules; non-admins are turned away', async () => {
  const col = await createCollective(`rp${uniq()}`, 'Rules Co')
  const adminEmail = `a-${uniq()}@t.test`
  await addMember(col.id, adminEmail, 'admin')
  const memberEmail = `p-${uniq()}@t.test`
  await addMember(col.id, memberEmail)
  const sid = await createSession(adminEmail)

  const create = await app.request(`/inbox/${col.slug}/rules`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'from=%40news.example.com&tag=Newsletter Weekly&close=1',
  })
  assert.equal(create.status, 302)
  const rule = (await get<any>('SELECT * FROM rules WHERE collective_id = ?', [col.id]))!
  assert.equal(rule.match_from, '@news.example.com')
  assert.equal(rule.tag, 'newsletter-weekly', 'tag is normalized')

  const page = await app.request(`/inbox/${col.slug}/rules`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(await page.text(), /@news\.example\.com/)

  const memberSid = await createSession(memberEmail)
  const denied = await app.request(`/inbox/${col.slug}/rules`, { headers: { cookie: `requests_sid=${memberSid}` } })
  assert.equal(denied.status, 302, 'non-admins bounce to the inbox')

  const del = await app.request(`/inbox/${col.slug}/rules/${rule.id}/delete`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}` },
  })
  assert.equal(del.status, 302)
  assert.equal(await get('SELECT * FROM rules WHERE collective_id = ?', [col.id]), undefined)
})

test('subject rules, assign action, and tag-only (no-close) rules', async () => {
  const col = await createCollective(`subj${uniq()}`, 'Subj Co')
  const miriam = await addMember(col.id, `miriam-${uniq()}@t.test`)

  // subject-only rule that closes and tags
  await createRule(col, { subject: 'Door Access', tag: 'updates' }, null)
  await ingestInbound(col, await simpleParser([
    'From: Website <site@tools.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Door Access for Poetry Night',
    `Message-ID: <d-${uniq()}@tools.test>`,
    '', 'Access code attached',
  ].join('\r\n')))
  const doorThread = await lastThread(col.id)
  assert.equal(doorThread.status, 'closed')
  const tags = await all<any>('SELECT t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ?', [doorThread.id])
  assert.deepEqual(tags.map((t) => t.name), ['updates'])

  // sender rule that ASSIGNS to Miriam without closing: stays needs_reply
  await createRule(col, { from: 'bookings@partner.test', tag: 'booking', assignMemberId: miriam, close: false }, null)
  await ingestInbound(col, await simpleParser([
    'From: Partner <bookings@partner.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: New booking request',
    `Message-ID: <b-${uniq()}@partner.test>`,
    '', 'Room please',
  ].join('\r\n')))
  const booking = await lastThread(col.id)
  assert.equal(booking.status, 'needs_reply', 'no-close rule keeps the thread visible')
  assert.equal(booking.assignee_member_id, miriam, 'assigned by the rule')

  // sender+subject rule: both must match
  await createRule(col, { from: '@digest.test', subject: 'weekly', tag: 'newsletter' }, null)
  assert.ok(await matchingRule(col.id, 'x@digest.test', 'Your Weekly roundup'))
  assert.equal(await matchingRule(col.id, 'x@digest.test', 'Invoice overdue'), undefined, 'subject must match too')
  assert.equal(await matchingRule(col.id, 'y@other.test', 'weekly things'), undefined, 'sender must match too')

  // two rules on the same sender with different subjects can coexist
  await createRule(col, { from: '@digest.test', subject: 'monthly', tag: 'updates' }, null)
  const monthly = await matchingRule(col.id, 'x@digest.test', 'The Monthly recap')
  assert.equal(monthly?.tag, 'updates')
})

test('thread sidebar reveals "create a rule for similar messages"; editor pre-fills', async () => {
  const col = await createCollective(`sb${uniq()}`, 'Sidebar Co')
  const adminEmail = `sba-${uniq()}@t.test`
  await addMember(col.id, adminEmail, 'admin')
  await ingestInbound(col, await simpleParser([
    'From: Luma <noreply@luma.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Re: Event Submitted to the Calendar',
    `Message-ID: <l-${uniq()}@luma.test>`,
    '', 'A new event was submitted',
  ].join('\r\n')))
  const thread = await lastThread(col.id)
  const sid = await createSession(adminEmail)

  const page = await app.request(`/inbox/${col.slug}/thread/${thread.id}`, { headers: { cookie: `requests_sid=${sid}` } })
  const html = await page.text()
  assert.match(html, /Create a rule for similar messages/)
  assert.match(html, /name="from" value="noreply@luma.test"/)
  assert.match(html, /name="subject" value="Event Submitted to the Calendar"/, 'Re: is stripped for the subject criterion')

  const editor = await app.request(
    `/inbox/${col.slug}/rules?from=${encodeURIComponent('noreply@luma.test')}&subject=${encodeURIComponent('Event Submitted')}&thread=${thread.id}`,
    { headers: { cookie: `requests_sid=${sid}` } })
  const editorHtml = await editor.text()
  assert.match(editorHtml, /value="noreply@luma.test"/, 'sender pre-filled')
  assert.match(editorHtml, /value="Event Submitted"/, 'subject pre-filled')
  assert.match(editorHtml, /Nobody — leave unassigned/)
  assert.match(editorHtml, /Close it — no reply needed/)

  // submitting the editor from the prefill creates the rule and returns to the thread
  const create = await app.request(`/inbox/${col.slug}/rules`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `from=noreply@luma.test&subject=&tag=updates&assign=&close=1&thread=${thread.id}`,
  })
  assert.equal(create.status, 302)
  assert.match(create.headers.get('location')!, new RegExp(`/thread/${thread.id}`), 'returns to the thread')
  const after = (await get<Thread>('SELECT * FROM threads WHERE id = ?', [thread.id]))!
  assert.equal(after.status, 'closed', 'retro-applied on creation')
})

// ---------- editing a rule ----------

test('a rule can be edited in place, keeping its id and re-applying', async () => {
  const slug = `edit${uniq()}`
  const col = await createCollective(slug, 'Edit Co')
  const admin = `admin-${uniq()}@example.org`
  await addMember(col.id, admin, 'admin')
  const leen = await addMember(col.id, `leen-${uniq()}@example.org`)
  const sid = await createSession(admin)
  const { rule } = await createRule(col, { from: '@news.example.com', tag: 'newsletter', close: true }, null)

  // a thread the rule already matches, so the edit has something to re-apply to
  await ingestInbound(col, await simpleParser([
    'From: weekly <weekly@news.example.com>',
    `To: ${slug}@collective.email`,
    'Subject: Weekly digest',
    `Message-ID: <edit-${uniq()}@news.example.com>`,
    '', 'hello',
  ].join('\r\n')))

  const res = await app.request(`/inbox/${slug}/rules/${rule.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams({ from: '@news.example.com', subject: '', tag: 'updates', assign: String(leen), close: '1' }),
  })
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')!), /Rule saved/)

  const after = (await get<any>('SELECT * FROM rules WHERE id = ?', [rule.id]))!
  assert.equal(after.tag, 'updates', 'same row, new shape')
  assert.equal(after.assign_member_id, leen)
  assert.equal((await all('SELECT id FROM rules WHERE collective_id = ?', [col.id])).length, 1, 'edited, not duplicated')

  // and the edit reached the thread that was already there
  const th = await lastThread(col.id)
  assert.equal(th.assignee_member_id, leen, 'existing matching thread got the new assignee')
})

test('editing a rule onto another rule\'s exact match is refused', async () => {
  const slug = `clash${uniq()}`
  const col = await createCollective(slug, 'Clash Co')
  const admin = `admin-${uniq()}@example.org`
  await addMember(col.id, admin, 'admin')
  const sid = await createSession(admin)
  await createRule(col, { from: '@a.example.com', tag: 'a', close: true }, null)
  const { rule: second } = await createRule(col, { from: '@b.example.com', tag: 'b', close: true }, null)

  const res = await app.request(`/inbox/${slug}/rules/${second.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams({ from: '@a.example.com', subject: '', tag: 'b', assign: '', close: '1' }),
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Another rule already matches/)
  assert.equal((await get<any>('SELECT match_from FROM rules WHERE id = ?', [second.id]))!.match_from, '@b.example.com', 'unchanged')
})

test('a non-admin cannot edit rules', async () => {
  const slug = `perm${uniq()}`
  const col = await createCollective(slug, 'Perm Co')
  const plain = `member-${uniq()}@example.org`
  await addMember(col.id, plain, 'member')
  const sid = await createSession(plain)
  const { rule } = await createRule(col, { from: '@c.example.com', tag: 'c', close: true }, null)

  const res = await app.request(`/inbox/${slug}/rules/${rule.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams({ from: '@hijack.example.com', tag: 'x', assign: '', close: '1' }),
  })
  assert.equal(res.headers.get('location'), `/inbox/${slug}`)
  assert.equal((await get<any>('SELECT tag FROM rules WHERE id = ?', [rule.id]))!.tag, 'c', 'untouched')
})

test('the rules page shows each rule as chips, with an editor per rule', async () => {
  const slug = `page${uniq()}`
  const col = await createCollective(slug, 'Page Co')
  const admin = `admin-${uniq()}@example.org`
  await addMember(col.id, admin, 'admin')
  const sid = await createSession(admin)
  const { rule } = await createRule(col, { from: 'updates@nws.eventplanner.net', tag: 'newsletter', close: true }, null)

  const html = await (await app.request(`/inbox/${slug}/rules`, { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(html, /Create rules to automatically tag or assign certain threads/)
  const row = /<div class="row no-sender rule-row">.*?<\/span><\/div>/s.exec(html)![0]
  assert.doesNotMatch(row, /unassigned/, 'a rule that assigns nobody says nothing about it')
  assert.match(html, /from updates@nws\.eventplanner\.net/)
  assert.match(html, /class="chip">#newsletter/)
  assert.match(html, /no reply needed/)
  assert.match(html, /Create a new rule/)
  assert.match(html, new RegExp(`id="rule-edit-${rule.id}"`), 'each rule carries its own editor sheet')
})

// ---------- tag suggestions ----------

test('the tag box suggests the collective vocabulary, most-used first, and one click applies it', async () => {
  const col = await createCollective(`tags${uniq()}`, 'Tag Co')
  const admin = `admin-${uniq()}@example.org`
  await addMember(col.id, admin, 'admin')
  const sid = await createSession(admin)

  // four tags whose popularity order (zoning, access, archive) is deliberately
  // NOT their alphabetical order, so the test can tell the two apart
  const threads: Thread[] = []
  for (let i = 0; i < 3; i++) {
    await ingestInbound(col, await simpleParser(
      `Message-ID: <b${i}-${uniq()}@out.test>\nFrom: guest${i}@out.test\nTo: ${col.slug}@requests.test\nSubject: Booking ${i}\n\nHello`))
    threads.push(await lastThread(col.id))
  }
  for (const [i, th] of threads.entries()) {
    await addTag(col.id, th.id, 'venue-rental', null)
    if (i < 2) await addTag(col.id, th.id, 'zoning', null)
    if (i < 1) await addTag(col.id, th.id, 'access', null)
  }
  // a tag the collective coined and then removed everywhere: still vocabulary
  await addTag(col.id, threads[0].id, 'archive', null)
  await run('DELETE FROM thread_tags WHERE tag_id = (SELECT id FROM tags WHERE collective_id = ? AND name = ?)',
    [col.id, 'archive'])

  // the third thread carries only #venue-rental, so the rest is still on offer
  const page = await app.request(`/inbox/${col.slug}/thread/${threads[2].id}`,
    { headers: { cookie: `requests_sid=${sid}` } })
  const html = await page.text()
  const order = [...html.matchAll(/class="chip tag-sug" type="submit" name="pick" value="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(order, ['zoning', 'access', 'archive'],
    'most-used first (not alphabetical); #venue-rental is already on this thread, so it is not re-offered')

  // clicking a suggestion posts `pick`, which wins over whatever was half-typed
  const applied = await app.request(`/inbox/${col.slug}/thread/${threads[2].id}/tags`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=zonin&pick=zoning',
  })
  assert.equal(applied.status, 302)
  const on = await all<any>('SELECT t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ? ORDER BY t.name',
    [threads[2].id])
  assert.deepEqual(on.map((t) => t.name), ['venue-rental', 'zoning'], 'no "zonin" typo tag was created')
})
