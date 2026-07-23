import { cfg } from './config.js'
import { get, run } from './db.js'
import { now, randomCode, randomToken, sha256 } from './util.js'
import { sendLoginCode } from './notify.js'

const CODE_TTL = 10 * 60
const MAX_ATTEMPTS = 5
// A duplicate submit of a just-used code (double tap, iOS OTP autofill firing
// twice) should sign in again, not scare the user with "expired".
const REPLAY_WINDOW = 2 * 60

export interface LoginCodeRow {
  id: number
  email: string
  code_hash: string
  purpose: 'login' | 'join' | 'claim'
  invite_token: string | null
  claim_slug: string | null
  claim_ref: string | null
  join_name: string | null
  join_level: string | null
  attempts: number
  consumed_at: number | null
  expires_at: number
  created_at: number
}

/** Create a 6-digit code and deliver it. By default it's emailed to `email`;
 *  pass `deliver` to route it elsewhere (e.g. the Open Collective contact form
 *  for ownership verification) — the code is still stored under `email`, which
 *  is the login identity, so checkCode(email, code) works regardless of channel.
 *  Returns false when rate-limited or when delivery failed. */
export async function issueCode(
  email: string,
  purpose: 'login' | 'join' | 'claim',
  join?: { inviteToken?: string; name?: string; level?: string; claimSlug?: string; claimRef?: string },
  deliver?: (code: string) => Promise<boolean>,
): Promise<boolean> {
  const clean = email.toLowerCase().trim()
  const recent = await get<{ created_at: number }>('SELECT created_at FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [clean])
  if (recent && now() - recent.created_at < 30) return false

  const code = randomCode()
  await run('DELETE FROM login_codes WHERE email = ?', [clean])
  await run(`
    INSERT INTO login_codes (email, code_hash, purpose, invite_token, join_name, join_level, claim_slug, claim_ref, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [clean, sha256(code + cfg.secret), purpose, join?.inviteToken ?? null, join?.name ?? null, join?.level ?? null, join?.claimSlug ?? null, join?.claimRef ?? null, now() + CODE_TTL, now()])
  if (deliver) return deliver(code)
  await sendLoginCode(clean, code)
  return true
}

export type CheckResult =
  | { ok: true; row: LoginCodeRow; replay?: boolean }
  // `resend: true` = the code can't work anymore — offer a "send a new code" button.
  | { ok: false; error: string; resend?: boolean }

export async function checkCode(email: string, code: string): Promise<CheckResult> {
  const clean = email.toLowerCase().trim()
  const row = await get<LoginCodeRow>('SELECT * FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [clean])
  if (!row) return { ok: false, error: 'That code expired — request a new one.', resend: true }
  if (row.consumed_at) {
    if (now() - row.consumed_at < REPLAY_WINDOW && sha256(code.trim() + cfg.secret) === row.code_hash) return { ok: true, row, replay: true }
    return { ok: false, error: 'That code was already used — request a new one.', resend: true }
  }
  if (row.expires_at < now()) return { ok: false, error: 'That code expired — request a new one.', resend: true }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts — request a new code.', resend: true }
  await run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', [row.id])
  if (sha256(code.trim() + cfg.secret) !== row.code_hash) return { ok: false, error: 'That code is not right — check the email and try again.' }
  await run('UPDATE login_codes SET consumed_at = ? WHERE id = ?', [now(), row.id])
  return { ok: true, row }
}

/** Sessions carry the verified email — memberships are resolved per collective. */
export async function createSession(email: string): Promise<string> {
  const token = randomToken(32)
  await run('INSERT INTO sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, email.toLowerCase().trim(), now(), now() + cfg.sessionDays * 86400])
  return token
}

export async function emailFromSession(token: string | undefined): Promise<string | null> {
  if (!token) return null
  const s = await get<{ email: string; expires_at: number }>('SELECT email, expires_at FROM sessions WHERE token = ?', [token])
  if (!s || s.expires_at < now()) return null
  return s.email
}

export const destroySession = (token: string) => run('DELETE FROM sessions WHERE token = ?', [token])

export const destroyEmailSessions = (email: string) =>
  run('DELETE FROM sessions WHERE email = ?', [email.toLowerCase().trim()])
