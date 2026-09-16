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
  assert.doesNotMatch(upsellHtml, /Subscribe to Pro/, 'no working Stripe key in tests → checkout hidden')
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

test('credits buy pro months (PRO_MONTH_CREDITS per month); auto-extend charges pro rate', async () => {
  const col = await createCollective(`crd${uniq()}`, 'Cred Co')
  const sid = await adminSid(col.id)
  await mintCredits(col.id, PRO_MONTH_CREDITS + 1, 'granted', 'admin')
  const res = await post(`/inbox/${col.slug}/domain/credits`, sid, '')
  assert.match(decodeURIComponent(res.headers.get('location')!), /Welcome to Pro — 1 month \(1 credits? left\)/)
  const after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(after.plan, 'pro')
  assert.equal(await creditBalance(col.id), 1)

  // auto-extend: a lapsed pro collective needs the pro rate, not 1 credit
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 3600, col.id])
  await autoExtendTick()
  assert.equal(await creditBalance(col.id), 1, '1 credit is not enough for a pro month — no burn')
  await mintCredits(col.id, PRO_MONTH_CREDITS - 1, 'granted', 'admin')
  await autoExtendTick()
  assert.equal(await creditBalance(col.id), 0, 'the pro rate bought the pro month')
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

test('a domain already connected to another collective is refused with a clear message', async () => {
  const a = await createCollective(`dup-a${uniq()}`, 'A Co')
  const b = await createCollective(`dup-b${uniq()}`, 'B Co')
  await run("UPDATE collectives SET plan = 'pro' WHERE id IN (?, ?)", [a.id, b.id])
  const sidA = await adminSid(a.id)
  const sidB = await adminSid(b.id)
  await post(`/inbox/${a.slug}/domain`, sidA, 'local=hello&domain=shared-domain.org')
  const res = await post(`/inbox/${b.slug}/domain`, sidB, 'local=hello&domain=shared-domain.org')
  const msg = decodeURIComponent(res.headers.get('location')!)
  assert.match(msg, /already connected to another collective/)
  assert.ok(!msg.includes('{'), 'no raw JSON in user-facing errors')
  assert.equal((await get<any>('SELECT custom_domain FROM collectives WHERE id = ?', [b.id]))!.custom_domain, null)
})

