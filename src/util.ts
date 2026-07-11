import crypto from 'node:crypto'
import { cfg } from './config.js'

export const now = () => Math.floor(Date.now() / 1000)

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url')

export const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0')

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

export function hmac(data: string, len = 16): string {
  return crypto.createHmac('sha256', cfg.secret).update(data).digest('hex').slice(0, len)
}

/** Signed, expiring token carrying a small JSON payload (one-click action links). */
export function signToken(payload: Record<string, unknown>, expiresInSec: number): string {
  const body = b64url(JSON.stringify({ ...payload, exp: now() + expiresInSec }))
  return `${body}.${hmac(body)}`
}

export function verifyToken(token: string): Record<string, any> | null {
  const dot = token.lastIndexOf('.')
  if (dot < 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(body)))) return null
    const payload = JSON.parse(unb64url(body))
    if (typeof payload.exp !== 'number' || payload.exp < now()) return null
    return payload
  } catch {
    return null
  }
}

/** Reply-by-email address: <slug>+r.<threadId>.<memberId>.<msgId>.<exp>.<sig>@collective.email */
export function replyAddress(slug: string, threadId: number, memberId: number, msgId: number): string {
  const exp = now() + 60 * 60 * 24 * 14 // reply links stay valid 14 days
  const payload = `r.${threadId}.${memberId}.${msgId}.${exp}`
  return `${slug}+${payload}.${hmac(`${slug}.${payload}`, 12)}@${cfg.emailDomain}`
}

export function parseReplyAddress(addr: string): { slug: string; threadId: number; memberId: number; msgId: number } | null {
  const m = addr.toLowerCase().trim().match(new RegExp(`^([a-z0-9-]+)\\+(r\\.(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+))\\.([a-f0-9]+)@${escapeRegex(cfg.emailDomain)}$`))
  if (!m) return null
  const [, slug, payload, th, mem, msg, exp, sig] = m
  if (hmac(`${slug}.${payload}`, 12) !== sig) return null
  if (Number(exp) < now()) return null
  return { slug, threadId: Number(th), memberId: Number(mem), msgId: Number(msg) }
}

/** Normalize a collective slug: what goes before the @. */
export function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function normalizeSubject(s: string): string {
  return (s || '').replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase()
}

export function excerpt(s: string, n = 140): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Strip quoted history from a plain-text email reply. Conservative: cut at the
 *  first "On … wrote:" line or at a trailing block of ">"-quoted lines. */
export function stripQuotedReply(text: string): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*On .{4,200}(wrote|schreef|a écrit)\s*:?\s*$/i.test(l) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(l)) {
      cut = i
      break
    }
    if (/^\s*>/.test(l)) {
      // start of a quoted block: only cut if everything after is quotes/blank
      const rest = lines.slice(i)
      if (rest.every((r) => /^\s*>/.test(r) || r.trim() === '')) {
        cut = i
        break
      }
    }
  }
  return lines.slice(0, cut).join('\n').trim()
}

/** Crude but dependency-free HTML → plain text (for HTML-only emails). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = now() - ts
  if (d < 0) return 'now'
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 14) return `${Math.floor(d / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function waitingFor(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = now() - ts
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export function initials(name: string, email?: string): string {
  const src = (name || email || '?').trim()
  const parts = src.split(/[\s.@_-]+/).filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}
