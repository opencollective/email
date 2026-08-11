import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Message, type Thread } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture(role = 'admin') {
  const slug = `comp${uniq()}`
  const collective = await createCollective(slug, 'Compose Test')
  const email = `sender-${uniq()}@example.org`
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, email, 'Xavier', role, 'every', now()])
  return { slug, collective, email, sid: await createSession(email) }
}

const post = (path: string, sid: string, body: Record<string, string>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams(body),
  })

const lastThread = async (collectiveId: number) =>
  (await get<Thread>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [collectiveId]))!

test('save as draft: a thread with a shareable URL, nothing sent, notes work', async () => {
  const fx = await fixture()
  const res = await post(`/inbox/${fx.slug}/compose`, fx.sid, {
    to: 'partner@example.org', cc: 'ally@example.org', bcc: 'archive@example.org',
    subject: 'Proposal for the autumn festival', body: 'First stab — thoughts?', action: 'draft',
  })
  assert.equal(res.status, 302)
  const t = await lastThread(fx.collective.id)
  assert.match(res.headers.get('location')!, new RegExp(`/thread/${t.id}`), 'redirects to the shareable thread URL')
  assert.equal(t.status, 'draft')

  const m = (await get<Message>('SELECT * FROM messages WHERE thread_id = ?', [t.id]))!
  assert.equal(m.sent_at, null, 'nothing sent')
  assert.deepEqual(JSON.parse(m.to_json!), ['partner@example.org'])
  assert.deepEqual(JSON.parse(m.bcc_json!), ['archive@example.org'])

  // the point of the URL: teammates collaborate with internal notes pre-send
  const note = await post(`/inbox/${fx.slug}/thread/${t.id}/note`, fx.sid, { body: 'add the venue cost before sending' })
  assert.match(decodeURIComponent(note.headers.get('location')!), /Note added/)

  // and the draft editor renders on the thread page
  const page = await (await app.request(`/inbox/${fx.slug}/thread/${t.id}`, { headers: { cookie: `requests_sid=${fx.sid}` } })).text()
  assert.match(page, /Edit draft/)
  assert.match(page, /nothing has been sent yet/i)
})

test('compose & send immediately: thread answered, message stamped', async () => {
  const fx = await fixture()
  const res = await post(`/inbox/${fx.slug}/compose`, fx.sid, {
    to: 'partner@example.org, second@example.org', subject: 'Hello from us', body: 'We exist!', action: 'send',
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Sent to partner@example.org/)
  const t = await lastThread(fx.collective.id)
  assert.equal(t.status, 'answered')
  assert.equal(t.counterpart_email, 'partner@example.org')
  const m = (await get<Message>('SELECT * FROM messages WHERE thread_id = ?', [t.id]))!
  assert.ok(m.sent_at, 'sent')
  assert.match(m.rfc822_message_id!, /^<req-/)
  assert.deepEqual(JSON.parse(m.to_json!), ['partner@example.org', 'second@example.org'])
})

test('editing then sending a draft updates recipients and subject', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: '', subject: 'Draft subject', body: 'v1', action: 'draft' })
  const t = await lastThread(fx.collective.id)

  // no recipients → send refuses, stays a draft
  const refused = await post(`/inbox/${fx.slug}/thread/${t.id}/draft`, fx.sid, { to: '', subject: 'Draft subject', body: 'v1', action: 'send' })
  assert.match(decodeURIComponent(refused.headers.get('location')!), /not sent/i)
  assert.equal((await lastThread(fx.collective.id)).status, 'draft')

  const sent = await post(`/inbox/${fx.slug}/thread/${t.id}/draft`, fx.sid, {
    to: 'final@example.org', subject: 'Final subject', body: 'v2 — reviewed by the team', action: 'send',
  })
  assert.match(decodeURIComponent(sent.headers.get('location')!), /Sent to final@example.org/)
  const fresh = await lastThread(fx.collective.id)
  assert.equal(fresh.status, 'answered')
  assert.equal(fresh.subject, 'Final subject')
  const m = (await get<Message>('SELECT * FROM messages WHERE thread_id = ?', [t.id]))!
  assert.equal(m.body_text!.startsWith('v2 — reviewed'), true)
  assert.ok(m.sent_at)
})

