import crypto from 'node:crypto'
import { cfg } from './config.js'
import { get, run } from './db.js'
import { now, parseReplyAddress } from './util.js'

/** Reply addresses that read like a person instead of a token dump:
 *
 *    commonshub+ruta.k3f8q2xw7p@collective.email
 *
 *  The name part is decoration (the counterpart's local part, sanitized);
 *  the short token is a server-side lookup carrying thread, member and
 *  message — nothing encoded in the address itself, so there's nothing
 *  intimidating to look at and nothing to tamper with. Expiry is enforced
 *  at lookup. Two @s (`ruta@x.com@collective.email`) would need a quoted
 *  local part, which real-world clients mangle — so: not that. */

const TOKEN_LEN = 10
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const shortToken = () =>
  Array.from(crypto.randomBytes(TOKEN_LEN), (b) => ALPHABET[b % ALPHABET.length]).join('')

/** "ruta" from ruta@europeancorrespondent.com — email-safe, short. */
const friendlyLocal = (email: string | null | undefined) =>
  (email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'reply'

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
  return `${slug}+${friendlyLocal(counterpartEmail)}.${token}@${cfg.emailDomain}`
}

/** Resolve an inbound recipient to a reply reference — the short-token form
 *  first, then the legacy signed form (in-flight emails stay valid 14 days). */
export async function resolveReplyAddress(addr: string): Promise<{ slug: string; threadId: number; memberId: number; msgId: number } | null> {
  const m = addr.toLowerCase().trim().match(new RegExp(`^([a-z0-9-]+)\\+(?:[a-z0-9]+\\.)?([a-z0-9]{${TOKEN_LEN}})@${cfg.emailDomain.replace(/\./g, '\\.')}$`))
  if (m) {
    const row = await get<{ slug: string; thread_id: number; member_id: number; message_id: number; expires_at: number }>(
      'SELECT * FROM reply_tokens WHERE token = ?', [m[2]])
    if (row && row.slug === m[1] && row.expires_at >= now()) {
      return { slug: row.slug, threadId: row.thread_id, memberId: row.member_id, msgId: row.message_id }
    }
  }
  return parseReplyAddress(addr)
}
