import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import {
  all, createCollective, get, getThread, run, type Message, type Thread,
} from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, replyAddress } from '../src/util.js'
import { handleEmailReply } from '../src/ingest.js'

// ---------- helpers ----------

let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function webhook(data: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await app.request('/webhooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', data }),
  })
  return { status: res.status, body: await res.json() }
}

async function inboundEmail(slug: string, overrides: Record<string, unknown> = {}) {
  return webhook({
    email_id: `test-${uniq()}`,
    from: 'Marie Vandenberghe <marie@sender.test>',
    to: [`${slug}@collective.email`],
    subject: 'Booking the big room',
    message_id: `<in-${uniq()}@sender.test>`,
    text: 'Hi! Can we book the big room?',
    ...overrides,
  })
}

async function addMember(collectiveId: number, email: string, role = 'member'): Promise<number> {
  const r = await run(
    'INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, email, email.split('@')[0], role, 'every', now()])
  return r.lastId
}

const threadMessages = (threadId: number) =>
  all<Message>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id', [threadId])

const lastThread = async (collectiveId: number) =>
  (await get<Thread>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [collectiveId]))!

/** Minimal multipart raw email: HTML body + a jpeg attachment (Apple Mail shape). */
function rawHtmlWithImage(to: string, text: string): string {
  return [
    'From: Xavier <member@personal.test>',
    `To: ${to}`,
    'Subject: Re: [Test] Booking the big room',
    `Message-ID: <apple-${uniq()}@personal.test>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BB"',
    '',
    '--BB',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><body><div>${text}</div><br><blockquote type="cite">On 11 Jul 2026, notifications@collective.email wrote: quoted history here</blockquote></body></html>`,
    '--BB',
    'Content-Type: image/jpeg; name="pic.jpg"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline; filename="pic.jpg"',
    '',
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAM=',
    '--BB--',
    '',
  ].join('\r\n')
}

// ---------- inbound routing ----------

test('inbound email creates a thread with needs_reply', async () => {
  const col = await createCollective(`in-${seq}${Date.now() % 10000}`, 'Test Collective')
  await addMember(col.id, 'member@personal.test')
  const { status, body } = await inboundEmail(col.slug)
  assert.equal(status, 200)
  assert.equal(body.routed, 1)
  const thread = await lastThread(col.id)
  assert.equal(thread.status, 'needs_reply')
  assert.equal(thread.counterpart_email, 'marie@sender.test')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].body_text!, /book the big room/)
})

test('duplicate Message-ID is ingested once', async () => {
  const col = await createCollective(`dup-${Date.now() % 100000}`, 'Dup')
  const mid = `<dup-${uniq()}@sender.test>`
  await inboundEmail(col.slug, { message_id: mid })
  await inboundEmail(col.slug, { message_id: mid, email_id: `test-${uniq()}` })
  const thread = await lastThread(col.id)
  assert.equal((await threadMessages(thread.id)).length, 1)
})

test('follow-up with References lands on the same thread and reopens it', async () => {
  const col = await createCollective(`ref-${Date.now() % 100000}`, 'Ref')
  const mid = `<first-${uniq()}@sender.test>`
  await inboundEmail(col.slug, { message_id: mid })
  const thread = await lastThread(col.id)
  await run("UPDATE threads SET status = 'closed' WHERE id = ?", [thread.id])
  await inboundEmail(col.slug, {
    message_id: `<second-${uniq()}@sender.test>`,
    headers: { 'in-reply-to': mid },
    text: 'One more question!',
  })
  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'needs_reply', 'new inbound reopens the thread')
  assert.equal((await threadMessages(thread.id)).length, 2)
})

test('unknown slug routes nowhere; own-domain senders are loop-guarded', async () => {
  const none = await inboundEmail('does-not-exist-xyz')
  assert.equal(none.body.routed, 0)
  const col = await createCollective(`loop-${Date.now() % 100000}`, 'Loop')
  const loop = await inboundEmail(col.slug, { from: 'notifications@collective.email' })
  assert.equal(loop.body.routed, 1, 'webhook accepts it')
  assert.equal(await get('SELECT id FROM threads WHERE collective_id = ?', [col.id]), undefined, 'but nothing is ingested')
})

test('new thread is auto-assigned based on sender history', async () => {
  const col = await createCollective(`auto-${Date.now() % 100000}`, 'Auto')
  const memberId = await addMember(col.id, 'handler@personal.test')
  await inboundEmail(col.slug, { from: 'Repeat <repeat@sender.test>' })
  const first = await lastThread(col.id)
  await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [memberId, first.id])
  await inboundEmail(col.slug, {
    from: 'Repeat <repeat@sender.test>',
    subject: 'A brand new topic',
    message_id: `<new-${uniq()}@sender.test>`,
  })
  const second = await lastThread(col.id)
  assert.notEqual(second.id, first.id)
  assert.equal(second.assignee_member_id, memberId)
  const ev = await get<{ data_json: string }>(
    "SELECT data_json FROM events WHERE thread_id = ? AND type = 'assigned'", [second.id])
  assert.match(ev!.data_json, /auto_sender/)
})

// ---------- reply-by-email ----------

async function replySetup(prefix: string) {
  const col = await createCollective(`${prefix}-${Date.now() % 100000}`, 'Reply Col')
  const memberId = await addMember(col.id, 'member@personal.test')
  await inboundEmail(col.slug)
  const thread = await lastThread(col.id)
  const msg = (await threadMessages(thread.id))[0]
  return { col, memberId, thread, addr: replyAddress(col.slug, thread.id, memberId, msg.id) }
}