test('commenters cannot compose — sending is a paid-seat action', async () => {
  const fx = await fixture('commenter')
  const res = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: 'x@example.org', subject: 'nope', body: 'nope', action: 'send' })
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')!), /comment but not send/)
  assert.equal((await all('SELECT id FROM threads WHERE collective_id = ?', [fx.collective.id])).length, 0)
})

test('replies carry Bcc too, stored on the message', async () => {
  const fx = await fixture()
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Inbound q', 'needs_reply', 'asker@example.org', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'asker@example.org', '[]', 'question?', ?, ?)`, [t.lastId, `<q-${uniq()}@x>`, now(), now()])
  const res = await post(`/inbox/${fx.slug}/thread/${t.lastId}/reply`, fx.sid, {
    body: 'answer!', cc: 'ally@example.org', bcc: 'archive@example.org',
  })
  assert.equal(res.status, 302)
  const m = (await get<Message>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound'", [t.lastId]))!
  assert.deepEqual(JSON.parse(m.cc_json!), ['ally@example.org'])
  assert.deepEqual(JSON.parse(m.bcc_json!), ['archive@example.org'])
})

// ---------- recipient caps by plan ----------

test('a trial inbox cannot send one email to more than 3 people', async () => {
  const fx = await fixture() // fixture collectives are on trial
  const to = 'a@x.test, b@x.test'
  const cc = 'c@x.test, d@x.test'
  const res = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to, cc, bcc: '', subject: 'Blast', body: 'hi', action: 'send' })
  const loc = decodeURIComponent(res.headers.get('location')!)
  assert.match(loc, /at most 3 people/, 'refused with the cap in the message')
  assert.match(loc, /Saved as draft/, 'the work is kept, only the send is refused')
  const th = (await get<any>("SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1", [fx.collective.id]))!
  assert.equal(th.status, 'draft', 'still a draft')
  // 3 recipients is fine on trial
  const ok = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: 'a@x.test', cc: 'c@x.test', bcc: 'e@x.test', subject: 'Fine', body: 'hi', action: 'send' })
  assert.match(decodeURIComponent(ok.headers.get('location')!), /Sent to/)
})

test('paid plans send to 20, pro to 50 — and no further', async () => {
  const fx = await fixture()
  await run("UPDATE collectives SET stripe_status = 'active', plan = 'collective' WHERE id = ?", [fx.collective.id])
  const many = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@x.test`).join(', ')

  const ok20 = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: many(20), subject: 'Update', body: 'hi', action: 'send' })
  assert.match(decodeURIComponent(ok20.headers.get('location')!), /Sent to/)
  const no21 = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: many(21), subject: 'Update', body: 'hi', action: 'send' })
  assert.match(decodeURIComponent(no21.headers.get('location')!), /at most 20 people/)

  await run("UPDATE collectives SET plan = 'pro' WHERE id = ?", [fx.collective.id])
  const ok50 = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: many(50), subject: 'Update', body: 'hi', action: 'send' })
  assert.match(decodeURIComponent(ok50.headers.get('location')!), /Sent to/)
  const no51 = await post(`/inbox/${fx.slug}/compose`, fx.sid, { to: many(51), subject: 'Update', body: 'hi', action: 'send' })
  assert.match(decodeURIComponent(no51.headers.get('location')!), /at most 50 people/)
})

test('the reply cap counts the sender plus Cc and Bcc', async () => {
  const fx = await fixture()
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Hello', 'needs_reply', 'ruta@x.test', 'Ruta', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'ruta@x.test', 'Ruta', '[]', 'hello', ?, ?)`, [t.lastId, `<cap-${uniq()}@x>`, now(), now()])
  const threadId = t.lastId
  // trial: 1 (Ruta) + 3 Cc = 4 > 3
  const res = await post(`/inbox/${fx.slug}/thread/${threadId}/reply`, fx.sid,
    { body: 'hi all', cc: 'a@x.test, b@x.test, c@x.test', bcc: '' })
  assert.match(decodeURIComponent(res.headers.get('location')!), /at most 3 people/)
  assert.equal(await get("SELECT id FROM messages WHERE thread_id = ? AND direction = 'outbound'", [threadId]), undefined, 'nothing went out')
})
