import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Thread } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { createRule, ruleFor } from '../src/rules.js'
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
  await createRule(col, 'update@nws.eventplanner.test', 'newsletter', null)

  assert.ok(await ruleFor(col.id, 'update@nws.eventplanner.test'))
  assert.equal(await ruleFor(col.id, 'other@nws.eventplanner.test'), undefined, 'exact rule does not match siblings')

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
  await createRule(col, '@news.koro.test', 'newsletter', null)
  assert.ok(await ruleFor(col.id, 'anything@news.koro.test'))
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

  const { applied } = await createRule(col, 'marketing@news.koro.test', 'newsletter', null)
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
    body: 'from=%40news.example.com&tag=Newsletter Weekly',
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
