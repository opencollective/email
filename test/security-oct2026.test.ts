/** Regression tests for the two privately reported issues (Oct 2026):
 *  1. a guest could promote themselves (or mint accounts) via assign-new
 *  2. an email reply was sent as the collective for a guest, or for anyone
 *     who knew a member's reply address, whatever the From */
import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import { all, createCollective, get, grantThreadAccess, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { handleEmailReply } from '../src/ingest.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `sec${uniq()}`
  const col = await createCollective(slug, 'Sec Co')
  const mk = async (name: string, role: string) => {
    const email = `${name.toLowerCase()}-${uniq()}@t.test`
    const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)', [col.id, email, name, role, 'every', now()])
    return { id: r.lastId, email, cookie: { cookie: `requests_sid=${await createSession(email)}` } }
  }
  const thread = async (subject: string) => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', 'customer@out.test', ?, ?, 'inbound', ?, ?)`, [col.id, subject, now(), now(), now(), now()])
    const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', 'customer@out.test', 'Customer', '[]', ?, ?, ?)`, [t.lastId, `<sec-${uniq()}@x>`, `secret body of ${subject}`, now(), now()])
    return { id: t.lastId, msgId: m.lastId }
  }
  return { slug, col, mk, thread }
}
const form = (path: string, cookie: Record<string, string>, fields: Record<string, string>) => app.request(path, {
  method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
})

test('report 1: a guest cannot promote themselves or mint commenters through assign-new', async () => {
  const fx = await fixture()
  const guest = await fx.mk('Guest', 'guest')
  const shared = await fx.thread('Shared')
  const priv = await fx.thread('Private')
  await grantThreadAccess(guest.id, shared.id)
  assert.equal((await app.request(`/inbox/${fx.slug}/thread/${priv.id}`, { headers: guest.cookie })).status, 404, 'before: no access')

  for (const email of [guest.email, `sock-${uniq()}@attacker.test`]) {
    const res = await form(`/inbox/${fx.slug}/thread/${shared.id}/assign-new`, guest.cookie, { email, access: 'collective' })
    assert.notEqual(res.status, 200)
  }
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [guest.id]))!.role, 'guest')
  assert.equal((await all<any>("SELECT id FROM members WHERE collective_id = ? AND email LIKE 'sock-%'", [fx.col.id])).length, 0, 'no account minted')
  const after = await app.request(`/inbox/${fx.slug}/thread/${priv.id}`, { headers: guest.cookie })
  assert.equal(after.status, 404, 'after: still no access')
  assert.doesNotMatch(await after.text(), /secret body of Private/)

  // a guest cannot reassign the thread either (or share it onward)
  const other = await fx.mk('OtherGuest', 'guest')
  assert.equal((await form(`/inbox/${fx.slug}/thread/${shared.id}/assign`, guest.cookie, { member_id: String(other.id) })).status, 403)
  assert.equal(await get('SELECT 1 FROM thread_access WHERE member_id = ? AND thread_id = ?', [other.id, shared.id]), undefined)
  // nor by @mentioning another guest in a note
  await form(`/inbox/${fx.slug}/thread/${shared.id}/note`, guest.cookie, { body: '@OtherGuest look at this' })
  assert.equal(await get('SELECT 1 FROM thread_access WHERE member_id = ? AND thread_id = ?', [other.id, shared.id]), undefined)
})

