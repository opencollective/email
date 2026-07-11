import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const env = (k: string, d = '') => process.env[k] ?? d

const isVercel = !!process.env.VERCEL
const dataDir = path.resolve(env('DATA_DIR', isVercel ? '/tmp/data' : './data'))
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true })

// A stable secret signs sessions and one-click action tokens.
// Provided via SECRET, or generated once and persisted in the data dir.
// On serverless there is no persistent disk: SECRET must be set explicitly,
// otherwise sessions and signed links would break on every cold start.
let secret = env('SECRET')
if (!secret) {
  if (isVercel) throw new Error('SECRET env var is required on Vercel (no persistent disk to store a generated one).')
  const f = path.join(dataDir, '.secret')
  if (fs.existsSync(f)) {
    secret = fs.readFileSync(f, 'utf8').trim()
  } else {
    secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(f, secret, { mode: 0o600 })
  }
}

const emailDomain = env('EMAIL_DOMAIN', 'collective.email').toLowerCase()

export const cfg = {
  port: Number(env('PORT', '3000')),
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  dataDir,
  secret,
  isVercel,
  /** libSQL database: Turso URL in production, a local file otherwise. */
  dbUrl: env('LIBSQL_URL') || env('TURSO_DATABASE_URL') || `file:${path.join(dataDir, 'requests.db')}`,
  dbAuthToken: env('LIBSQL_AUTH_TOKEN') || env('TURSO_AUTH_TOKEN') || undefined,
  /** Vercel Blob token: when set, attachments go to Blob storage instead of local disk. */
  blobToken: env('BLOB_READ_WRITE_TOKEN'),
  cronSecret: env('CRON_SECRET'),
  /** The domain all collective addresses live on: <slug>@collective.email */
  emailDomain,
  /** Platform admin: can access /admin and convert waitlist entries into collectives. */
  adminEmail: env('ADMIN_EMAIL').toLowerCase().trim(),
  resendKey: env('RESEND_API_KEY'),
  /** Sender for app emails (login codes, notifications, digests). Must be on a Resend-verified domain. */
  resendFrom: env('RESEND_FROM', `collective.email <notifications@${emailDomain}>`),
  /** Signing secret of the Resend webhook endpoint (svix, `whsec_…`). Empty disables verification (dev only). */
  resendWebhookSecret: env('RESEND_WEBHOOK_SECRET'),
  /** Stripe (test keys on staging): unset → billing shows the free-preview card. */
  stripeKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  digestHour: Number(env('DIGEST_HOUR', '8')), // local hour (TZ env) for daily/weekly digests
  signReplies: env('SIGN_REPLIES', 'true') !== 'false',
  sessionDays: 90, // "logged in for 3 months unless explicit logout"
  inviteHours: 24, // invite links expire after 24h
}

export function warnMissingConfig() {
  const notes: string[] = []
  if (!cfg.resendKey) notes.push('RESEND_API_KEY not set — all email (login codes, notifications, replies, inbound fetch) is disabled; emails are logged to stdout.')
  if (!cfg.resendWebhookSecret) notes.push('RESEND_WEBHOOK_SECRET not set — inbound webhook signatures are NOT verified. Fine in dev, not in production.')
  if (!cfg.adminEmail) notes.push('ADMIN_EMAIL not set — nobody can access /admin to create collectives.')
  if (isVercel && cfg.dbUrl.startsWith('file:')) notes.push('Running on Vercel without TURSO_DATABASE_URL — the file: database lives in /tmp and WILL be lost between invocations.')
  if (isVercel && !cfg.blobToken) notes.push('Running on Vercel without BLOB_READ_WRITE_TOKEN — attachments in /tmp WILL be lost between invocations.')
  for (const n of notes) console.warn(`[config] ${n}`)
}
