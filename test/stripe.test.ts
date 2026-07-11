import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// enable webhook signature verification for this test process (before app import)
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripetestsecret'

const { app } = await import('../src/app.js')
const { createCollective, get } = await import('../src/db.js')
const { verifyStripeSignature } = await import('../src/stripe.js')

function signedHeaders(body: string, secret = 'whsec_stripetestsecret', ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }
}

async function stripeWebhook(event: Record<string, unknown>, headers?: Record<string, string>) {
  const body = JSON.stringify(event)
  return app.request('/webhooks/stripe', { method: 'POST', headers: headers ?? signedHeaders(body), body })
}

test('verifyStripeSignature accepts valid and rejects tampered/stale signatures', () => {
  const body = '{"hello":"world"}'
  const ts = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', 'sec').update(`${ts}.${body}`).digest('hex')
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sig}`, 'sec'), true)
  assert.equal(verifyStripeSignature(body + ' ', `t=${ts},v1=${sig}`, 'sec'), false, 'body tamper')
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sig}`, 'other'), false, 'wrong secret')
  const old = ts - 3600
  const oldSig = crypto.createHmac('sha256', 'sec').update(`${old}.${body}`).digest('hex')
  assert.equal(verifyStripeSignature(body, `t=${old},v1=${oldSig}`, 'sec'), false, 'stale timestamp')
})

test('unsigned webhook calls are rejected', async () => {
  const res = await app.request('/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"x"}',
  })
  assert.equal(res.status, 401)
})

test('checkout.session.completed activates the subscription on the collective', async () => {
  const col = await createCollective(`stripe-${Date.now() % 100000}`, 'Stripe Test')
  const res = await stripeWebhook({
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_test123',
        subscription: 'sub_test123',
        currency: 'eur',
        metadata: { collective_id: String(col.id), plan: 'duo', cycle: 'yearly' },
      },
    },
  })
  assert.equal(res.status, 200)
  const after = await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id])
  assert.equal(after.stripe_customer_id, 'cus_test123')
  assert.equal(after.stripe_subscription_id, 'sub_test123')
  assert.equal(after.stripe_status, 'active')
  assert.equal(after.plan, 'duo')
  assert.equal(after.billing_cycle, 'yearly')
  assert.equal(after.billing_currency, 'eur')
})

test('subscription lifecycle updates and cancellation are tracked', async () => {
  const col = await createCollective(`slc-${Date.now() % 100000}`, 'Lifecycle')
  await stripeWebhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_l', subscription: 'sub_l', currency: 'usd', metadata: { collective_id: String(col.id), plan: 'collective', cycle: 'monthly' } } },
  })
  await stripeWebhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_l', status: 'past_due' } } })
  assert.equal((await get<any>('SELECT stripe_status FROM collectives WHERE id = ?', [col.id])).stripe_status, 'past_due')
  await stripeWebhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_l', status: 'canceled' } } })
  assert.equal((await get<any>('SELECT stripe_status FROM collectives WHERE id = ?', [col.id])).stripe_status, 'canceled')
})

test('checkout POST without a Stripe key fails gracefully with a flash', async () => {
  // STRIPE_SECRET_KEY is unset in tests: the route must not crash
  const col = await createCollective(`nokey-${Date.now() % 100000}`, 'NoKey')
  const { run } = await import('../src/db.js')
  const { createSession } = await import('../src/auth.js')
  const { now } = await import('../src/util.js')
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, 'billing-admin@test.local', 'ba', 'admin', 'every', now()])
  const sid = await createSession('billing-admin@test.local')
  const res = await app.request(`/inbox/${col.slug}/billing/checkout`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'plan=duo&cycle=monthly&currency=eur',
  })
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location')!, /billing\?m=Checkout\+failed|billing\?m=Checkout%20failed/)
})
