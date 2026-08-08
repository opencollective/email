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

/** What a reply to this address does. 'reply' answers the outside sender as the
 *  collective; 'note' files the answer as an internal note and never leaves the
 *  team. The kind lives in the row, so a note address can't be made to send. */
export type ReplyKind = 'reply' | 'note'

export interface ReplyRef {
  slug: string
  threadId: number
  memberId: number
  msgId: number
  kind: ReplyKind
  /** for 'note': the member whose mention we are answering */
  authorMemberId: number | null
}

async function mint(
  kind: ReplyKind, slug: string, friendly: string,
  threadId: number, memberId: number, msgId: number, authorMemberId: number | null,
): Promise<string> {
  const token = shortToken()
  await run(`INSERT INTO reply_tokens (token, slug, thread_id, member_id, message_id, kind, author_member_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [token, slug, threadId, memberId, msgId, kind, authorMemberId, now() + 60 * 60 * 24 * 14, now()])
  if (Math.random() < 0.05) await run('DELETE FROM reply_tokens WHERE expires_at < ?', [now()]).catch(() => {})
  // local parts are capped at 64 chars (RFC 5321) — the friendly part absorbs the cut
  const fixed = `-via-${slug}+${token}`
  const head = friendly.slice(0, Math.max(4, 64 - fixed.length)).replace(/[-.]+$/, '')
  return `${head}${fixed}@${cfg.emailDomain}`
}

export const mintReplyAddress = (
  slug: string, counterpartEmail: string | null | undefined,
  threadId: number, memberId: number, msgId: number,
) => mint('reply', slug, friendlySender(counterpartEmail), threadId, memberId, msgId, null)

/** Replying to "X mentioned you" lands back on the thread as another internal
 *  note — so the address reads `note-via-<slug>+<token>`, and nothing about it
 *  can reach the outside sender. */
export const mintNoteReplyAddress = (
  slug: string, threadId: number, memberId: number, authorMemberId: number,
) => mint('note', slug, 'note', threadId, memberId, 0, authorMemberId)

/** Resolve an inbound recipient to a reply reference. Tries, in order: the
 *  current sender-via-slug+token form, the earlier slug+name.token form, and
 *  the legacy signed form (in-flight emails stay valid 14 days). */
export async function resolveReplyAddress(addr: string): Promise<ReplyRef | null> {
  const m = addr.toLowerCase().trim().match(new RegExp(`^([a-z0-9.-]+)\\+([a-z0-9.]+)@${cfg.emailDomain.replace(/\./g, '\\.')}$`))
  if (m) {
    const [, local, tag] = m
    const token = tag.split('.').pop()!
    if (new RegExp(`^[a-z0-9]{${TOKEN_LEN}}$`).test(token)) {
      const row = await get<{
        slug: string; thread_id: number; member_id: number; message_id: number
        kind: string | null; author_member_id: number | null; expires_at: number
      }>('SELECT * FROM reply_tokens WHERE token = ?', [token])
      // the slug must appear in the address (…-via-slug, or the older slug+…)
      if (row && (viaSlug(local) === row.slug || local === row.slug) && row.expires_at >= now()) {
        return {
          slug: row.slug, threadId: row.thread_id, memberId: row.member_id, msgId: row.message_id,
          kind: row.kind === 'note' ? 'note' : 'reply',
          authorMemberId: row.author_member_id,
        }
      }
    }
  }
  // legacy signed addresses only ever meant "answer the sender"
  const legacy = parseReplyAddress(addr)
  return legacy ? { ...legacy, kind: 'reply', authorMemberId: null } : null
}
