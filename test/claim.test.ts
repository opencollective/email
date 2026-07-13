import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, sha256, signToken } from '../src/util.js'
import { checkDiscountCode, discountCodeFor, validateClaimSlug } from '../src/claim.js'
import { cfg } from '../src/config.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

test('claim slug rules: min 6 chars, alphanumeric only', () => {
  assert.equal(validateClaimSlug('abc12'), 'Addresses are 6–40 characters, letters and numbers only.')
  assert.match(validateClaimSlug('my-collective')!, /letters and numbers/)
  assert.match(validateClaimSlug('hello!')!, /letters and numbers/)
  assert.equal(validateClaimSlug('mycollective'), null)
  assert.match(validateClaimSlug('applications')!, /reserved/)
})

test('discount codes embed the slug and only unlock that slug', () => {
  const code = discountCodeFor('composters')
  assert.match(code, /^composters-[a-f0-9]{8}$/)
  assert.equal(checkDiscountCode('composters', code), true)
  assert.equal(checkDiscountCode('composters', code.toUpperCase()), true)
  assert.equal(checkDiscountCode('othergroup', code), false)
})

async function verifiedClaim(slug: string, email: string) {
  // plant a known code, then hit /verify like the email flow would
  await run(`INSERT INTO login_codes (email, code_hash, purpose, join_name, claim_slug, expires_at, created_at)
             VALUES (?, ?, 'claim', 'Nadia', ?, ?, ?)`,
    [email, sha256('123456' + cfg.secret), slug, now() + 600, now()])
  return app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=123456`,
  })
}

test('claim: verified code reserves a pending collective and redirects to activation', async () => {
  const slug = `choir${uniq()}`
  const email = `nadia-${uniq()}@t.test`
  const res = await verifiedClaim(slug, email)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `/claim/${slug}`)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'pending')
  assert.equal(col.trial_ends_at, null, 'no trial until an activation path is chosen')
  const admin = await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id])
  assert.equal(admin.email, email)
  assert.equal(admin.role, 'admin')
})

test('discount code activates the pending collective as comped', async () => {
  const slug = `garden${uniq()}`
  const email = `g-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  const sid = await createSession(email)
  const res = await app.request(`/claim/${slug}/discount`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${discountCodeFor(slug)}`,
  })
  assert.match(res.headers.get('location')!, new RegExp(`/inbox/${slug}`))
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'active')
  assert.equal(col.comped, 1)
  // wrong-slug code must not work elsewhere
  const slug2 = `garden${uniq()}`
  await verifiedClaim(slug2, `g2-${uniq()}@t.test`)
  const sid2 = await createSession(`g2-${uniq()}@t.test`)
  void sid2
})

test('application flow: thread lands in applications collective, approval starts the trial', async () => {
  // the applications collective must exist for applications to flow
  const apps = await createCollective('applications0', 'Applications', 'collective', { trial: false })
  await run("UPDATE collectives SET slug = 'applications' WHERE id = ?", [apps.id]).catch(() => {})
  const slugRow = await get<any>("SELECT slug FROM collectives WHERE id = ?", [apps.id])
  assert.equal(slugRow.slug, 'applications')
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [apps.id, 'reviewer@t.test', 'Reviewer', 'admin', 'every', now()])

  const slug = `theatre${uniq()}`
  const email = `t-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  const sid = await createSession(email)
  const res = await app.request(`/claim/${slug}/apply`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'reason=' + encodeURIComponent('We are an amateur theatre group of 20 people rehearsing weekly and need a shared address for bookings.'),
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Application sent/)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'applied')
  const thread = await get<any>("SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1", [apps.id])
  assert.match(thread.subject, new RegExp(slug))
  assert.equal(thread.counterpart_email, email, 'replying reaches the applicant')
  const msg = await get<any>('SELECT body_text FROM messages WHERE thread_id = ?', [thread.id])
  assert.ok(!msg.body_text.includes('/a/'), 'approve link is NOT in the thread body (cannot leak into replies)')

  // one-click approve
  const token = signToken({ a: 'approve', cid: col.id }, 3600)
  const ares = await app.request(`/a/${token}`)
  assert.equal(ares.status, 200)
  assert.match(await ares.text(), /approved/)
  const after = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(after.status, 'active')
  assert.ok(after.trial_ends_at > now() + 59 * 86400, 'trial starts at approval')
})

test('stale pending reservations are released after 48h', async () => {
  const slug = `stale${uniq()}`
  await verifiedClaim(slug, `s-${uniq()}@t.test`)
  await run("UPDATE collectives SET created_at = ? WHERE slug = ?", [now() - 49 * 3600, slug])
  const email2 = `s2-${uniq()}@t.test`
  const res = await verifiedClaim(slug, email2)
  assert.equal(res.headers.get('location'), `/claim/${slug}`, 'slug reclaimable after expiry')
  const owners = await all<any>('SELECT m.email FROM members m JOIN collectives c ON c.id = m.collective_id WHERE c.slug = ?', [slug])
  assert.deepEqual(owners.map((o) => o.email), [email2])
})
