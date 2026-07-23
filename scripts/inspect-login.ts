/** Dev-only: inspect recent login activity for one email (read-only). */
import { all } from '../src/db.js'
const email = process.argv[2] || 'xdamman@gmail.com'
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const codes = await all<any>('SELECT id, purpose, attempts, created_at, expires_at FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 5', [email])
console.log('login_codes:')
for (const r of codes) console.log(' ', r.id, r.purpose, 'attempts=' + r.attempts, 'created=' + fmt(r.created_at), 'expires=' + fmt(r.expires_at))
if (!codes.length) console.log('  (none — any issued code has been consumed or replaced)')
const sessions = await all<any>('SELECT id, created_at, expires_at FROM sessions WHERE email = ? ORDER BY id DESC LIMIT 5', [email])
console.log('sessions:')
for (const s of sessions) console.log(' ', s.id, 'created=' + fmt(s.created_at))
process.exit(0)
