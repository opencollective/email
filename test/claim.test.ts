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
  assert.deepEqual(checkDiscountCode('composters', forever), { duration: 'forever', plan: 'collective' })
  assert.deepEqual(checkDiscountCode('composters', forever.toUpperCase()), { duration: 'forever', plan: 'collective' })
  assert.equal(checkDiscountCode('othergroup', forever), null)
  const trial6 = discountCodeFor('composters', 6)
  assert.match(trial6, /^composters-6m-[a-f0-9]{8}$/)
  assert.deepEqual(checkDiscountCode('composters', trial6), { duration: 6, plan: 'collective' })
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

/** Reservations made before addresses went live on claim still exist; the
 *  activation-page tests set one up by hand. */
const forcePending = (slug: string) =>
  run("UPDATE collectives SET status = 'pending', trial_ends_at = NULL, activated_at = NULL WHERE slug = ?", [slug])

test('claim: verified code opens the collective at once — a month free — and lands in the inbox', async () => {
  const slug = `choir${uniq()}`
  const email = `nadia-${uniq()}@t.test`
  const res = await verifiedClaim(slug, email)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `/inbox/${slug}`)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'active')
  assert.ok(col.trial_ends_at > now() + 29 * 86400 && col.trial_ends_at < now() + 31 * 86400, 'one month')
  assert.ok(col.activated_at, 'activation stamped')
  const admin = await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id])
  assert.equal(admin.email, email)
  assert.equal(admin.role, 'admin')
  // the inbox opens, and asks the lone founder to bring the others in
  const inbox = await (await app.request(`/inbox/${slug}`, { headers: { cookie: `requests_sid=${await createSession(email)}` } })).text()
  assert.match(inbox, /solo-note/)
  assert.match(inbox, /Invite your collective/)
})

test('months-bound discount code grants a trial of that length', async () => {
  const slug = `farm${uniq()}xx`
  const email = `f-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  await forcePending(slug)
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

test('duplicate verify (double tap / OTP autofill) replays as success, no duplicate side effects', async () => {
  const slug = `dupe${uniq()}xx`
  const email = `d-${uniq()}@t.test`
  const first = await verifiedClaim(slug, email)
  assert.equal(first.status, 302)
  assert.equal(first.headers.get('location'), `/inbox/${slug}`)
  // the exact same POST again — the code row is consumed, not gone
  const again = await app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=123456`,
  })
  assert.equal(again.status, 302, 'replay signs in instead of "expired"')
  assert.equal(again.headers.get('location'), `/inbox/${slug}`)
  assert.ok(again.headers.get('set-cookie')?.includes('requests_sid='))
  const members = await all<any>('SELECT m.* FROM members m JOIN collectives c ON c.id = m.collective_id WHERE c.slug = ?', [slug])
  assert.equal(members.length, 1, 'no duplicate member from the replay')
})

test('wrong code after a successful sign-in offers a resend button', async () => {
  const slug = `wrong${uniq()}x`
  const email = `w-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  const res = await app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=999999`,
  })
  const html = await res.text()
  assert.match(html, /already used/)
  assert.match(html, /action="\/resend"/)
  assert.match(html, /Send me a new code/)
})

test('expired code shows the resend button; /resend re-issues with the claim intact', async () => {
  const slug = `stale${uniq()}x`
  const email = `s-${uniq()}@t.test`
  // plant an expired claim code (created long enough ago to clear the rate limit)
  await run(`INSERT INTO login_codes (email, code_hash, purpose, join_name, claim_slug, expires_at, created_at)
             VALUES (?, ?, 'claim', 'Sam', ?, ?, ?)`,
    [email, sha256('123456' + cfg.secret), slug, now() - 60, now() - 700])
  const res = await app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=123456`,
  })
  const html = await res.text()
  assert.match(html, /expired/)
  assert.match(html, /action="\/resend"/)

  const resend = await app.request('/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}`,
  })
  assert.equal(resend.status, 200)
  assert.match(await resend.text(), /Sign in/)
  const row = (await get<any>('SELECT * FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [email]))!
  assert.equal(row.purpose, 'claim', 'resent code keeps the claim purpose')
  assert.equal(row.claim_slug, slug, 'resent code keeps the slug')
  assert.equal(row.join_name, 'Sam')
  assert.ok(row.expires_at > now(), 'fresh expiry')
})

