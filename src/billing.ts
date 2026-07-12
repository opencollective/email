import { get, type Collective } from './db.js'
import { now } from './util.js'

/** Business model: 60-day free trial (no card), then 30 days read-only grace,
 *  then the address stops receiving. Subscribing at any point restores everything.
 *  Collectives created before trials existed (trial_ends_at NULL) and comped
 *  ones are grandfathered. */
export const TRIAL_DAYS = 60
export const GRACE_DAYS = 30

export type BillingState = 'subscribed' | 'comped' | 'trial' | 'grace' | 'expired'

const SUB_ACTIVE = new Set(['active', 'trialing', 'past_due'])

export function billingState(c: Pick<Collective, 'stripe_status' | 'trial_ends_at' | 'comped'>): BillingState {
  if (SUB_ACTIVE.has(c.stripe_status || '')) return 'subscribed'
  if (c.comped || !c.trial_ends_at) return 'comped'
  const n = now()
  if (n < c.trial_ends_at) return 'trial'
  if (n < c.trial_ends_at + GRACE_DAYS * 86400) return 'grace'
  return 'expired'
}

/** Can this collective send email (replies) right now? */
export const canSend = (state: BillingState) => state === 'subscribed' || state === 'comped' || state === 'trial'

/** Does this collective still receive inbound email? (everything except expired) */
export const canReceive = (state: BillingState) => state !== 'expired'

export const trialDaysLeft = (c: Pick<Collective, 'trial_ends_at'>) =>
  c.trial_ends_at ? Math.max(0, Math.ceil((c.trial_ends_at - now()) / 86400)) : null

/** Per-plan limits. Readers are always free and unlimited; contributors
 *  (roles member/admin) and monthly replies are the paid dimensions. */
export const PLAN_LIMITS: Record<string, { contributors: number; replies: number }> = {
  collective: { contributors: 10, replies: 1000 },
  pro: { contributors: Infinity, replies: 10000 },
  duo: { contributors: 2, replies: 1000 }, // legacy plan, kept for old rows
}

export const planLimits = (plan: string) => PLAN_LIMITS[plan] || PLAN_LIMITS.collective

/** Outbound replies sent by this collective in the current calendar month. */
export async function repliesThisMonth(collectiveId: number): Promise<number> {
  const d = new Date()
  const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
  const row = await get<{ n: number }>(`
    SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.collective_id = ? AND m.direction = 'outbound' AND m.sent_at >= ?
  `, [collectiveId, monthStart])
  return row?.n ?? 0
}

/** Throws a human-readable error if the collective may not send right now. */
export async function assertCanSend(collective: Collective) {
  const state = billingState(collective)
  if (state === 'grace') {
    throw new Error(`The free trial of ${collective.name} has ended — the inbox is read-only until an admin subscribes (Billing page).`)
  }
  if (state === 'expired') {
    throw new Error(`${collective.name}'s trial and grace period are over. Subscribe on the Billing page to reactivate the address.`)
  }
  const limits = planLimits(collective.plan)
  const used = await repliesThisMonth(collective.id)
  if (used >= limits.replies) {
    throw new Error(`Monthly reply limit reached (${limits.replies}). It resets on the 1st — or upgrade the plan for more.`)
  }
}
