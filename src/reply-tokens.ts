import crypto from 'node:crypto'
import { cfg } from './config.js'
import { get, run } from './db.js'
import { now, parseReplyAddress } from './util.js'

/** Reply addresses that say what they do:
 *
 *    ruta-europeancorrespondent.com-via-commonshub+k3f8q2xw7p@collective.email
 *
 *  Reads as "to ruta@europeancorrespondent.com, via commonshub"; the plus-tag
 *  is a short server-side token carrying thread, member and message — nothing
 *  encoded in the address itself, nothing to decode or tamper with. Expiry is
 *  enforced at lookup, and even an expired address still routes to the
 *  collective's inbox thanks to the -via-<slug> suffix. A literal second @
 *  (`ruta@x.com@collective.email`) would need a quoted local part, which
 *  real-world clients mangle — so: not that. */

const TOKEN_LEN = 10
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const shortToken = () =>
  Array.from(crypto.randomBytes(TOKEN_LEN), (b) => ALPHABET[b % ALPHABET.length]).join('')

/** "ruta-europeancorrespondent.com" from ruta@europeancorrespondent.com —
 *  email-safe: dots kept, everything else collapsed to dashes. */
const friendlySender = (email: string | null | undefined) =>
  (email || '').toLowerCase().replace(/@/g, '-').replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '') || 'reply'

/** The -via-<slug> suffix routes even when the token has expired. */
export const viaSlug = (localPart: string): string | null =>
  localPart.match(/-via-([a-z0-9-]+)$/)?.[1] ?? null

export async function mintReplyAddress(
  slug: string,
  counterpartEmail: string | null | undefined,
  threadId: number,
  memberId: number,
  msgId: number,
): Promise<string> {
  const token = shortToken()
  await run('INSERT INTO reply_tokens (token, slug, thread_id, member_id, message_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [token, slug, threadId, memberId, msgId, now() + 60 * 60 * 24 * 14, now()])
  if (Math.random() < 0.05) await run('DELETE FROM reply_tokens WHERE expires_at < ?', [now()]).catch(() => {})
  // local parts are capped at 64 chars (RFC 5321) — the sender part absorbs the cut
  const fixed = `-via-${slug}+${token}`
  const sender = friendlySender(counterpartEmail).slice(0, Math.max(4, 64 - fixed.length)).replace(/[-.]+$/, '')
  return `${sender}${fixed}@${cfg.emailDomain}`
}

/** Resolve an inbound recipient to a reply reference. Tries, in order: the
 *  current sender-via-slug+token form, the earlier slug+name.token form, and
 *  the legacy signed form (in-flight emails stay valid 14 days). */
export async function resolveReplyAddress(addr: string): Promise<{ slug: string; threadId: number; memberId: number; msgId: number } | null> {
  const m = addr.toLowerCase().trim().match(new RegExp(`^([a-z0-9.-]+)\\+([a-z0-9.]+)@${cfg.emailDomain.replace(/\./g, '\\.')}$`))
  if (m) {
    const [, local, tag] = m
    const token = tag.split('.').pop()!
    if (new RegExp(`^[a-z0-9]{${TOKEN_LEN}}$`).test(token)) {
      const row = await get<{ slug: string; thread_id: number; member_id: number; message_id: number; expires_at: number }>(
        'SELECT * FROM reply_tokens WHERE token = ?', [token])
      // the slug must appear in the address (…-via-slug, or the older slug+…)
      if (row && (viaSlug(local) === row.slug || local === row.slug) && row.expires_at >= now()) {
        return { slug: row.slug, threadId: row.thread_id, memberId: row.member_id, msgId: row.message_id }
      }
    }
  }
  return parseReplyAddress(addr)
}
