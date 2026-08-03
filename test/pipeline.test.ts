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
  assert.match(eu, /€10/)
  const us = await (await app.request('/', { headers: { 'x-vercel-ip-country': 'US' } })).text()
  assert.match(us, /\$10/)
})

test('wrong-account access shows the explicit 403 page, not a silent bounce', async () => {
  const col = await createCollective(`wr-${Date.now() % 100000}`, 'Wrong')
  await addMember(col.id, 'insider@personal.test')
  const outsider = await createSession('outsider@personal.test')
  const res = await app.request(`/inbox/${col.slug}`, { headers: { cookie: `requests_sid=${outsider}` } })
  assert.equal(res.status, 403)
  assert.match(await res.text(), /Wrong account/)
})

test('live assignment badge reflects current state at fetch time', async () => {
  const { ogApp, badgeState } = await import('../src/og.js')
  const { signToken, now } = await import('../src/util.js')
  const { createCollective, run, get, getThread } = await import('../src/db.js')
  const col = await createCollective(`badge${Date.now() % 100000}`, 'Badge Co')
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, 'bee@t.test', 'Bee', 'admin', 'every', now()])
  const member = (await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id]))!
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'B', 'needs_reply', 'x@y.test', ?, ?, 'inbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  const token = signToken({ a: 'aimg', th: Number(t.lastId) }, 3600)

  const res = await ogApp.request(`/aimg/${token}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', 'real PNG bytes')

  assert.match((await badgeState((await getThread(Number(t.lastId)))!)).line, /Nobody has this yet/)

  await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [member.id, t.lastId])
  await run("INSERT INTO events (thread_id, actor_member_id, type, created_at) VALUES (?, ?, 'assigned', ?)", [t.lastId, member.id, now()])
  assert.match((await badgeState((await getThread(Number(t.lastId)))!)).line, /Assigned to Bee/)

  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
    VALUES (?, '<b1@x>', 'outbound', 'a@b.c', '[]', 'done', ?, ?, ?)`, [t.lastId, member.id, now(), now()])
  await run("UPDATE threads SET last_direction = 'outbound', status = 'answered' WHERE id = ?", [t.lastId])
  assert.match((await badgeState((await getThread(Number(t.lastId)))!)).line, /Answered by Bee/)

  assert.equal((await ogApp.request('/aimg/garbage')).status, 404)
  const og = await ogApp.request('/og/home.png')
  assert.equal(og.status, 200)
  assert.equal(og.headers.get('content-type'), 'image/png')
  assert.equal((await ogApp.request('/og/nope.png')).status, 404)
})

test('the forwarding test email round-trips into the inbox; other own-domain mail stays looped out', async () => {
  const { ingestInbound } = await import('../src/ingest.js')
  const { simpleParser } = await import('mailparser')
  const { createCollective, all: allRows } = await import('../src/db.js')
  const { cfg } = await import('../src/config.js')
  const col = await createCollective(`fwd${Date.now() % 100000}`, 'Fwd Co')

  const mk = (subject: string) => simpleParser([
    `From: collective.email <notifications@${cfg.emailDomain}>`,
    `To: hello@fwd.test`,
    `Subject: ${subject}`,
    `Message-ID: <fw-${subject.length}-${Date.now()}@x>`,
    '', 'body',
  ].join('\r\n'))

  await ingestInbound(col, await mk('Forwarding test for hello@fwd.test ✓'))
  const threads = await allRows<any>('SELECT * FROM threads WHERE collective_id = ?', [col.id])
  assert.equal(threads.length, 1, 'the forwarding test lands as a thread')
  assert.equal(threads[0].status, 'answered', 'and does not scream needs-reply')

  await ingestInbound(col, await mk('Weekly digest'))
  assert.equal((await allRows<any>('SELECT * FROM threads WHERE collective_id = ?', [col.id])).length, 1, 'other own-domain mail is still dropped (loop guard)')
})

