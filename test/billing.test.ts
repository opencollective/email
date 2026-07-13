import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { billingState, canReceive, canSend, GRACE_DAYS } from '../src/billing.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function member(collectiveId: number, email: string, role: string) {
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, email, email.split('@')[0], role, 'every', now()])
  return createSession(email)
}

async function seedThread(collectiveId: number) {
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Test', 'needs_reply', 'sender@x.test', ?, ?, 'inbound', ?, ?)`, [collectiveId, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'sender@x.test', '[]', 'hello', ?, ?)`, [t.lastId, `<b-${uniq()}@x>`, now(), now()])
  return t.lastId
}

test('billingState covers the whole lifecycle', async () => {
  const n = now()
  assert.equal(billingState({ stripe_status: 'active', trial_ends_at: n - 999999, comped: 0 }), 'subscribed')
  assert.equal(billingState({ stripe_status: null, trial_ends_at: null, comped: 0 }), 'comped', 'legacy collectives are grandfathered')
  assert.equal(billingState({ stripe_status: null, trial_ends_at: null, comped: 1 }), 'comped')
  assert.equal(billingState({ stripe_status: null, trial_ends_at: n + 86400, comped: 0 }), 'trial')
  assert.equal(billingState({ stripe_status: null, trial_ends_at: n - 86400, comped: 0 }), 'grace')
  assert.equal(billingState({ stripe_status: null, trial_ends_at: n - (GRACE_DAYS + 1) * 86400, comped: 0 }), 'expired')
  assert.equal(billingState({ stripe_status: 'canceled', trial_ends_at: n - (GRACE_DAYS + 1) * 86400, comped: 0 }), 'expired')
  assert.equal(canSend('trial'), true)
  assert.equal(canSend('grace'), false)
  assert.equal(canReceive('grace'), true)
  assert.equal(canReceive('expired'), false)
})

test('new collectives start a 60-day trial', async () => {
  const col = await createCollective(`trial-${uniq()}`, 'Trial')
  assert.ok(col.trial_ends_at! > now() + 59 * 86400)
  assert.equal(billingState(col), 'trial')
})

test('grace: replies are blocked with a clear message, reading still works', async () => {
  const col = await createCollective(`grace-${uniq()}`, 'Grace Co')
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 86400, col.id])
  const sid = await member(col.id, `admin-${uniq()}@t.test`, 'admin')
  const threadId = await seedThread(col.id)
  const read = await app.request(`/inbox/${col.slug}/thread/${threadId}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(read.status, 200, 'reading still works in grace')
  assert.match(await read.text(), /read-only/, 'banner explains the state')
  const res = await app.request(`/inbox/${col.slug}/thread/${threadId}/reply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=Trying to reply',
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /read-only|trial.*ended/i)
  const outbound = await all("SELECT id FROM messages WHERE thread_id = ? AND direction = 'outbound'", [threadId])
  assert.equal(outbound.length, 0)
})

test('expired: the address stops receiving', async () => {
  const col = await createCollective(`exp-${uniq()}`, 'Expired Co')
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - (GRACE_DAYS + 5) * 86400, col.id])
  const res = await app.request('/webhooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', data: {
      email_id: `x-${uniq()}`, from: 'a@b.test', to: [`${col.slug}@collective.email`],
      subject: 'hi', message_id: `<x-${uniq()}@b>`, text: 'hello',
    } }),
  })
  assert.equal((await res.json() as any).routed, 0)
  assert.equal(await get('SELECT id FROM threads WHERE collective_id = ?', [col.id]), undefined)
})

test('subscribing (webhook) reactivates a lapsed collective', async () => {
  const col = await createCollective(`react-${uniq()}`, 'React Co')
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 86400, col.id])
  await run("UPDATE collectives SET stripe_status = 'active' WHERE id = ?", [col.id])
  const fresh = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(billingState(fresh), 'subscribed')
  assert.equal(canSend(billingState(fresh)), true)
})