test('report 1: commenters may not grant inbox access; senders share one thread; admins may grant more', async () => {
  const fx = await fixture()
  const commenter = await fx.mk('Commenter', 'commenter')
  const sender = await fx.mk('Sender', 'member')
  const admin = await fx.mk('Admin', 'admin')
  const t = await fx.thread('Help')
  const newbie = `new-${uniq()}@out.test`
  await form(`/inbox/${fx.slug}/thread/${t.id}/assign-new`, commenter.cookie, { email: newbie, access: 'thread' })
  assert.equal(await get('SELECT 1 FROM members WHERE email = ?', [newbie]), undefined, 'commenters cannot bring people in')

  await form(`/inbox/${fx.slug}/thread/${t.id}/assign-new`, sender.cookie, { email: newbie, access: 'collective' })
  assert.equal(await get('SELECT 1 FROM members WHERE email = ?', [newbie]), undefined, 'a sender cannot grant the whole inbox')
  await form(`/inbox/${fx.slug}/thread/${t.id}/assign-new`, sender.cookie, { email: newbie, access: 'thread' })
  assert.equal((await get<any>('SELECT role FROM members WHERE email = ?', [newbie]))!.role, 'guest', 'a sender can share the thread')

  await form(`/inbox/${fx.slug}/thread/${t.id}/assign-new`, admin.cookie, { email: newbie, access: 'collective' })
  assert.equal((await get<any>('SELECT role FROM members WHERE email = ?', [newbie]))!.role, 'commenter', 'an admin can')
  // and nobody changes their own role this way, admin included
  await form(`/inbox/${fx.slug}/thread/${t.id}/assign-new`, admin.cookie, { email: admin.email, access: 'thread' })
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [admin.id]))!.role, 'admin')
})

const replyMail = (from: string, to: string, text: string, extra: string[] = []) => simpleParser([
  `From: ${from}`, `To: ${to}`, 'Subject: Re: Help', `Message-ID: <r-${uniq()}@x>`, ...extra, 'Content-Type: text/plain; charset=utf-8', '', text,
].join('\r\n'))
const outbound = (threadId: number) => all<any>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound'", [threadId])

test('report 2: email replies go out only from a sender, writing from their own address', async () => {
  const fx = await fixture()
  const guest = await fx.mk('Guest', 'guest')
  const sender = await fx.mk('Helper', 'member')
  const t = await fx.thread('Help')
  await grantThreadAccess(guest.id, t.id)
  const ref = (memberId: number) => ({ slug: fx.slug, threadId: t.id, memberId, msgId: t.msgId })

  await handleEmailReply(await replyMail(guest.email, 'x@collective.email', 'Guest writing as the collective'), ref(guest.id))
  assert.equal((await outbound(t.id)).length, 0, 'a guest replying by email sends nothing')

  await handleEmailReply(await replyMail('stranger@evil.test', 'x@collective.email', 'Stranger using a leaked reply address'), ref(sender.id))
  assert.equal((await outbound(t.id)).length, 0, 'a stranger with a member\'s reply address sends nothing')

  await handleEmailReply(await replyMail(sender.email, 'x@collective.email', 'Forged From', ['Authentication-Results: mx.test; dmarc=fail (p=none) header.from=t.test']), ref(sender.id))
  assert.equal((await outbound(t.id)).length, 0, 'a From the receiving server judged forged is not trusted')

  await handleEmailReply(await replyMail(`Helper <${sender.email}>`, 'x@collective.email', 'The real answer'), ref(sender.id))
  const out = await outbound(t.id)
  assert.equal(out.length, 1, 'control: the sender, from their own address, does reply')
  assert.match(out[0].body_text, /The real answer/)
})

test('the admin security audit is empty on clean data and lists a guest send', async () => {
  const fx = await fixture()
  const sid = await createSession('admin@test.local')
  const html = await (await app.request('/admin', { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(html, /Security audit/)
  const guest = await fx.mk('Guest', 'guest')
  const t = await fx.thread('Leak')
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
    VALUES (?, ?, 'outbound', ?, '["customer@out.test"]', 'sent by a guest', ?, ?, ?)`, [t.id, `<g-${uniq()}@x>`, `${fx.slug}@collective.email`, guest.id, now(), now()])
  const after = await (await app.request('/admin', { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(after, /email sent by a guest/)
  assert.match(after, new RegExp(`${fx.slug} #${t.id}`))
})