test('plain-text reply is sent to the sender, assigns the member, answers the thread', async () => {
  const { col, memberId, thread, addr } = await replySetup('r1')
  const { body } = await webhook({
    email_id: `test-${uniq()}`,
    from: 'member@personal.test',
    to: [addr],
    subject: 'Re: Booking',
    message_id: `<r1-${uniq()}@personal.test>`,
    text: 'Yes the room is free!\n\nOn 11 Jul, Marie wrote:\n> Can we book',
  })
  assert.equal(body.handled, 'member_reply')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.length, 2)
  const out = msgs[1]
  assert.equal(out.direction, 'outbound')
  assert.equal(out.from_email, `${col.slug}@collective.email`)
  assert.equal(out.sent_by_member_id, memberId)
  assert.match(out.body_text!, /^Yes the room is free!/)
  assert.ok(!out.body_text!.includes('Marie wrote'), 'quoted history stripped')
  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'answered')
  assert.equal(after.assignee_member_id, memberId)
})

test('HTML-only reply with image attachment is delivered (the Apple Mail regression)', async () => {
  const { col, memberId, thread, addr } = await replySetup('r2')
  const parsed = await simpleParser(rawHtmlWithImage(addr, 'Well received. Here is a picture.'))
  assert.equal(parsed.text?.trim() || '', '', 'fixture must be HTML-only')
  await handleEmailReply(parsed, { slug: col.slug, threadId: thread.id, memberId, msgId: (await threadMessages(thread.id))[0].id })
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.length, 2)
  assert.match(msgs[1].body_text!, /^Well received\. Here is a picture\./)
  const atts = await all<{ filename: string }>('SELECT filename FROM attachments WHERE message_id = ?', [msgs[1].id])
  assert.deepEqual(atts.map((a) => a.filename), ['pic.jpg'])
})

test('collision: a later reply to an already-answered notification is blocked', async () => {
  const { col, memberId, thread, addr } = await replySetup('r3')
  const otherId = await addMember(col.id, 'other@personal.test')
  await webhook({
    email_id: `test-${uniq()}`, from: 'other@personal.test',
    to: [replyAddress(col.slug, thread.id, otherId, (await threadMessages(thread.id))[0].id)],
    subject: 'Re:', message_id: `<r3a-${uniq()}@t>`, text: 'I got this one!',
  })
  // the original inbound is now older than the outbound answer
  await run("UPDATE messages SET sent_at = sent_at - 60 WHERE thread_id = ? AND direction = 'inbound'", [thread.id])
  const { body } = await webhook({
    email_id: `test-${uniq()}`, from: 'member@personal.test',
    to: [addr], subject: 'Re:', message_id: `<r3b-${uniq()}@t>`, text: 'My late answer',
  })
  assert.equal(body.handled, 'member_reply')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 1, 'second reply NOT sent')
  const blocked = await get("SELECT id FROM events WHERE thread_id = ? AND type = 'reply_blocked'", [thread.id])
  assert.ok(blocked, 'reply_blocked event recorded')
})

test('webhook retries with the same Message-ID never double-send', async () => {
  const { thread, addr } = await replySetup('r4')
  const payload = {
    email_id: `test-${uniq()}`, from: 'member@personal.test',
    to: [addr], subject: 'Re:', message_id: `<r4-${uniq()}@t>`, text: 'Once only please',
  }
  await webhook(payload)
  await webhook(payload)
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 1)
})

test('empty reply (no text, no attachments) is not sent and does not crash', async () => {
  const { thread, addr } = await replySetup('r5')
  const { body } = await webhook({
    email_id: `test-${uniq()}`, from: 'member@personal.test',
    to: [addr], subject: 'Re:', message_id: `<r5-${uniq()}@t>`, text: '',
  })
  assert.equal(body.handled, 'member_reply')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 0)
})

// ---------- HTTP surface ----------

test('tenant URLs accept the full address form and reject foreign domains', async () => {
  const col = await createCollective(`url-${Date.now() % 100000}`, 'Url')
  await addMember(col.id, 'urluser@personal.test')
  const sid = await createSession('urluser@personal.test')
  const get2 = (path: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal((await get2(`/inbox/${col.slug}`)).status, 200)
  assert.equal((await get2(`/inbox/${col.slug}@collective.email`)).status, 200)
  assert.equal((await get2(`/inbox/${col.slug}@gmail.com`)).status, 404)
})

test('signed-out tenant links redirect through login with next=', async () => {
  const res = await app.request('/inbox/whatever/thread/1')
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location')!, /\/login\?next=%2Finbox%2Fwhatever%2Fthread%2F1/)
})

test('legacy /c/ URLs redirect to the new scheme', async () => {
  const res = await app.request('/c/commonshub/thread/9')
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), '/inbox/commonshub/thread/9')
})

test('homepage shows EUR for EU visitors and USD otherwise', async () => {
  const eu = await (await app.request('/', { headers: { 'x-vercel-ip-country': 'BE' } })).text()
  assert.match(eu, /€25/)
  const us = await (await app.request('/', { headers: { 'x-vercel-ip-country': 'US' } })).text()
  assert.match(us, /\$25/)
})

test('wrong-account access shows the explicit 403 page, not a silent bounce', async () => {
  const col = await createCollective(`wr-${Date.now() % 100000}`, 'Wrong')
  await addMember(col.id, 'insider@personal.test')
  const outsider = await createSession('outsider@personal.test')
  const res = await app.request(`/inbox/${col.slug}`, { headers: { cookie: `requests_sid=${outsider}` } })
  assert.equal(res.status, 403)
  assert.match(await res.text(), /Wrong account/)
})