test('google-group forward: counterpart is the original author, not the group', async () => {
  const { ingestInbound, effectiveSender } = await import('../src/ingest.js')
  const col = await createCollective(`gg${Date.now() % 100000}`, 'Commons Hub')
  await run("UPDATE collectives SET plan = 'pro', custom_domain = 'commonshub.test', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [col.id])
  const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!

  // Google rewrites From to the group address (DMARC) and keeps the author in
  // Reply-To / X-Original-Sender.
  const parsed = await simpleParser([
    `From: 'Tidjane George' via Commons Hub <hello@commonshub.test>`,
    'Reply-To: Tidjane George <tidjane.george@unseen-group.test>',
    'X-Original-Sender: tidjane.george@unseen-group.test',
    'To: hello@commonshub.test',
    'Subject: Room hire',
    `Message-ID: <gg-${uniq()}@groups.test>`,
    '', 'Hi, can I hire the room?',
  ].join('\r\n'))
  await ingestInbound(pro, parsed)
  const thread = await lastThread(col.id)
  assert.equal(thread.counterpart_email, 'tidjane.george@unseen-group.test')
  assert.equal(thread.counterpart_name, 'Tidjane George')
  const [msg] = await threadMessages(thread.id)
  assert.equal(msg.from_email, 'tidjane.george@unseen-group.test', 'message records the author too')

  // a second author through the same group gets their own thread, not lumped in
  const parsed2 = await simpleParser([
    `From: 'Ada Q' via Commons Hub <hello@commonshub.test>`,
    'Reply-To: ada@elsewhere.test',
    'X-Original-Sender: ada@elsewhere.test',
    'To: hello@commonshub.test',
    'Subject: Room hire',
    `Message-ID: <gg-${uniq()}@groups.test>`,
    '', 'Me too please',
  ].join('\r\n'))
  await ingestInbound(pro, parsed2)
  const threads = await all<Thread>('SELECT * FROM threads WHERE collective_id = ?', [col.id])
  assert.equal(threads.length, 2, 'different authors are different counterparts')

  // ordinary direct mail is untouched: Reply-To alone must NOT override From
  const direct = await simpleParser([
    'From: Marie <marie@sender.test>',
    'Reply-To: other@sender.test',
    'To: hello@commonshub.test',
    'Subject: Direct',
    `Message-ID: <d-${uniq()}@sender.test>`,
    '', 'hi',
  ].join('\r\n'))
  assert.deepEqual(effectiveSender(direct, pro), { address: 'marie@sender.test', name: 'Marie' })

  // but an X-Original-Sender marker (list rewrite to an external group address) does
  const extGroup = await simpleParser([
    "From: 'Bo' via Some List <somelist@googlegroups.test>",
    'X-Original-Sender: bo@company.test',
    'To: hello@commonshub.test',
    'Subject: Via list',
    `Message-ID: <l-${uniq()}@googlegroups.test>`,
    '', 'hi',
  ].join('\r\n'))
  assert.equal(effectiveSender(extGroup, pro).address, 'bo@company.test')
})

test("a member's direct reply arriving through the group counts as the team's answer", async () => {
  const { ingestInbound } = await import('../src/ingest.js')
  const col = await createCollective(`ma${Date.now() % 100000}`, 'Member Answer Co')
  const memberId = await addMember(col.id, 'cedric@team.test')

  const inboundMsgId = `<c-${uniq()}@customer.test>`
  await ingestInbound(col, await simpleParser([
    'From: Ruta <ruta@customer.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Quotation',
    `Message-ID: ${inboundMsgId}`,
    '', 'Any updates?',
  ].join('\r\n')))
  const thread = await lastThread(col.id)
  assert.equal(thread.status, 'needs_reply')

  // Cédric replies from his own mailbox; the group forwards us the copy
  await ingestInbound(col, await simpleParser([
    'From: Cedric <cedric@team.test>',
    'To: ruta@customer.test',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: Quotation',
    `Message-ID: <r-${uniq()}@team.test>`,
    `In-Reply-To: ${inboundMsgId}`,
    `References: ${inboundMsgId}`,
    '', 'Fantastic news, quote attached.',
  ].join('\r\n')))

  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'answered', "a teammate's reply answers the thread")
  assert.equal(after.assignee_member_id, memberId, 'and claims it for them')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1].direction, 'outbound', 'recorded as the team side of the conversation')
  assert.equal(msgs[1].sent_by_member_id, memberId)

  // a member's genuine question to the collective is a NEW unanswered,
  // UNCLAIMED thread — a teammate must pick it up
  await ingestInbound(col, await simpleParser([
    'From: Cedric <cedric@team.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Who is following up on this?',
    `Message-ID: <n-${uniq()}@team.test>`,
    '', 'Anyone?',
  ].join('\r\n')))
  const fresh = await lastThread(col.id)
  assert.notEqual(fresh.id, thread.id)
  assert.equal(fresh.status, 'needs_reply')
  assert.equal((await threadMessages(fresh.id))[0].direction, 'inbound')
  assert.equal(fresh.assignee_member_id, null, 'a genuine member question waits for a teammate to claim it')
})