test('readers can view but not act; join flow creates readers', async () => {
  const col = await createCollective(`rdr-${uniq()}`, 'Reader Co')
  const readerSid = await member(col.id, `reader-${uniq()}@t.test`, 'reader')
  const threadId = await seedThread(col.id)
  const view = await app.request(`/inbox/${col.slug}/thread/${threadId}`, { headers: { cookie: `requests_sid=${readerSid}` } })
  assert.equal(view.status, 200)
  const html = await view.text()
  assert.match(html, /read access/, 'reader notice shown')
  assert.ok(!html.includes('id="composer"'), 'composer hidden for readers')
  const res = await app.request(`/inbox/${col.slug}/thread/${threadId}/reply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${readerSid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=Sneaky reply',
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /can comment but not send/)
  assert.equal((await all("SELECT id FROM messages WHERE thread_id = ? AND direction='outbound'", [threadId])).length, 0)
})

test('contributor seat limit blocks promotion beyond the plan', async () => {
  const col = await createCollective(`cap-${uniq()}`, 'Cap Co') // plan 'collective' → 10 contributors
  const adminSid = await member(col.id, `boss-${uniq()}@t.test`, 'admin')
  for (let i = 0; i < 9; i++) await member(col.id, `c${i}-${uniq()}@t.test`, 'member') // 10 contributors total
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, `r-${uniq()}@t.test`, 'r', 'reader', 'daily', now()])
  const reader = (await get<any>("SELECT id FROM members WHERE collective_id = ? AND role = 'reader'", [col.id]))!
  const res = await app.request(`/inbox/${col.slug}/members/${reader.id}/role`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${adminSid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'role=member',
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Sending-seat limit reached/)
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [reader.id]))!.role, 'reader')
})

// ---------- one-click email actions ----------

test('one-click assign works on unassigned threads and lands at the thread bottom', async () => {
  const { signToken } = await import('../src/util.js')
  const col = await createCollective(`oc-${uniq()}`, 'OneClick')
  const sid = await member(col.id, `oc-a-${uniq()}@t.test`, 'admin')
  const me = (await get<any>('SELECT id FROM members WHERE collective_id = ?', [col.id]))!
  const threadId = await seedThread(col.id)
  const token = signToken({ a: 'assign', th: threadId, tg: me.id, by: me.id, r: 0 }, 3600)
  const res = await app.request(`/a/${token}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location')!, /act=assigned&pane=note#act/)
  assert.equal((await get<any>('SELECT assignee_member_id FROM threads WHERE id = ?', [threadId]))!.assignee_member_id, me.id)
})

test('one-click assign never overrides an existing assignment (kept)', async () => {
  const { signToken } = await import('../src/util.js')
  const col = await createCollective(`kept-${uniq()}`, 'Kept')
  const sid = await member(col.id, `kept-a-${uniq()}@t.test`, 'admin')
  const first = (await get<any>('SELECT id FROM members WHERE collective_id = ?', [col.id]))!
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, `kept-b-${uniq()}@t.test`, 'other', 'member', 'every', now()])
  const other = (await get<any>("SELECT id FROM members WHERE collective_id = ? AND role = 'member'", [col.id]))!
  const threadId = await seedThread(col.id)
  await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [other.id, threadId])
  await run("INSERT INTO events (thread_id, actor_member_id, type, data_json, created_at) VALUES (?, ?, 'assigned', ?, ?)",
    [threadId, other.id, JSON.stringify({ to: other.id, reason: 'claim' }), now() - 300])
  const token = signToken({ a: 'assign', th: threadId, tg: first.id, by: first.id, r: 0 }, 3600)
  const res = await app.request(`/a/${token}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(res.headers.get('location')!, /act=kept/)
  assert.equal((await get<any>('SELECT assignee_member_id FROM threads WHERE id = ?', [threadId]))!.assignee_member_id, other.id, 'assignment unchanged')
  const page = await app.request(res.headers.get('location')!.replace('#act', ''), { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(await page.text(), /already assigned this to/)
})

test('one-click spam marks the thread as spam', async () => {
  const { signToken } = await import('../src/util.js')
  const col = await createCollective(`spam-${uniq()}`, 'Spam')
  const sid = await member(col.id, `spam-a-${uniq()}@t.test`, 'admin')
  const me = (await get<any>('SELECT id FROM members WHERE collective_id = ?', [col.id]))!
  const threadId = await seedThread(col.id)
  const token = signToken({ a: 'spam', th: threadId, by: me.id }, 3600)
  const res = await app.request(`/a/${token}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.match(res.headers.get('location')!, /act=spam/)
  assert.equal((await get<any>('SELECT status FROM threads WHERE id = ?', [threadId]))!.status, 'spam')
})

