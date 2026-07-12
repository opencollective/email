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
  assert.match(decodeURIComponent(res.headers.get('location')!), /read access/)
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
  assert.match(decodeURIComponent(res.headers.get('location')!), /Contributor limit reached/)
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [reader.id]))!.role, 'reader')
})