test("a member's reply to mail we never received: thread is WITH their recipient, already answered", async () => {
  const { ingestInbound } = await import('../src/ingest.js')
  const col = await createCollective(`loop${Date.now() % 100000}`, 'Loop Co')
  const memberId = await addMember(col.id, 'cedric@team.test')

  // Cedric follows up on a conversation that never passed through the
  // collective, cc'ing it to loop the team in
  await ingestInbound(col, await simpleParser([
    'From: Cedric <cedric@team.test>',
    'To: Emilie <e.marchand@aalz.test>',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: Demande d\'informations',
    `Message-ID: <f-${uniq()}@team.test>`,
    `In-Reply-To: <unknown-${uniq()}@mail.gmail.test>`,
    '', 'Bonjour Emilie! Je reviens vers toi.',
  ].join('\r\n')))
  const thread = await lastThread(col.id)
  assert.equal(thread.counterpart_email, 'e.marchand@aalz.test', 'the conversation is with the recipient, not the member')
  assert.equal(thread.counterpart_name, 'Emilie')
  assert.equal(thread.status, 'answered')
  assert.equal(thread.assignee_member_id, memberId)
  assert.equal((await threadMessages(thread.id))[0].direction, 'outbound')

  // …whereas a reply-to-unknown addressed only to teammates is an internal
  // thread from that member: inbound, claimed by its author
  await addMember(col.id, 'leen@team3.test')
  await ingestInbound(col, await simpleParser([
    'From: Cedric <cedric@team.test>',
    'To: leen@team3.test',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: internal check',
    `Message-ID: <h-${uniq()}@team.test>`,
    `In-Reply-To: <unknown3-${uniq()}@mail.gmail.test>`,
    '', 'Is this confirmed?',
  ].join('\r\n')))
  const internal = await lastThread(col.id)
  assert.notEqual(internal.id, thread.id)
  assert.equal(internal.counterpart_email, 'cedric@team.test')
  assert.equal(internal.status, 'needs_reply')
  assert.equal(internal.assignee_member_id, null, 'an internal question waits for a teammate to claim it')
  assert.equal((await threadMessages(internal.id))[0].direction, 'inbound')
})