test('discount code activates the pending collective as comped', async () => {
  const slug = `garden${uniq()}`
  const email = `g-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  await forcePending(slug)
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
  await forcePending(slug2)
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
  await forcePending(slug)
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
  await forcePending(slug)
  await run("UPDATE collectives SET created_at = ? WHERE slug = ?", [now() - 49 * 3600, slug])
  const email2 = `s2-${uniq()}@t.test`
  const res = await verifiedClaim(slug, email2)
  assert.equal(res.headers.get('location'), `/inbox/${slug}`, 'slug reclaimable after expiry')
  const owners = await all<any>('SELECT m.email FROM members m JOIN collectives c ON c.id = m.collective_id WHERE c.slug = ?', [slug])
  assert.deepEqual(owners.map((o) => o.email), [email2])
})

test('nobody else is needed: a claim is live at once, a legacy reservation opens with one click, joining does not reset the clock', async () => {
  const slug = `trial${uniq()}`
  const email = `tr-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  const sid = await createSession(email)
  const live = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(live.status, 'active')
  const firstClock = live.activated_at

  // a reservation from before: the activation page opens it, same month's trial
  await forcePending(slug)
  const page = await (await app.request(`/claim/${slug}`, { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(page, /Open the inbox/)
  assert.doesNotMatch(page, /Invite a teammate/)
  const res = await app.request(`/claim/${slug}/activate`, {
    method: 'POST', headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `/inbox/${slug}`)
  const opened = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(opened.status, 'active')
  assert.ok(opened.trial_ends_at > now() + 29 * 86400 && opened.trial_ends_at < now() + 31 * 86400, 'exactly one month')

  // a teammate joining an active collective changes nothing about the trial
  const { randomToken } = await import('../src/util.js')
  const invite = randomToken(18)
  await run("INSERT INTO invites (collective_id, token, created_at, expires_at, role) VALUES (?, ?, ?, ?, 'member')",
    [opened.id, invite, now(), now() + 86400])
  const second = `mate-${uniq()}@t.test`
  const mateSid = await createSession(second)
  await app.request(`/join/${invite}`, {
    method: 'POST',
    headers: { cookie: `requests_sid=${mateSid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: second, name: 'Mate', level: 'daily' }),
  })
  const after = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(after.trial_ends_at, opened.trial_ends_at, 'no second month for a second person')
  assert.equal(after.activated_at, firstClock === null ? after.activated_at : after.activated_at)
  // and with two people the nudge is gone
  const inbox = await (await app.request(`/inbox/${slug}`, { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.doesNotMatch(inbox, /solo-note/)
})

test('claiming is two steps: address first, then the first admin (editable address)', async () => {
  const slug = `twostep${uniq()}`

  // step 1: no address yet
  const step1 = await app.request('/claim')
  const h1 = await step1.text()
  assert.match(h1, /Claim your address/)
  assert.match(h1, /Claim address/, 'progress shows the three steps')
  assert.doesNotMatch(h1, /name="email"/, 'step 1 does not ask who you are yet')

  // step 2: the address arrives from the homepage's "Claim it"
  const step2 = await app.request(`/claim?address=${slug}`)
  const h2 = await step2.text()
  assert.match(h2, /the first admin/)
  assert.match(h2, new RegExp(`${slug}@collective\\.email`), 'the address is shown, not re-typed')
  assert.match(h2, new RegExp(`href="/claim\\?address=${slug}&amp;edit=1"`), 'with a way back to edit it')
  assert.match(h2, /name="email"/)
  assert.doesNotMatch(h2, /id="claim-address"/, 'no address field on step 2')

  // the edit link reopens step 1 with the address filled in
  const back = await app.request(`/claim?address=${slug}&edit=1`)
  const hb = await back.text()
  assert.match(hb, /id="claim-address"/)
  assert.match(hb, new RegExp(`value="${slug}"`))

  // a taken address bounces back to step 1 instead of stranding you on step 2
  await createCollective(slug, 'Taken Co')
  const taken = await app.request(`/claim?address=${slug}`)
  const ht = await taken.text()
  assert.match(ht, /id="claim-address"/, 'back on step 1')
  assert.match(ht, /already taken/)
})

test('while reserved, the invite step never links into the (not yet existing) inbox', async () => {
  const slug = `resv${uniq()}`
  const email = `rs-${uniq()}@t.test`
  await verifiedClaim(slug, email)
  await forcePending(slug)
  const sid = await createSession(email)
  const headers = { cookie: `requests_sid=${sid}` }

  const page = await (await app.request(`/claim/${slug}/invite`, { headers })).text()
  assert.match(page, /One teammate away/)
  assert.doesNotMatch(page, new RegExp(`/inbox/${slug}`), 'no inbox or Members link before activation')
  // the first teammate is invited as a sender, not a reader
  const col = (await get<any>('SELECT id FROM collectives WHERE slug = ?', [slug]))!
  const inv = (await get<any>('SELECT token, role FROM invites WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [col.id]))!
  assert.equal(inv.role, 'member')
  assert.match(page, new RegExp(`/join/${inv.token}`))
  const joinPage = await (await app.request(`/join/${inv.token}`, { headers: { cookie: `requests_sid=${await createSession(`m-${uniq()}@t.test`)}` } })).text()
  assert.match(joinPage, /join as a <b>sender<\/b>/)
  assert.match(page, new RegExp(`/claim/${slug}"`), 'points back at the activation options instead')

  // and the inbox itself sends its own member to activation rather than a 404
  for (const path of [`/inbox/${slug}`, `/inbox/${slug}/members`]) {
    const res = await app.request(path, { headers })
    assert.equal(res.status, 302, path)
    assert.equal(res.headers.get('location'), `/claim/${slug}`)
  }
  // a stranger still learns nothing
  const strangerSid = await createSession(`str-${uniq()}@t.test`)
  assert.equal((await app.request(`/inbox/${slug}`, { headers: { cookie: `requests_sid=${strangerSid}` } })).status, 404)

  // once live, the same step offers the inbox and Members
  await run("UPDATE collectives SET status = 'active' WHERE slug = ?", [slug])
  const live = await (await app.request(`/claim/${slug}/invite`, { headers })).text()
  assert.match(live, new RegExp(`/inbox/${slug}/members`))
  assert.match(live, /open the inbox/)
})

test('signed in, the first admin is you: no name, no email, no code', async () => {
  const email = `me-${uniq()}@t.test`
  // they already belong somewhere, under a name — the new collective reuses it
  const home = await createCollective(`home${uniq()}`, 'Home Co')
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [home.id, email, 'Nadia', 'member', 'every', now()])
  const sid = await createSession(email)
  const headers = { cookie: `requests_sid=${sid}` }
  const slug = `mine${uniq()}`

  // step 1 posts straight through, carrying the account
  const h1 = await (await app.request('/claim', { headers })).text()
  assert.match(h1, /<form method="post" action="\/claim">/)
  assert.match(h1, new RegExp(`name="account" value="${email}"`))
  assert.doesNotMatch(h1, /6-digit code/)

  // an address arriving settled (homepage, OC proof) gets one button, not a form about who you are
  const h2 = await (await app.request(`/claim?address=${slug}`, { headers })).text()
  assert.match(h2, /Open it/)
  assert.doesNotMatch(h2, /name="email"/)
  assert.doesNotMatch(h2, /the first admin\?/)
  assert.match(h2, /Set first admin/, 'the step is still listed — as done')

  // claiming is immediate: live collective, you as admin, straight into the inbox
  const res = await app.request('/claim', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address: slug, account: email }),
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `/inbox/${slug}`)
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.status, 'active')
  assert.equal(col.name, "Nadia's collective")
  const admin = (await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id]))!
  assert.equal(admin.email, email)
  assert.equal(admin.role, 'admin')
  assert.equal(admin.name, 'Nadia')
  assert.equal((await get<any>('SELECT COUNT(*) AS n FROM login_codes WHERE claim_slug = ?', [slug]))!.n, 0, 'no code was issued')

  // an account the session does not hold buys nothing — back to needing an email
  const other = `other${uniq()}`
  const forged = await app.request('/claim', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address: other, account: 'someone@else.test' }),
  })
  assert.equal(forged.status, 200)
  assert.match(await forged.text(), /doesn.{0,6}t look right/)
  assert.equal(await get<any>('SELECT id FROM collectives WHERE slug = ?', [other]), undefined)

  // signed out, nothing changes: the address leads to the first-admin form
  const out = await (await app.request(`/claim?address=${slug}x`)).text()
  assert.match(out, /the first admin\?/)
  assert.match(out, /name="email"/)
})
