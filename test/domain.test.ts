import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, signToken } from '../src/util.js'
import { checkDiscountCode, discountCodeFor } from '../src/claim.js'
import { mintCredits, creditBalance, autoExtendTick, PRO_MONTH_CREDITS } from '../src/credits.js'
import { outboundFrom } from '../src/outbound.js'
import { getCollectiveByCustomDomain } from '../src/db.js'
import { cfg } from '../src/config.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function adminSid(collectiveId: number) {
  const email = `adm-${uniq()}@t.test`
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'A', 'admin', 'every', ?)", [collectiveId, email, now()])
  return createSession(email)
}
const post = (path: string, sid: string, body: string) => app.request(path, {
  method: 'POST',
  headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
  body,
})

test('pro discount codes are distinct from collective ones; legacy codes still redeem', () => {
  const slug = 'commonshub'
  const pro3 = discountCodeFor(slug, 3, 'pro')
  assert.match(pro3, new RegExp(`^${slug}-pro-3m-`))
  assert.deepEqual(checkDiscountCode(slug, pro3), { duration: 3, plan: 'pro' })
  const col2 = discountCodeFor(slug, 2)
  assert.deepEqual(checkDiscountCode(slug, col2), { duration: 2, plan: 'collective' })
  assert.equal(checkDiscountCode(slug, pro3.replace('-pro-', '-')), null, 'stripping the pro marker invalidates the code')
  assert.deepEqual(checkDiscountCode(slug, discountCodeFor(slug, undefined, 'pro')), { duration: 'forever', plan: 'pro' })
})

test('domain page: upsell for collective plan, wizard + full pro path for pro', async () => {
  const col = await createCollective(`dom${uniq()}`, 'Dom Co')
  const sid = await adminSid(col.id)
  const base = `/inbox/${col.slug}`

  const upsell = await app.request(`${base}/domain`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(upsell.status, 200)
  const upsellHtml = await upsell.text()
  assert.match(upsellHtml, /Subscribe to Pro/)
  assert.match(upsellHtml, /credits/i)
  assert.match(upsellHtml, /contribut/i)

  // pro discount code upgrades in place
  const res = await post(`${base}/domain/discount`, sid, 'code=' + encodeURIComponent(discountCodeFor(col.slug, 3, 'pro')))
  assert.match(decodeURIComponent(res.headers.get('location')!), /Welcome to Pro — 3 months/)
  let after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(after.plan, 'pro')
  assert.ok(after.trial_ends_at > now() + 89 * 86400)

  // a collective-plan code is refused on the pro route
  const bad = await post(`${base}/domain/discount`, sid, 'code=' + encodeURIComponent(discountCodeFor(col.slug, 2)))
  assert.match(decodeURIComponent(bad.headers.get('location')!), /not a Pro code/)

  // wizard: set the custom address (stubbed Resend in tests)
  const setup = await post(`${base}/domain`, sid, 'local=hello&domain=ourcollective.org')
  assert.match(decodeURIComponent(setup.headers.get('location')!), /hello@ourcollective.org is set up/)
  after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(after.custom_domain, 'ourcollective.org')
  assert.equal(after.receive_mode, 'forwarding')
  assert.equal(after.domain_status, 'pending')

  // degraded sender until verified, custom address once verified
  assert.equal(outboundFrom(after).fromAddress, `${col.slug}@${cfg.emailDomain}`)
  assert.match(outboundFrom(after).fromHeader, /hello@ourcollective\.org/)
  await run("UPDATE collectives SET domain_status = 'verified' WHERE id = ?", [col.id])
  after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(outboundFrom(after).fromAddress, 'hello@ourcollective.org')

  // MX-path routing helper: catch-all by domain
  const found = await getCollectiveByCustomDomain('OURCOLLECTIVE.ORG')
  assert.equal(found?.id, col.id)

  // our own domain can never be claimed as a custom one
  const evil = await post(`${base}/domain/remove`, sid, '').then(() => post(`${base}/domain`, sid, `local=x&domain=${cfg.emailDomain}`))
  assert.match(decodeURIComponent(evil.headers.get('location')!), /does not look like a valid address/)
})

test('credits buy pro months (10 per month); auto-extend charges pro rate', async () => {
  const col = await createCollective(`crd${uniq()}`, 'Cred Co')
  const sid = await adminSid(col.id)
  await mintCredits(col.id, 12, 'granted', 'admin')
  const res = await post(`/inbox/${col.slug}/domain/credits`, sid, '')
  assert.match(decodeURIComponent(res.headers.get('location')!), /Welcome to Pro — 1 month \(2 credits left\)/)
  const after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(after.plan, 'pro')
  assert.equal(await creditBalance(col.id), 12 - PRO_MONTH_CREDITS)

  // auto-extend: a lapsed pro collective needs 10 credits, not 1
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 3600, col.id])
  await autoExtendTick()
  assert.equal(await creditBalance(col.id), 2, '2 credits are not enough for a pro month — no burn')
  await mintCredits(col.id, 8, 'granted', 'admin')
  await autoExtendTick()
  assert.equal(await creditBalance(col.id), 0, '10 credits bought the pro month')
  const extended = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.ok(extended.trial_ends_at > now() + 29 * 86400)
})

test('pro application files a thread with approve-pro buttons; one click upgrades', async () => {
  const apps = await createCollective(`apphub${uniq()}`, 'Apps', 'collective', { trial: false })
  await run("UPDATE collectives SET slug = 'applications' WHERE id = ?", [apps.id]).catch(() => {})
  if ((await get<any>('SELECT slug FROM collectives WHERE id = ?', [apps.id]))!.slug !== 'applications') {
    await run('DELETE FROM collectives WHERE id = ?', [apps.id])
  }
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) SELECT id, 'rev@t.test', 'Rev', 'admin', 'every', ? FROM collectives WHERE slug = 'applications'", [now()])

  const col = await createCollective(`proapp${uniq()}`, 'ProApp Co')
  const sid = await adminSid(col.id)
  const res = await post(`/inbox/${col.slug}/domain/apply`, sid,
    'months=6&contribution=' + encodeURIComponent('We will onboard three other collectives from our federation and document the setup in a blog post.'))
  assert.match(decodeURIComponent(res.headers.get('location')!), /Application sent/)
  const appsCol = (await get<any>("SELECT * FROM collectives WHERE slug = 'applications'"))!
  const thread = (await get<any>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [appsCol.id]))!
  assert.match(thread.subject, /Pro application/)
  const msg = (await get<any>('SELECT body_text FROM messages WHERE thread_id = ?', [thread.id]))!
  assert.ok(!msg.body_text.includes('/a/'), 'approve links never in the thread body')
  assert.equal((await get<any>('SELECT status FROM collectives WHERE id = ?', [col.id]))!.status, 'active', 'collective keeps working while applying')

  const token = signToken({ a: 'approvepro', cid: col.id, m: 6 }, 3600)
  const ares = await app.request(`/a/${token}`)
  assert.match(await ares.text(), /now Pro/)
  const after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(after.plan, 'pro')
  assert.ok(after.trial_ends_at > now() + 179 * 86400)
})
