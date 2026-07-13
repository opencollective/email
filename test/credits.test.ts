import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, signToken } from '../src/util.js'
import { autoExtendTick, creditBalance, fileContribution, mintCredits, referralMintTick } from '../src/credits.js'
import { billingState } from '../src/billing.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function admin(collectiveId: number, email: string) {
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, email, email.split('@')[0], 'admin', 'every', now()])
  return (await get<any>('SELECT id FROM members WHERE collective_id = ? AND email = ?', [collectiveId, email]))!.id
}

async function outboundAt(collectiveId: number, sentAt: number) {
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'T', 'answered', 'x@y.test', ?, ?, 'outbound', ?, ?)`, [collectiveId, sentAt, sentAt, sentAt, sentAt])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'outbound', 'a@collective.email', '[]', 'reply', ?, ?)`, [t.lastId, `<o-${uniq()}@x>`, sentAt, sentAt])
}

test('ledger: mint, burn, balance', async () => {
  const col = await createCollective(`led-${uniq()}`, 'Ledger')
  assert.equal(await creditBalance(col.id), 0)
  await mintCredits(col.id, 3, 'granted', 'admin')
  await mintCredits(col.id, -1, 'monthly_extension')
  assert.equal(await creditBalance(col.id), 2)
})

test('auto-extend burns one credit when a trial lapses', async () => {
  const col = await createCollective(`ext-${uniq()}`, 'Extend')
  await admin(col.id, `e-${uniq()}@t.test`)
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 3600, col.id])
  await mintCredits(col.id, 2, 'granted', 'admin')
  await autoExtendTick()
  const after = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(billingState(after), 'trial', 'back in trial for another month')
  assert.ok(after.trial_ends_at > now() + 29 * 86400)
  assert.equal(await creditBalance(col.id), 1)
  await autoExtendTick()
  assert.equal(await creditBalance(col.id), 1, 'no double burn while the extension is active')
})

test('auto-extend skips zero balances, subscribers, and comped collectives', async () => {
  const broke = await createCollective(`brk-${uniq()}`, 'Broke')
  await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [now() - 3600, broke.id])
  const paid = await createCollective(`paid-${uniq()}`, 'Paid')
  await run("UPDATE collectives SET trial_ends_at = ?, stripe_status = 'active' WHERE id = ?", [now() - 3600, paid.id])
  await mintCredits(paid.id, 5, 'granted', 'admin')
  await autoExtendTick()
  assert.equal(billingState((await get<any>('SELECT * FROM collectives WHERE id = ?', [broke.id]))!), 'grace')
  assert.equal(await creditBalance(paid.id), 5, 'subscribers never burn credits')
})

test('referral mints only after 30 active days AND real recent use, exactly once', async () => {
  const referrer = await createCollective(`refr-${uniq()}`, 'Referrer')
  const referred = await createCollective(`refd-${uniq()}`, 'Referred')
  await run('UPDATE collectives SET referred_by = ?, activated_at = ? WHERE id = ?', [referrer.id, now() - 31 * 86400, referred.id])
  await admin(referrer.id, `rf-${uniq()}@t.test`)

  await referralMintTick()
  assert.equal(await creditBalance(referrer.id), 0, 'no mint without real use')

  await outboundAt(referred.id, now() - 15 * 86400)
  await referralMintTick()
  assert.equal(await creditBalance(referrer.id), 0, 'outbound older than 10 days does not count')

  await outboundAt(referred.id, now() - 2 * 86400)
  await referralMintTick()
  assert.equal(await creditBalance(referrer.id), 1, 'active referred collective mints +1')

  await referralMintTick()
  assert.equal(await creditBalance(referrer.id), 1, 'never mints twice for the same referred collective')
})

test('referral does not mint before 30 days even with real use', async () => {
  const referrer = await createCollective(`refy-${uniq()}`, 'Early')
  const referred = await createCollective(`refz-${uniq()}`, 'Young')
  await run('UPDATE collectives SET referred_by = ?, activated_at = ? WHERE id = ?', [referrer.id, now() - 5 * 86400, referred.id])
  await outboundAt(referred.id, now() - 86400)
  await referralMintTick()
  assert.equal(await creditBalance(referrer.id), 0)
})

test('claiming through a referral link records referred_by at reservation', async () => {
  const referrer = await createCollective(`link-${uniq()}`, 'Linker')
  const slug = `newbie${uniq()}`
  const email = `n-${uniq()}@t.test`
  const { sha256 } = await import('../src/util.js')
  const { cfg } = await import('../src/config.js')
  await run(`INSERT INTO login_codes (email, code_hash, purpose, join_name, claim_slug, claim_ref, expires_at, created_at)
             VALUES (?, ?, 'claim', 'N', ?, ?, ?, ?)`,
    [email, sha256('123456' + cfg.secret), slug, referrer.slug, now() + 600, now()])
  await app.request('/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&code=123456`,
  })
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug]))!
  assert.equal(col.referred_by, referrer.id)
})

test('contribution thread lands in contribute@ with grant links out of the body; one-shot grants', async () => {
  const hub = await createCollective(`contribhub${uniq()}`, 'Hub', 'collective', { trial: false })
  await run("UPDATE collectives SET slug = 'contribute' WHERE id = ?", [hub.id])
  await admin(hub.id, `hub-${uniq()}@t.test`)
  const col = await createCollective(`giver-${uniq()}`, 'Giver')
  const memberId = await admin(col.id, `giver-${uniq()}@t.test`)
  const member = (await get<any>('SELECT * FROM members WHERE id = ?', [memberId]))!
  await fileContribution(col, member, 'We translated the interface into Dutch and presented it at the citizen assembly meetup.')
  const thread = (await get<any>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [hub.id]))!
  assert.match(thread.subject, /Contribution from/)
  const msg = (await get<any>('SELECT body_text FROM messages WHERE thread_id = ?', [thread.id]))!
  assert.ok(!msg.body_text.includes('/a/'), 'grant links never in the thread body')

  const token = signToken({ a: 'credits', cid: col.id, n: 2, t: now() }, 3600)
  const res1 = await app.request(`/a/${token}`)
  assert.match(await res1.text(), /Granted 2 credits/)
  assert.equal(await creditBalance(col.id), 2)
  const res2 = await app.request(`/a/${token}`)
  assert.match(await res2.text(), /Already granted/)
  assert.equal(await creditBalance(col.id), 2, 'grant tokens are one-shot')
})

test('admin can issue credits from /admin', async () => {
  const col = await createCollective(`iss-${uniq()}`, 'Issue')
  const sid = await createSession('admin@test.local') // platform admin (setup.ts)
  const res = await app.request('/admin/credits', {
    method: 'POST',
    headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `slug=${col.slug}&amount=4&reason=${encodeURIComponent('hosted a workshop')}`,
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /\+4 credits/)
  assert.equal(await creditBalance(col.id), 4)
})
