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
  for (const reserved of ['support', 'newsletter', 'contactus', 'donations', 'security', 'moderation']) {
    assert.ok(validateClaimSlug(reserved), `${reserved} must be reserved`)
  }
})

test('claiming a reserved role name is rejected with a clear message', async () => {
  const res = await app.request('/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'address=newsletter&name=X&email=x@y.test',
  })
  assert.match(await res.text(), /reserved/)
})

test('verify re-checks availability: slug taken after the code was sent', async () => {
  const slug = `race${uniq()}x`
  await createCollective(slug, 'Winner') // someone else got it first (active)
  const res = await verifiedClaim(slug, `loser-${uniq()}@t.test`)
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')!), /already taken/)
})

test('discount codes embed the slug and only unlock that slug', () => {
  const forever = discountCodeFor('composters')
  assert.match(forever, /^composters-[a-f0-9]{8}$/)
  assert.equal(checkDiscountCode('composters', forever), 'forever')
  assert.equal(checkDiscountCode('composters', forever.toUpperCase()), 'forever')
  assert.equal(checkDiscountCode('othergroup', forever), null)
  const trial6 = discountCodeFor('composters', 6)
  assert.match(trial6, /^composters-6m-[a-f0-9]{8}$/)
  assert.equal(checkDiscountCode('composters', trial6), 6)
  assert.equal(checkDiscountCode('composters', trial6.replace('-6m-', '-9m-')), null, 'months are signed')
  assert.equal(checkDiscountCode('othergroup', trial6), null)
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

test('months-bound discount code grants a trial of that length', async () => {
  const slug = `farm${uniq()}xx`
  const email = `f-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  const sid = await createSession(email)
  const res = await app.request(`/claim/${slug}/discount`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${discountCodeFor(slug, 3)}`,
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /3 months free/)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'active')
  assert.equal(col.comped, 0)
  assert.ok(col.trial_ends_at > now() + 89 * 86400 && col.trial_ends_at < now() + 91 * 86400)
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
    body: 'months=6&contribution=' + encodeURIComponent('We will onboard two other theatre groups in Brussels and write a blog post about how we run our shared inbox.'),
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Application sent/)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'applied')
  const thread = await get<any>("SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1", [apps.id])
  assert.match(thread.subject, new RegExp(slug))
  assert.equal(thread.counterpart_email, email, 'replying reaches the applicant')
  const msg = await get<any>('SELECT body_text FROM messages WHERE thread_id = ?', [thread.id])
  assert.ok(!msg.body_text.includes('/a/'), 'approve link is NOT in the thread body (cannot leak into replies)')
  assert.match(msg.body_text, /Offers to contribute/, 'the contribution offer is in the application thread')
  assert.match(msg.body_text, /6-month free trial/, 'requested months recorded in the application')
  assert.match(col.contribution_offer, /onboard two other theatre groups/, 'offer stored for the onboarding echo')

  // one-click approve for the requested 6 months
  const token = signToken({ a: 'approve', cid: col.id, m: 6 }, 3600)
  const ares = await app.request(`/a/${token}`)
  assert.equal(ares.status, 200)
  assert.match(await ares.text(), /approved/)
  const after = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(after.status, 'active')
  assert.ok(after.trial_ends_at > now() + 179 * 86400, '6-month trial starts at approval')
  assert.ok(after.trial_ends_at < now() + 181 * 86400)
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