test('an unrecognized address answering TO the counterpart files as an unlinked answer; admins decide', async () => {
  const { ingestInbound, teamSender } = await import('../src/ingest.js')
  const col = await createCollective(`unk${Date.now() % 100000}`, 'Unknown Co')
  const adminEmail = `boss-${uniq()}@t.test`
  const adminId = await addMember(col.id, adminEmail, 'admin')
  const cedricId = await addMember(col.id, 'cedric@team.test')

  const custMsgId = `<q-${uniq()}@customer.test>`
  await ingestInbound(col, await simpleParser([
    'From: Ruta <ruta@customer.test>',
    `To: ${col.slug}@collective.email`,
    'Subject: Quotation',
    `Message-ID: ${custMsgId}`,
    '', 'Price please?',
  ].join('\r\n')))
  const thread = await lastThread(col.id)

  // Cédric answers from his personal gmail — unknown to the system, but the
  // message is written TO the customer: it must not scream needs-reply
  await ingestInbound(col, await simpleParser([
    'From: Cedric <cedric.personal@gmail.test>',
    'To: ruta@customer.test',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: Quotation',
    `Message-ID: <p-${uniq()}@gmail.test>`,
    `In-Reply-To: ${custMsgId}`,
    '', 'Here is the quote.',
  ].join('\r\n')))
  let after = (await getThread(thread.id))!
  assert.equal(after.status, 'answered')
  let msgs = await threadMessages(thread.id)
  assert.equal(msgs[1].direction, 'outbound')
  assert.equal(msgs[1].sent_by_member_id, null, 'unattributed until an admin links the address')

  // the admin links the address to Cédric
  const sid = await createSession(adminEmail)
  const res = await app.request(`/inbox/${col.slug}/thread/${thread.id}/sender`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent('cedric.personal@gmail.test')}&act=link&member_id=${cedricId}`,
  })
  assert.equal(res.status, 302)
  msgs = await threadMessages(thread.id)
  assert.equal(msgs[1].sent_by_member_id, cedricId, 'attribution backfilled')
  assert.deepEqual((await teamSender(col, 'cedric.personal@gmail.test')).member?.id, cedricId, 'future mail from the alias is his')
  void adminId

  // …or marks a different unknown answerer as external: message flips back
  await ingestInbound(col, await simpleParser([
    'From: Consultant <consultant@vendor.test>',
    'To: ruta@customer.test',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: Quotation',
    `Message-ID: <v-${uniq()}@vendor.test>`,
    `In-Reply-To: ${custMsgId}`,
    '', 'I can also help with this.',
  ].join('\r\n')))
  const res2 = await app.request(`/inbox/${col.slug}/thread/${thread.id}/sender`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent('consultant@vendor.test')}&act=external`,
  })
  assert.equal(res2.status, 302)
  after = (await getThread(thread.id))!
  assert.equal(after.status, 'needs_reply', 'an external voice needing attention again')
  msgs = await threadMessages(thread.id)
  assert.equal(msgs[2].direction, 'inbound')

  // and the decision sticks: their next message ingests as plain inbound
  await ingestInbound(col, await simpleParser([
    'From: Consultant <consultant@vendor.test>',
    'To: ruta@customer.test',
    `Cc: ${col.slug}@collective.email`,
    'Subject: Re: Quotation',
    `Message-ID: <v2-${uniq()}@vendor.test>`,
    `In-Reply-To: ${custMsgId}`,
    '', 'Following up.',
  ].join('\r\n')))
  msgs = await threadMessages(thread.id)
  assert.equal(msgs[3].direction, 'inbound', 'remembered as external')
})

test('a custom-domain alias counts as the team even without an exact member record', async () => {
  const { ingestInbound } = await import('../src/ingest.js')
  const col = await createCollective(`alias${Date.now() % 100000}`, 'Alias Co')
  await run("UPDATE collectives SET plan = 'pro', custom_domain = 'aliasco.test', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [col.id])
  const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  // Inge's member record uses a DIFFERENT domain — she writes from the team domain
  const ingeId = await addMember(col.id, 'inge@elsewhere.test')

  const custMsgId = `<cust-${uniq()}@yahoo.test>`
  await ingestInbound(pro, await simpleParser([
    'From: Fatemah <fatemah@yahoo.test>',
    'To: hello@aliasco.test',
    'Subject: Booking',
    `Message-ID: ${custMsgId}`,
    '', 'Can I book a room?',
  ].join('\r\n')))
  const thread = await lastThread(col.id)

  await ingestInbound(pro, await simpleParser([
    'From: Inge <inge@aliasco.test>',
    'To: fatemah@yahoo.test',
    'Cc: hello@aliasco.test',
    'Subject: Re: Booking',
    `Message-ID: <i-${uniq()}@aliasco.test>`,
    `In-Reply-To: ${custMsgId}`,
    '', 'Of course, here are the details.',
  ].join('\r\n')))
  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'answered')
  assert.equal(after.assignee_member_id, ingeId, 'matched to her member record by local part')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs[1].direction, 'outbound')
  assert.equal(msgs[1].sent_by_member_id, ingeId)

  // mail from the collective's own receiving address stays a plain counterpart
  // (website tools send as it) — never "the team answering itself"
  await ingestInbound(pro, await simpleParser([
    'From: Website <hello@aliasco.test>',
    'To: hello@aliasco.test',
    'Subject: New Contact Form: Someone',
    `Message-ID: <w-${uniq()}@aliasco.test>`,
    '', 'Contact form contents',
  ].join('\r\n')))
  const site = await lastThread(col.id)
  assert.equal(site.status, 'needs_reply')
  assert.equal((await threadMessages(site.id))[0].direction, 'inbound')
})

