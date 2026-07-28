import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Thread } from '../src/db.js'
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
  assert.match(html, /create a rule for similar messages/)
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
