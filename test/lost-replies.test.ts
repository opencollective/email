import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { __observeAppMail } from '../src/appmail.js'
import { notificationMessageId, TOKEN_DAYS } from '../src/reply-tokens.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`
const sent: any[] = []
__observeAppMail((m) => sent.push(m))

const webhook = async (data: Record<string, unknown>) => {
  const res = await app.request('/webhooks/resend', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', data: { email_id: `t-${uniq()}`, ...data } }),
  })
  return res.json() as Promise<any>
}

/** Commons Hub-like: a booking request from Carole, Miriam a member. */
async function fixture() {
  const slug = `lr${uniq()}`
  const col = await createCollective(slug, 'Commons Hub')
  const miriam = `miriam-${uniq()}@hub.test`
  const m = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Miriam', 'member', 'every', ?)", [col.id, miriam, now()])
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Other', 'admin', 'every', ?)", [col.id, `o-${uniq()}@hub.test`, now()])
  const r = await webhook({ from: 'Carole <carole@gmail.test>', to: [`${slug}@collective.email`], subject: 'New Booking Request: Ostrom Room', text: 'Can I book the Ostrom room?' })
  assert.ok(r.ok)
  const msg = (await get<any>("SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ? ORDER BY m.id DESC LIMIT 1", [col.id]))!
  return { slug, col, miriam, memberId: m.lastId, threadId: msg.thread_id, msgId: msg.id }
}

const threadCount = async (colId: number) => Number((await get<any>('SELECT COUNT(*) n FROM threads WHERE collective_id = ?', [colId]))!.n)

test('notifications carry a signed Message-ID, and their names are quoted', async () => {
  sent.length = 0
  const fx = await fixture()
  const notif = sent.find((m) => m.to === fx.miriam)
  assert.ok(notif)
  assert.equal(notif.headers['Message-ID'], notificationMessageId('reply', fx.threadId, fx.msgId, fx.memberId))
  assert.match(notif.replyTo, /^"Carole via .+" <carole-gmail\.test-via-/)
  assert.ok(TOKEN_DAYS >= 90, 'reply addresses last for months, not two weeks')
})

test('a reply that came back to the inbox address (Reply-To ignored) still goes to Carole', async () => {
  const fx = await fixture()
  const before = await threadCount(fx.col.id)
  const r = await webhook({
    from: `Miriam <${fx.miriam}>`, to: [`${fx.slug}@collective.email`], subject: 'Re: New Booking Request: Ostrom Room',
    text: 'Bonjour Carole, the room is free.', headers: { 'in-reply-to': notificationMessageId('reply', fx.threadId, fx.msgId, fx.memberId) },
  })
  assert.equal(r.handled, 'member_reply')
  assert.equal(r.via, 'references')
  const out = (await get<any>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1", [fx.threadId]))!
  assert.equal(JSON.parse(out.to_json)[0], 'carole@gmail.test')
  assert.equal(out.sent_by_member_id, fx.memberId)
  assert.match(out.body_text, /the room is free/)
  assert.equal(await threadCount(fx.col.id), before, 'no stray thread')
})

test('the Message-ID is not a key anyone can use: wrong sender, forged signature, or an outsider already in To', async () => {
  const fx = await fixture()
  const id = notificationMessageId('reply', fx.threadId, fx.msgId, fx.memberId)
  // someone else
  let r = await webhook({ from: 'Eve <eve@evil.test>', to: [`${fx.slug}@collective.email`], subject: 'Re: x', text: 'send this', headers: { 'in-reply-to': id } })
  assert.notEqual(r.handled, 'member_reply')
  // forged signature
  r = await webhook({ from: `Miriam <${fx.miriam}>`, to: [`${fx.slug}@collective.email`], subject: 'Re: x', text: 'x', headers: { 'in-reply-to': id.replace(/\.[A-Za-z0-9_-]+@/, '.AAAAAAAAAAAAAAAA@') } })
  assert.notEqual(r.handled, 'member_reply')
  // Miriam wrote to Carole herself and copied the inbox: Carole has it already
  r = await webhook({ from: `Miriam <${fx.miriam}>`, to: ['carole@gmail.test'], cc: [`${fx.slug}@collective.email`], subject: 'Re: x', text: 'direct', headers: { 'in-reply-to': id } })
  assert.notEqual(r.handled, 'member_reply')
  const outs = Number((await get<any>("SELECT COUNT(*) n FROM messages WHERE thread_id = ? AND direction = 'outbound' AND resend_email_id IS NOT NULL", [fx.threadId]))!.n)
  assert.equal(outs, 0, 'nothing was sent on anyone\'s behalf')
})

test('a teammate reply that reached only the inbox is not "answered", and they are told at once', async () => {
  const fx = await fixture()
  sent.length = 0
  await webhook({
    from: `Miriam <${fx.miriam}>`, to: [`${fx.slug}@collective.email`], subject: 'Re: New Booking Request: Ostrom Room',
    text: 'Bonjour Carole, (old notification, no signature)', headers: { 'in-reply-to': '<0102abc-old@eu-west-1.amazonses.com>' },
  })
  const warn = sent.find((m) => m.to === fx.miriam && /Not sent/.test(m.subject))
  assert.ok(warn, 'Miriam is warned')
  assert.match(warn.text, /nobody outside received it/)
  assert.match(warn.text, /old notification, no signature/, 'with her text')
  const rows = await get<any>("SELECT COUNT(*) n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ? AND m.direction = 'outbound' AND m.from_email = ?", [fx.col.id, fx.miriam])
  assert.equal(Number(rows.n), 0, 'never filed as if it had been sent')
})