test('composer: signature is in the body, Cc sticks to the thread, no double sign-off', async () => {
  const { signatureFor } = await import('../src/outbound.js')
  const col = await createCollective(`cc${Date.now() % 100000}`, 'Cc Co')
  const email = `sender-${uniq()}@t.test`
  const memberId = await addMember(col.id, email)
  const sid = await createSession(email)
  await inboundEmail(col.slug)
  const thread = await lastThread(col.id)
  const member = (await get<any>('SELECT * FROM members WHERE id = ?', [memberId]))!
  const signature = signatureFor(col, member)

  // the composer pre-fills the sign-off so it can be seen and edited
  const page = await app.request(`/inbox/${col.slug}/thread/${thread.id}`, { headers: { cookie: `requests_sid=${sid}` } })
  const html = await page.text()
  assert.match(html, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'signature visible in the textarea')
  assert.match(html, /name="cc"/, 'an editable Cc field')

  // sending with the signature already in the body must not append a second one
  const res = await app.request(`/inbox/${col.slug}/thread/${thread.id}/reply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `body=${encodeURIComponent(`Here you go.\n\n${signature}`)}&cc=${encodeURIComponent('boss@x.test, boss@x.test, nope')}`,
  })
  assert.equal(res.status, 302)
  const sent = (await threadMessages(thread.id)).at(-1)!
  assert.equal(sent.direction, 'outbound')
  assert.equal(sent.body_text!.match(/for Cc Co/g)?.length, 1, 'signed exactly once')
  assert.deepEqual(JSON.parse(sent.cc_json || '[]'), ['boss@x.test'], 'deduped, invalid dropped')

  // …and the Cc is remembered on the thread, pre-filled next time
  const after = (await getThread(thread.id))!
  assert.deepEqual(JSON.parse(after.cc_json || '[]'), ['boss@x.test'])
  const page2 = await app.request(`/inbox/${col.slug}/thread/${thread.id}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(await page2.text(), /name="cc" value="boss@x\.test"/, 'Cc persists but stays editable')

  // clearing it removes everyone
  await app.request(`/inbox/${col.slug}/thread/${thread.id}/reply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=Second&cc=',
  })
  assert.deepEqual(JSON.parse((await getThread(thread.id))!.cc_json || '[]'), [], 'Cc can always be emptied')
})

test('any message can be forwarded, without marking the thread answered', async () => {
  const col = await createCollective(`fw${Date.now() % 100000}`, 'Fwd Co')
  const email = `fwd-${uniq()}@t.test`
  await addMember(col.id, email)
  const sid = await createSession(email)
  await inboundEmail(col.slug)
  const thread = await lastThread(col.id)
  const msg = (await threadMessages(thread.id))[0]

  const page = await app.request(`/inbox/${col.slug}/thread/${thread.id}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(await page.text(), /title="Forward"/, 'a forward affordance on the message itself')

  const res = await app.request(`/inbox/${col.slug}/thread/${thread.id}/forward`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `message_id=${msg.id}&to=${encodeURIComponent('colleague@partner.test')}&note=${encodeURIComponent('Can you take this?')}`,
  })
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')!), /Forwarded to colleague@partner\.test/)
  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'needs_reply', 'forwarding is not answering')
  const ev = await all<any>("SELECT * FROM events WHERE thread_id = ? AND type = 'forwarded'", [thread.id])
  assert.equal(ev.length, 1)
  assert.equal(JSON.parse(ev[0].data_json).to, 'colleague@partner.test')

  // a bad address is refused with a readable message
  const bad = await app.request(`/inbox/${col.slug}/thread/${thread.id}/forward`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `message_id=${msg.id}&to=notanemail&note=`,
  })
  assert.match(decodeURIComponent(bad.headers.get('location')!), /doesn't look right/)
})