test('thread page + reply route reflect the verified custom domain (tenant projection carries it)', async () => {
  const col = await createCollective(`send${uniq()}`, 'Send Co')
  const sid = await adminSid(col.id)
  await run("UPDATE collectives SET plan = 'pro', custom_domain = 'ourgroup.org', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [col.id])
  const th = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Q', 'needs_reply', 'ann@x.test', ?, ?, 'inbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'ann@x.test', '[]', 'hi', ?, ?)`, [th.lastId, `<sc-${uniq()}@x>`, now(), now()])

  const page = await app.request(`/inbox/${col.slug}/thread/${th.lastId}`, { headers: { cookie: `requests_sid=${sid}` } })
  const html = await page.text()
  assert.match(html, /Sending to <b>ann@x\.test<\/b>/, 'the composer says who it sends to')
  assert.match(html, /as <b>hello@ourgroup\.org<\/b>/, '…and as whom')
  assert.ok(!/as <b>send\d+@/.test(html), 'not the collective.email address once verified')

  // and unverified degrades back to the platform address
  await run("UPDATE collectives SET domain_status = 'pending' WHERE id = ?", [col.id])
  const page2 = await app.request(`/inbox/${col.slug}/thread/${th.lastId}`, { headers: { cookie: `requests_sid=${sid}` } })
  const html2 = await page2.text()
  assert.match(html2, new RegExp(`as <b>${col.slug}@`), 'unverified falls back to the platform address')
})

// ---------- verification is read-before-trigger, and self-heals ----------

test('the domain page banks a verification Resend finished on its own', async () => {
  const { __setResendDomainStub } = await import('../src/domains.js')
  const { createSession } = await import('../src/auth.js')
  const { createCollective, get, run } = await import('../src/db.js')
  const { now } = await import('../src/util.js')

  const slug = `dver${Date.now() % 100000}`
  const col = await createCollective(slug, 'DomainVerify', 'pro')
  await run("UPDATE collectives SET custom_domain = 'madeleine.pod.brussels', custom_local = 'hello', resend_domain_id = 'dom_x', domain_status = 'pending', receive_mode = 'forward' WHERE id = ?", [col.id])
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'dv@t.test', 'D', 'admin', 'every', ?)", [col.id, now()])
  const sid = await createSession('dv@t.test')

  // Resend has finished its async check since we last looked
  __setResendDomainStub({
    id: 'dom_x', name: 'madeleine.pod.brussels', status: 'verified',
    records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=X', status: 'verified' }],
  })
  try {
    const page = await app.request(`/inbox/${slug}/domain`, { headers: { cookie: `requests_sid=${sid}` } })
    const html = await page.text()
    assert.match(html, /verified — replies now go out as/i, 'no section still claims to be waiting on DNS')
    assert.equal((await get<any>('SELECT domain_status FROM collectives WHERE id = ?', [col.id]))!.domain_status, 'verified',
      'a plain page view banks the result — no button needed')
  } finally {
    __setResendDomainStub(null)
  }
})

test('the hourly tick reads before it re-triggers, so a finished check is never reset away', async () => {
  const { __setResendDomainStub, domainVerifyTick } = await import('../src/domains.js')
  const { createCollective, get, run } = await import('../src/db.js')
  const { cfg } = await import('../src/config.js')

  const slug = `dtick${Date.now() % 100000}`
  const col = await createCollective(slug, 'DomainTick', 'pro')
  await run("UPDATE collectives SET custom_domain = 'tick.example.org', custom_local = 'hello', resend_domain_id = 'dom_t', domain_status = 'pending' WHERE id = ?", [col.id])

  void cfg
  // Resend already finished the check — the tick's READ must bank it, and the
  // read must come before any re-trigger could reset it to pending
  __setResendDomainStub({ id: 'dom_t', name: 'tick.example.org', status: 'verified', records: [] })
  try {
    await domainVerifyTick()
    assert.equal((await get<any>('SELECT domain_status FROM collectives WHERE id = ?', [col.id]))!.domain_status, 'verified',
      'the hourly tick banks a finished verification')
  } finally {
    __setResendDomainStub(null)
  }
})

test('one domain, several inboxes: an admin of the holder can add another address; a stranger cannot', async () => {
  const { getCollectiveByCustomAddress, siblingsOnDomain } = await import('../src/db.js')
  const { teamSender, externalRecipient } = await import('../src/ingest.js')
  const d = `shared${uniq()}.org`
  const a = await createCollective(`sh-a${uniq()}`, 'Hello Co')
  const b = await createCollective(`sh-b${uniq()}`, 'Social Co')
  const c = await createCollective(`sh-c${uniq()}`, 'Stranger Co')
  await run("UPDATE collectives SET plan = 'pro' WHERE id IN (?, ?, ?)", [a.id, b.id, c.id])
  // one person administers A and B; someone else administers C
  const me = `me-${uniq()}@t.test`
  for (const col of [a, b]) {
    await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Me', 'admin', 'every', ?)", [col.id, me, now()])
  }
  const sid = await createSession(me)
  const sidC = await adminSid(c.id)

  await post(`/inbox/${a.slug}/domain`, sid, `local=hello&domain=${d}`)
  await run("UPDATE collectives SET receive_mode = 'mx' WHERE id = ?", [a.id]) // A receives the domain's MX
  // a stranger is refused, with nothing written
  const refused = await post(`/inbox/${c.slug}/domain`, sidC, `local=social&domain=${d}`)
  assert.match(decodeURIComponent(refused.headers.get('location')!), /already connected to another collective/)
  assert.equal((await get<any>('SELECT custom_domain FROM collectives WHERE id = ?', [c.id]))!.custom_domain, null)
  // the holder's admin may add a second address — but not the same one twice
  const clash = await post(`/inbox/${b.slug}/domain`, sid, `local=hello&domain=${d}`)
  assert.match(decodeURIComponent(clash.headers.get('location')!), /already the address of Hello Co/)
  const ok = await post(`/inbox/${b.slug}/domain`, sid, `local=social&domain=${d}`)
  assert.match(decodeURIComponent(ok.headers.get('location')!), /social@.* is set up — the domain's mail already comes here/)
  const A = (await get<any>('SELECT * FROM collectives WHERE id = ?', [a.id]))!
  const B = (await get<any>('SELECT * FROM collectives WHERE id = ?', [b.id]))!
  assert.equal(B.custom_domain, d)
  assert.equal(B.custom_local, 'social')
  assert.equal(B.resend_domain_id, A.resend_domain_id, 'one Resend domain record, no new DNS')
  assert.equal(B.receive_mode, 'mx', 'inherits the MX path the domain is already on')
  assert.equal((await siblingsOnDomain(d, a.id)).map((x) => x.id).join(), String(b.id))

  // inbound routing: the exact address wins, anything else goes to the MX holder
  assert.equal((await getCollectiveByCustomAddress('social', d))!.id, b.id)
  assert.equal((await getCollectiveByCustomAddress('hello', d))!.id, a.id)
  assert.equal((await getCollectiveByCustomDomain(d))!.id, a.id, 'catch-all = the collective on MX')
  assert.equal(await getCollectiveByCustomAddress('nobody', d), undefined)

  // the sibling's address is a counterpart of A, not A's own team
  assert.equal((await teamSender(A, `social@${d}`)).team, false)
  assert.equal((await teamSender(A, `inge@${d}`)).team, true, 'other people on the domain still write as the team')
  const ext = await externalRecipient(A, [{ address: `hello@${d}`, name: '' }, { address: `social@${d}`, name: 'Social' }])
  assert.equal(ext?.address, `social@${d}`)

  // disconnecting B leaves A's domain record alone
  await post(`/inbox/${b.slug}/domain/remove`, sid, '')
  assert.equal((await get<any>('SELECT custom_domain FROM collectives WHERE id = ?', [b.id]))!.custom_domain, null)
  assert.equal((await get<any>('SELECT resend_domain_id FROM collectives WHERE id = ?', [a.id]))!.resend_domain_id, A.resend_domain_id)
  // the domain page tells the holder who else is on the domain
  await post(`/inbox/${b.slug}/domain`, sid, `local=social&domain=${d}`)
  const pageA = await (await app.request(`/inbox/${a.slug}/domain`, { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(pageA, /also serves social@ \(Social Co\)/)
  assert.match(pageA, /anything else at the domain lands here/)
  const pageB = await (await app.request(`/inbox/${b.slug}/domain`, { headers: { cookie: `requests_sid=${sid}` } })).text()
  assert.match(pageB, /anything else at the domain goes to Hello Co/)
})
