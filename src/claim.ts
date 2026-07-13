import { simpleParser } from 'mailparser'
import { cfg } from './config.js'
import { getCollectiveBySlug, getMemberIn, run, type Collective } from './db.js'
import { hmac, now, signToken } from './util.js'
import { kvGet, kvSet } from './db.js'
import { ingestInbound } from './ingest.js'
import { RESERVED_SLUGS_PUBLIC } from './claim-reserved.js'

/** The collective that receives free-trial applications (dogfooding). */
export const APPLICATIONS_SLUG = 'applications'

/** Public claiming rules: at least 6 chars, letters and digits only. */
export function validateClaimSlug(slug: string): string | null {
  if (!/^[a-z0-9]{6,40}$/.test(slug)) return 'Addresses are 6–40 characters, letters and numbers only.'
  if (RESERVED_SLUGS_PUBLIC.has(slug)) return `"${slug}" is reserved.`
  return null
}

/** Is this slug an existing collective on opencollective.com? Those names are
 *  reserved for their owners (404 there = available here). Results are cached
 *  for a day; if opencollective.com is unreachable we fail open — an outage
 *  elsewhere must never block claiming. */
export async function ocSlugTaken(slug: string): Promise<boolean> {
  if (process.env.SKIP_OC_SLUG_CHECK) return false
  const key = `ocslug:${slug}`
  const cached = await kvGet(key)
  if (cached) {
    const [v, ts] = cached.split(':')
    if (now() - Number(ts) < 86400) return v === '1'
  }
  try {
    const res = await fetch(`https://opencollective.com/${encodeURIComponent(slug)}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'collective.email slug check' },
    })
    const taken = res.status !== 404
    await kvSet(key, `${taken ? 1 : 0}:${now()}`)
    return taken
  } catch {
    return false
  }
}

/** Full availability check for public claiming (format, reserved list,
 *  opencollective.com names, and stale-pending release). Returns an error
 *  message or null when the slug can be reserved right now. */
export async function slugAvailability(slug: string): Promise<string | null> {
  const invalid = validateClaimSlug(slug)
  if (invalid) return invalid
  const free = await releaseStalePending(slug)
  if (!free) return `${slug} is already taken.`
  if (await ocSlugTaken(slug)) {
    return `"${slug}" belongs to a collective on opencollective.com — we reserve those names for their owners. If that's you, email hello@collective.email.`
  }
  return null
}

/** Discount codes are bound to the slug they unlock: `<slug>-XXXXXXXX`. */
export const discountCodeFor = (slug: string) => `${slug}-${hmac(`discount:${slug}`, 8)}`

export const checkDiscountCode = (slug: string, code: string) =>
  code.trim().toLowerCase() === discountCodeFor(slug)

/** A pending (unpaid, unapplied) reservation holds the slug for 48h. */
export async function releaseStalePending(slug: string): Promise<boolean> {
  const existing = await getCollectiveBySlug(slug)
  if (!existing) return true
  if (existing.status === 'pending' && now() - existing.created_at > 48 * 3600) {
    await run('DELETE FROM members WHERE collective_id = ?', [existing.id])
    await run('DELETE FROM collectives WHERE id = ?', [existing.id])
    return true
  }
  return false
}

/** File a free-trial application: it lands as a normal inbound thread in the
 *  applications collective (so the team can reply and converse by email), and
 *  the members' notification carries a one-click Approve button. That button
 *  exists ONLY in the notification email — never in the thread body — so a
 *  reply to the applicant can never leak it. */
export async function fileApplication(pending: Collective, applicantEmail: string, applicantName: string, reason: string) {
  const apps = await getCollectiveBySlug(APPLICATIONS_SLUG)
  if (!apps || apps.status !== 'active') throw new Error('Applications are closed right now — email hello@collective.email instead.')
  const raw = [
    `From: ${applicantName} <${applicantEmail}>`,
    `To: ${APPLICATIONS_SLUG}@${cfg.emailDomain}`,
    `Subject: Free trial application: ${pending.slug}@${cfg.emailDomain}`,
    `Message-ID: <application-${pending.id}-${now()}@${cfg.emailDomain}>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `${reason.trim()}`,
    '',
    `— ${applicantName} (${applicantEmail}), requesting ${pending.slug}@${cfg.emailDomain}`,
  ].join('\r\n')
  const parsed = await simpleParser(raw)
  const approveUrl = `${cfg.baseUrl}/a/${signToken({ a: 'approve', cid: pending.id }, 60 * 60 * 24 * 30)}`
  await ingestInbound(apps, parsed, undefined, { label: `✓ Approve ${pending.slug} (one click)`, url: approveUrl })
  await run("UPDATE collectives SET status = 'applied' WHERE id = ?", [pending.id])
}

/** Approving an application: activate with the standard 60-day trial. */
export async function approveApplication(collectiveId: number): Promise<Collective | null> {
  await run("UPDATE collectives SET status = 'active', trial_ends_at = ? WHERE id = ? AND status IN ('applied', 'pending')",
    [now() + 60 * 86400, collectiveId])
  const { getCollective } = await import('./db.js')
  return (await getCollective(collectiveId)) ?? null
}

export const claimantOf = (collective: Collective, email: string) => getMemberIn(collective.id, email)