test("a teammate's reply lands on the customer's thread even when we never saw the quoted mail", async () => {
  const { ingestInbound } = await import('../src/ingest.js')
  const col = await createCollective(`thr${Date.now() % 100000}`, 'Thread Co')
  await run("UPDATE collectives SET plan = 'pro', custom_domain = 'thrco.test', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [col.id])
  const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  const miriam = await addMember(col.id, 'miriam@thrco.test')

  // the customer writes in
  await ingestInbound(pro, await simpleParser([
    'From: Thomas <thomas@customer.test>',
    'To: hello@thrco.test',
    'Subject: Venue Usage 24 Of October',
    `Message-ID: <cust-${uniq()}@customer.test>`,
    '', 'Can we use the venue?',
  ].join('\r\n')))
  const thread = await lastThread(col.id)

  // Miriam answers from her own mailbox, quoting the copy SHE received (a
  // Message-ID we never stored), cc'ing the collective
  await ingestInbound(pro, await simpleParser([
    'From: Miriam Dean <miriam@thrco.test>',
    'To: thomas@customer.test',
    'Cc: hello@thrco.test',
    'Subject: Re: Venue Usage 24 Of October',
    `Message-ID: <m-${uniq()}@thrco.test>`,
    `In-Reply-To: <0102019f-unknown-${uniq()}@eu-west-1.amazonses.com>`,
    '', 'Hello Thomas, we would be delighted to host you.',
  ].join('\r\n')))

  const threads = await all<Thread>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id', [col.id])
  assert.equal(threads.length, 1, 'no duplicate thread beside the customer conversation')
  const msgs = await threadMessages(thread.id)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1].direction, 'outbound')
  assert.equal(msgs[1].sent_by_member_id, miriam)
  const after = (await getThread(thread.id))!
  assert.equal(after.status, 'answered')
  assert.equal(after.counterpart_email, 'thomas@customer.test', 'still the customer, not the teammate')
})