test('signed-out one-click executes then routes through login with next', async () => {
  const { signToken } = await import('../src/util.js')
  const col = await createCollective(`ocl-${uniq()}`, 'OneClickLogin')
  await member(col.id, `ocl-${uniq()}@t.test`, 'admin')
  const me = (await get<any>('SELECT id FROM members WHERE collective_id = ?', [col.id]))!
  const threadId = await seedThread(col.id)
  const token = signToken({ a: 'assign', th: threadId, tg: me.id, by: me.id, r: 0 }, 3600)
  const res = await app.request(`/a/${token}`)
  assert.match(res.headers.get('location')!, /\/login\?next=/)
  assert.equal((await get<any>('SELECT assignee_member_id FROM threads WHERE id = ?', [threadId]))!.assignee_member_id, me.id, 'action executed via token auth')
})

// ---------- commenter role ----------

test('commenters can note and assign but never send; free like readers', async () => {
  const col = await createCollective(`cmt-${uniq()}`, 'Commenter Co')
  const sid = await member(col.id, `cm-${uniq()}@t.test`, 'commenter')
  const threadId = await seedThread(col.id)

  const view = await app.request(`/inbox/${col.slug}/thread/${threadId}`, { headers: { cookie: `requests_sid=${sid}` } })
  const html = await view.text()
  assert.ok(html.includes('id="composer"'), 'commenters get the composer')
  assert.ok(!html.includes('data-pane="reply"'), 'but no reply pane')

  const note = await app.request(`/inbox/${col.slug}/thread/${threadId}/note`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=' + encodeURIComponent('Internal context from a commenter'),
  })
  assert.equal(note.status, 302)
  assert.match(decodeURIComponent(note.headers.get('location')!), /Note added/)
  assert.equal((await all('SELECT id FROM notes WHERE thread_id = ?', [threadId])).length, 1, 'note stored')

  const reply = await app.request(`/inbox/${col.slug}/thread/${threadId}/reply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=Trying to email out',
  })
  assert.match(decodeURIComponent(reply.headers.get('location')!), /can comment but not send/)
  assert.equal((await all("SELECT id FROM messages WHERE thread_id = ? AND direction='outbound'", [threadId])).length, 0)
})

test('invite links carry a role; joiners get it (member falls back when seats are full)', async () => {
  const { sha256 } = await import('../src/util.js')
  const { cfg } = await import('../src/config.js')
  const col = await createCollective(`inv-${uniq()}`, 'Invite Co')
  const adminSid = await member(col.id, `ia-${uniq()}@t.test`, 'admin')

  const create = await app.request(`/inbox/${col.slug}/members/invite`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${adminSid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'role=commenter',
  })
  assert.equal(create.status, 302)
  const invite = (await get<any>('SELECT * FROM invites WHERE collective_id = ? AND revoked_at IS NULL', [col.id]))!
  assert.equal(invite.role, 'commenter')

  const email = `joiner-${uniq()}@t.test`
  await run(`INSERT INTO login_codes (email, code_hash, purpose, invite_token, join_name, join_level, expires_at, created_at)
             VALUES (?, ?, 'join', ?, 'Jo', 'daily', ?, ?)`,
    [email, sha256('123456' + cfg.secret), invite.token, now() + 600, now()])
  await app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=123456`,
  })
  const joined = (await get<any>('SELECT role FROM members WHERE collective_id = ? AND email = ?', [col.id, email]))!
  assert.equal(joined.role, 'commenter')
})
