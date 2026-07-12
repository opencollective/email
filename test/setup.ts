/** Imported FIRST by every test file (before any src module) so config.ts
 *  reads a clean, isolated environment: fresh tmp data dir, file-backed
 *  SQLite, no Resend key (all email logged, no network). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-'))
process.env.EMAIL_DOMAIN = 'collective.email'
process.env.ADMIN_EMAIL = 'admin@test.local'
process.env.BASE_URL = 'http://test.local'
process.env.SECRET = 'test-secret-000000000000000000000000000000000000'
delete process.env.RESEND_API_KEY
delete process.env.RESEND_WEBHOOK_SECRET
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
delete process.env.LIBSQL_URL
delete process.env.BLOB_READ_WRITE_TOKEN
delete process.env.VERCEL
delete process.env.STRIPE_SECRET_KEY
delete process.env.STRIPE_WEBHOOK_SECRET
delete process.env.CRON_SECRET

// keep test output readable: silence the dev email dumps
const origLog = console.log
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && (args[0].includes('[appmail:dev]') || args[0].includes('[outbound:dev]') || args[0].includes('[ingest]'))) return
  origLog(...args)
}
