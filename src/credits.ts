import { simpleParser } from 'mailparser'
import { cfg } from './config.js'
import {
  activeMembers, all, get, getCollective, getCollectiveBySlug, run,
  type Collective, type Member,
} from './db.js'
import { billingState } from './billing.js'
import { now, signToken } from './util.js'
import { ingestInbound } from './ingest.js'
import { sendCreditEmail } from './notify.js'

/** Credits are an append-only ledger; 1 credit = 1 month of service.
 *  The ledger (mint/burn with provenance) is deliberately shaped like an
 *  off-chain token: a future on-chain migration is a replay, not a redesign. */

export const CONTRIBUTE_SLUG = 'contribute'

/** Credits are denominated in Collective months (€/$10). A Pro month is ten. */
export const proMonthCost = (c: Collective) => (c.plan === 'pro' ? 10 : 1)
export const PRO_MONTH_CREDITS = 10

export const creditBalance = async (collectiveId: number): Promise<number> =>
  (await get<{ b: number }>('SELECT COALESCE(SUM(delta), 0) AS b FROM credits_ledger WHERE collective_id = ?', [collectiveId]))!.b

export const creditsLedger = (collectiveId: number, limit = 20) =>
  all<{ id: number; delta: number; reason: string; actor: string; ref: string | null; created_at: number }>(
    'SELECT * FROM credits_ledger WHERE collective_id = ? ORDER BY id DESC LIMIT ?', [collectiveId, limit])

export function mintCredits(collectiveId: number, delta: number, reason: string, actor = 'system', ref?: string) {
  return run('INSERT INTO credits_ledger (collective_id, delta, reason, actor, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, delta, reason, actor, ref ?? null, now()])
}

/** Referral URL a collective shares to earn credits. */
export const referralUrl = (slug: string) => `${cfg.baseUrl}/claim?ref=${slug}`

// ---------- spending: automatic monthly extension ----------

/** Lapsed collectives with a positive balance burn 1 credit for +30 days.
 *  Runs from the hourly cron; loops so a 3-credit balance survives a long
 *  gap between cron runs correctly (one month per burn, evaluated fresh). */
export async function autoExtendTick() {
  const candidates = await all<Collective>(`
    SELECT * FROM collectives
    WHERE status = 'active' AND comped = 0 AND trial_ends_at IS NOT NULL AND trial_ends_at < ?
  `, [now()])
  for (const c of candidates) {
    if (billingState(c) !== 'grace') continue // subscribed or already expired
    const cost = proMonthCost(c) // 1 credit = one Collective month; Pro months cost their value
    const balance = await creditBalance(c.id)
    if (balance < cost) continue
    const newEnd = Math.max(c.trial_ends_at!, now()) + 30 * 86400
    await run('UPDATE collectives SET trial_ends_at = ? WHERE id = ?', [newEnd, c.id])
    await mintCredits(c.id, -cost, 'monthly_extension')
    const admins = (await activeMembers(c.id)).filter((m) => m.role === 'admin')
    await sendCreditEmail(c, admins,
      `${cost} credit${cost > 1 ? 's' : ''} used — ${c.slug}@${cfg.emailDomain} extended a month`,
      `Your balance covered another month automatically (${balance - cost} credit${balance - cost === 1 ? '' : 's'} left). Keep earning by referring other collectives or contributing.`).catch(() => {})
    console.log(`[credits] extended ${c.slug} by 30d (-${cost}, balance now ${balance - cost})`)
  }
}

// ---------- earning: referrals (abuse-guarded) ----------

/** Referral mint rules (anti-farming):
 *  - only after the referred collective has been ACTIVE for 30+ days
 *    (activation itself is gated: payment, signed discount code, or a
 *    human-approved application — chains can't self-activate), and
 *  - only if the referred collective shows real use: at least one outbound
 *    reply sent in the past 10 days, and
 *  - at most once per referred collective, ever (ledger-deduped). */
export async function referralMintTick() {
  const due = await all<Collective>(`
    SELECT c.* FROM collectives c
    WHERE c.referred_by IS NOT NULL AND c.status = 'active'
      AND c.activated_at IS NOT NULL AND c.activated_at < ?
      AND NOT EXISTS (SELECT 1 FROM credits_ledger l WHERE l.reason = 'referral' AND l.ref = 'collective:' || c.id)
  `, [now() - 30 * 86400])
  for (const referred of due) {
    const referrer = await getCollective(referred.referred_by!)
    if (!referrer || referrer.status !== 'active') continue
    const realUse = await get(`
      SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.collective_id = ? AND m.direction = 'outbound' AND m.sent_at > ? LIMIT 1
    `, [referred.id, now() - 10 * 86400])
    if (!realUse) continue // re-evaluated on every tick until they show real use
    await mintCredits(referrer.id, 1, 'referral', 'system', `collective:${referred.id}`)
    const admins = (await activeMembers(referrer.id)).filter((m) => m.role === 'admin')
    await sendCreditEmail(referrer, admins,
      `+1 credit — ${referred.slug}@${cfg.emailDomain} is actively using collective.email`,
      `You referred ${referred.slug} a month ago and they're actively using their inbox — you earned 1 credit (1 month of service). Balance: ${await creditBalance(referrer.id)}.`).catch(() => {})
    console.log(`[credits] referral mint: +1 to ${referrer.slug} for ${referred.slug}`)
  }
}

export async function creditsTick() {
  await autoExtendTick()
  await referralMintTick()
}

// ---------- earning: contributions (human-judged) ----------

/** A contribution lands as a normal thread in contribute@ — replyable like
 *  everything else — and the notification carries one-click grant buttons.
 *  Grant links exist only in the notification email, never in the thread. */
export async function fileContribution(collective: Collective, member: Member, text: string) {
  const hub = await getCollectiveBySlug(CONTRIBUTE_SLUG)
  if (!hub || hub.status !== 'active') throw new Error('Contributions are closed right now — email hello@collective.email instead.')
  const raw = [
    `From: ${member.name || member.email} <${member.email}>`,
    `To: ${CONTRIBUTE_SLUG}@${cfg.emailDomain}`,
    `Subject: Contribution from ${collective.slug}@${cfg.emailDomain}`,
    `Message-ID: <contribution-${collective.id}-${now()}@${cfg.emailDomain}>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text.trim(),
    '',
    `— ${member.name || member.email}, for ${collective.slug}@${cfg.emailDomain} (balance: ${await creditBalance(collective.id)})`,
  ].join('\r\n')
  const parsed = await simpleParser(raw)
  const grants = [1, 2, 3].map((n) => ({
    label: `✓ Grant ${n} credit${n > 1 ? 's' : ''}`,
    url: `${cfg.baseUrl}/a/${signToken({ a: 'credits', cid: collective.id, n, t: now() }, 60 * 60 * 24 * 30)}`,
  }))
  await ingestInbound(hub, parsed, undefined, grants)
}
