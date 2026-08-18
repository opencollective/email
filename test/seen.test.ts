import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { ogApp } from '../src/og.js'
import { all, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, signToken } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `seen${uniq()}`
  const collective = await createCollective(slug, 'Seen Test')
  const mk = async (name: string) => {
    const email = `${name.toLowerCase()}-${uniq()}@example.org`
    const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, email, name, 'admin', 'every', now()])
    return { id: r.lastId, email, sid: await createSession(email) }
  }
  const alice = await mk('Alice')
  const bob = await mk('Bob')
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
    first_message_at, last_message_at, last_direction, created_at, updated_at) VALUES (?, 'Big topic', 'needs_reply', 'out@x.test', 'Out', ?, ?, 'inbound', ?, ?)`,
    [collective.id, now() - 3600, now() - 3600, now() - 3600, now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'out@x.test', '[]', 'hello there', ?, ?)`, [t.lastId, `<s-${uniq()}@x>`, now() - 3600, now()])
  return { slug, collective, alice, bob, threadId: t.lastId }
}

const page = (path: string, sid: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })

test('opening a thread records seen; the inbox stops bolding it until news arrives', async () => {
  const fx = await fixture()

  // before anyone opens it: bold for both
  let inbox = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  assert.match(inbox, /class="row unread"/)

  await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)
  const read = (await get<any>('SELECT * FROM thread_reads WHERE thread_id = ? AND member_id = ?', [fx.threadId, fx.alice.id]))!
  assert.equal(read.via, 'web')

  inbox = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  assert.doesNotMatch(inbox, /class="row unread"/, 'seen — no longer bold for Alice')
  const bobInbox = await (await page(`/inbox/${fx.slug}`, fx.bob.sid)).text()
  assert.match(bobInbox, /class="row unread"/, 'still bold for Bob, who has not looked')

  // a new message arrives → bold again for Alice
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'out@x.test', '[]', 'one more thing', ?, ?)`, [fx.threadId, `<s2-${uniq()}@x>`, now() + 5, now()])
  await run('UPDATE threads SET last_message_at = ? WHERE id = ?', [now() + 5, fx.threadId])
  inbox = await (await page(`/inbox/${fx.slug}`, fx.alice.sid)).text()
  assert.match(inbox, /class="row unread"/, 'news re-bolds it')
})

test('the thread shows who has seen it: timeline marker and People sidebar', async () => {
  const fx = await fixture()
  await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)

  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.bob.sid)).text()
  assert.match(html, /class="seen-row"/, 'a WhatsApp-style marker under the last item read')
  assert.match(html, /seen by/, 'named')
  assert.match(html, /class="head-people"/, 'the header carries the people strips')
  assert.match(html, /class="hp-group"[^>]*>[\s\S]*?seen/, 'the seen cluster is labelled')
  assert.match(html, /class="side-log"/, 'the sidebar log exists')
  assert.match(html, /Received from out@x\.test/, 'log lists the inbound message')
  // Bob is viewing right now, so both members have read rows — the log keeps them
  assert.equal((await all('SELECT member_id FROM thread_reads WHERE thread_id = ?', [fx.threadId])).length, 2)
})

test('loading the notification badge counts as an email open', async () => {
  const fx = await fixture()
  const token = signToken({ a: 'aimg', th: fx.threadId, m: fx.bob.id }, 3600)
  const res = await ogApp.request(`/aimg/${token}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const read = (await get<any>('SELECT * FROM thread_reads WHERE thread_id = ? AND member_id = ?', [fx.threadId, fx.bob.id]))!
  assert.equal(read.via, 'email', 'the badge load is the read receipt')

  // legacy tokens without a member still render, tracking nothing
  const legacy = signToken({ a: 'aimg', th: fx.threadId }, 3600)
  assert.equal((await ogApp.request(`/aimg/${legacy}`)).status, 200)
  // and a member from another collective cannot be marked onto this thread
  const other = await createCollective(`other${uniq()}`, 'Other')
  const stranger = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [other.id, `x-${uniq()}@t.test`, 'X', 'admin', 'every', now()])
  await ogApp.request(`/aimg/${signToken({ a: 'aimg', th: fx.threadId, m: stranger.lastId }, 3600)}`)
  assert.equal(await get('SELECT * FROM thread_reads WHERE thread_id = ? AND member_id = ?', [fx.threadId, stranger.lastId]), undefined)
})

test('the thread sidebar lists other threads with the sender, and the name carries the count', async () => {
  const fx = await fixture()
  // a second thread with the same counterpart
  const t2 = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
    first_message_at, last_message_at, last_direction, created_at, updated_at) VALUES (?, 'Older topic', 'answered', 'out@x.test', 'Out', ?, ?, 'inbound', ?, ?)`,
    [fx.collective.id, now() - 90000, now() - 90000, now() - 90000, now()])
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.alice.sid)).text()
  assert.match(html, /More by this sender/, 'the sidebar block exists')
  assert.match(html, new RegExp(`/thread/${t2.lastId}`), 'and links the other thread')
  // the count lives in the sender card now, not in a chip next to the name
  assert.doesNotMatch(html, /class="chip other-chip"/, 'no chip in the message head')
  assert.match(html, /class="pc-link"[^>]*>1 other thread/, 'the sender card carries the count')
})

test('compose: the quiet combined line, Apple Mail style', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/compose`, fx.alice.sid)).text()
  assert.match(html, /Cc\/Bcc, From: /, 'one gentle line')
  assert.match(html, /class="ccb"/)
  assert.match(html, /c-static/, 'From shown read-only when expanded')
})