test('notifications come "from" the person who wrote, on our own sending domain', async () => {
  const { __observeAppMail } = await import('../src/appmail.js')
  const col = await createCollective(`vf${Date.now() % 100000}`, 'Commons Hub')
  await addMember(col.id, `watcher-${uniq()}@t.test`)

  const sent: any[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await inboundEmail(col.slug, { from: 'Marie Vandenberghe <marie@sender.test>' })
    const notif = sent.find((m) => m.subject.includes('Booking'))
    assert.ok(notif, 'a notification went out')
    assert.equal(notif.from, `Marie Vandenberghe via ${col.slug}@collective.email <${col.slug}@collective.email>`)
    // the address must stay ours: we sign it, and the loop guard keys on it
    assert.ok(!notif.from.includes('<marie@sender.test>'), 'never sends AS the sender')
    assert.match(notif.replyTo, new RegExp(`^Marie Vandenberghe via ${col.slug}@collective\\.email <`), 'Reply-To reads like a person, routes to us')
    assert.match(notif.replyTo, new RegExp(`<marie-sender\\.test-via-${col.slug}\\+[a-z0-9]{10}@collective\\.email>$`), 'reads "to marie@sender.test via the collective"')

    // no display name on the sender → fall back to the address' local part
    sent.length = 0
    await inboundEmail(col.slug, {
      from: 'contact@agency.test',
      subject: 'No name here',
      message_id: `<nn-${uniq()}@agency.test>`,
    })
    const second = sent.find((m) => m.subject.includes('No name'))
    assert.equal(second.from, `contact via ${col.slug}@collective.email <${col.slug}@collective.email>`)

    // a name that would break the header is defanged, not passed through
    sent.length = 0
    await inboundEmail(col.slug, {
      from: '"Evil <boss@phish.test>" <real@agency.test>',
      subject: 'Header safety',
      message_id: `<hs-${uniq()}@agency.test>`,
    })
    const third = sent.find((m) => m.subject.includes('Header safety'))
    assert.ok(!third.from.includes('phish.test>'), 'no injected angle brackets')
    assert.match(third.from, new RegExp(`<${col.slug}@collective\\.email>$`), 'still our address')
    // a Pro collective shows the address people actually write to
    sent.length = 0
    await run("UPDATE collectives SET plan = 'pro', custom_domain = 'commonshub.brussels', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [col.id])
    const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
    const { ingestInbound } = await import('../src/ingest.js')
    await ingestInbound(pro, await simpleParser([
      'From: Marie Vandenberghe <marie@sender.test>',
      'To: hello@commonshub.brussels',
      'Subject: Custom domain notification',
      `Message-ID: <cd-${uniq()}@sender.test>`,
      '', 'hello',
    ].join('\r\n')))
    const custom = sent.find((m) => m.subject.includes('Custom domain'))
    assert.equal(custom.from, `Marie Vandenberghe via hello@commonshub.brussels <${col.slug}@collective.email>`)
  } finally {
    __observeAppMail(null)
  }
})

test('one-click mute: only that member stops hearing from the sender; inbox unaffected', async () => {
  const { __observeAppMail } = await import('../src/appmail.js')
  const { signToken } = await import('../src/util.js')
  const col = await createCollective(`mu${Date.now() % 100000}`, 'Mute Co')
  const aliceId = await addMember(col.id, `alice-${uniq()}@t.test`)
  const bobEmail = `bob-${uniq()}@t.test`
  await addMember(col.id, bobEmail)

  const sent: any[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    // the footer of a notification carries the one-click mute
    await inboundEmail(col.slug, { from: 'Noisy <noisy@vendor.test>' })
    const first = sent.find((m) => m.to.startsWith('alice'))
    assert.match(first.html, /Stop receiving emails from noisy@vendor\.test/)

    // Alice clicks it
    const token = signToken({ a: 'mute', c: col.id, m: aliceId, f: 'noisy@vendor.test' }, 3600)
    const res = await app.request(`/a/${token}`)
    assert.match(await res.text(), /won&#39;t get emails from noisy@vendor\.test/)

    // next email from that sender: Bob is notified, Alice is not,
    // and the message still lands in the shared inbox
    sent.length = 0
    await inboundEmail(col.slug, {
      from: 'Noisy <noisy@vendor.test>',
      subject: 'Another one',
      message_id: `<n2-${uniq()}@vendor.test>`,
    })
    assert.ok(sent.some((m) => m.to === bobEmail), 'Bob still notified')
    assert.ok(!sent.some((m) => m.to.startsWith('alice')), 'Alice muted')
    const thread = await lastThread(col.id)
    assert.equal(thread.subject, 'Another one', 'the collective still receives everything')

    // a different sender still reaches Alice
    sent.length = 0
    await inboundEmail(col.slug, {
      from: 'Fresh <fresh@elsewhere.test>',
      subject: 'Different sender',
      message_id: `<f-${uniq()}@elsewhere.test>`,
    })
    assert.ok(sent.some((m) => m.to.startsWith('alice')), 'mute is per-sender, not global')

    // unmute via the management page
    const sid = await createSession((await get<any>('SELECT email FROM members WHERE id = ?', [aliceId]))!.email)
    const page = await app.request(`/inbox/${col.slug}/notifications`, { headers: { cookie: `requests_sid=${sid}` } })
    const html = await page.text()
    assert.match(html, /Muted senders/)
    assert.match(html, /noisy@vendor\.test/)
    const muteId = (await get<any>('SELECT id FROM member_mutes WHERE member_id = ?', [aliceId]))!.id
    await app.request(`/inbox/${col.slug}/notifications/unmute`, {
      method: 'POST',
      headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `id=${muteId}`,
    })
    sent.length = 0
    await inboundEmail(col.slug, {
      from: 'Noisy <noisy@vendor.test>',
      subject: 'Back again',
      message_id: `<n3-${uniq()}@vendor.test>`,
    })
    assert.ok(sent.some((m) => m.to.startsWith('alice')), 'unmuted — notifications resume')
  } finally {
    __observeAppMail(null)
  }
})

test('notification header: From line, To line, small badge with a change link', async () => {
  const { __observeAppMail } = await import('../src/appmail.js')
  const col = await createCollective(`hd${Date.now() % 100000}`, 'Header Co')
  await addMember(col.id, `h-${uniq()}@t.test`)
  const sent: any[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await inboundEmail(col.slug, { from: 'Marie Vandenberghe <marie@sender.test>' })
    const html = sent[0].html as string
    assert.match(html, /From:<\/span> <b>Marie Vandenberghe<\/b> <span[^>]*>&lt;marie@sender\.test&gt;/)
    assert.match(html, new RegExp(`To: ${col.slug}@collective\\.email`))
    assert.match(html, /width="278" height="30"/, 'badge is ~30px tall')
    assert.match(html, /change →/)
    assert.match(html, /border-bottom:1px solid #e6e8eb/, 'a rule separates header from body')
    assert.doesNotMatch(html, />Header Co<\/span>/, 'no redundant collective/date bar')
  } finally {
    __observeAppMail(null)
  }
})

test('a one-member collective gets every new thread assigned automatically', async () => {
  const col = await createCollective(`solo${Date.now() % 100000}`, 'Solo Co')
  const onlyId = await addMember(col.id, `only-${uniq()}@t.test`)
  await inboundEmail(col.slug, { from: 'Someone <someone@x.test>' })
  const thread = await lastThread(col.id)
  assert.equal(thread.assignee_member_id, onlyId, 'no claiming ceremony when alone')
  const ev = await get<any>("SELECT data_json FROM events WHERE thread_id = ? AND type = 'assigned'", [thread.id])
  assert.match(ev!.data_json, /solo/)

  // two members → back to normal claiming
  const col2 = await createCollective(`duo${Date.now() % 100000}`, 'Duo Co')
  await addMember(col2.id, `a-${uniq()}@t.test`)
  await addMember(col2.id, `b-${uniq()}@t.test`)
  await inboundEmail(col2.slug, { from: 'Someone <someone2@x.test>' })
  assert.equal((await lastThread(col2.id)).assignee_member_id, null)
})

test('the friendly reply address round-trips: replying to it sends as the collective', async () => {
  const { __observeAppMail } = await import('../src/appmail.js')
  const col = await createCollective(`fr${Date.now() % 100000}`, 'Friendly Co')
  const memberId = await addMember(col.id, 'member@personal.test')
  const sent: any[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await inboundEmail(col.slug)
    const replyAddr = (sent[0].replyTo as string).match(/<([^>]+)>/)![1]
    assert.match(replyAddr, new RegExp(`^marie-sender\\.test-via-${col.slug}\\+[a-z0-9]{10}@collective\\.email$`))

    const thread = await lastThread(col.id)
    const { body } = await webhook({
      email_id: `test-${uniq()}`,
      from: 'member@personal.test',
      to: [replyAddr],
      subject: 'Re: Booking',
      message_id: `<fr-${uniq()}@personal.test>`,
      text: 'On our way!',
    })
    assert.equal(body.handled, 'member_reply')
    const msgs = await threadMessages(thread.id)
    assert.equal(msgs.at(-1)!.direction, 'outbound')
    assert.equal(msgs.at(-1)!.sent_by_member_id, memberId)

    // an expired token no longer sends as the collective — but the email
    // still lands in the shared inbox thanks to the -via-<slug> suffix
    await run('UPDATE reply_tokens SET expires_at = 1 WHERE slug = ?', [col.slug])
    const before = (await threadMessages(thread.id)).length
    const { body: expired } = await webhook({
      email_id: `test-${uniq()}`,
      from: 'member@personal.test',
      to: [replyAddr],
      subject: 'Re: Booking',
      message_id: `<fr2-${uniq()}@personal.test>`,
      text: 'Too late to send as the collective',
    })
    assert.notEqual(expired.handled, 'member_reply', 'expired reply token is not honored')
    assert.equal(expired.routed, 1, 'still routed to the collective inbox')
    void before
    const stored = await get<any>(
      "SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ? AND m.body_text LIKE '%Too late%'", [col.id])
    assert.ok(stored, 'the message is stored in the collective, not lost')
  } finally {
    __observeAppMail(null)
  }
})
