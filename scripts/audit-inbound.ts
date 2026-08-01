/** Dev-only: compare Resend's received-mail log with what we stored, so a
 *  dropped inbound message is visible. Needs RESEND_API_KEY. */
import { get } from '../src/db.js'

const key = process.env.RESEND_API_KEY
if (!key) { console.error('RESEND_API_KEY required'); process.exit(1) }
const limit = Number(process.argv[2] || 60)
const res = await fetch(`https://api.resend.com/emails/receiving?limit=${limit}`, { headers: { Authorization: `Bearer ${key}` } })
const data = await res.json() as { data: any[] }
let missing = 0
for (const e of data.data) {
  const stored = await get<any>('SELECT m.id, m.thread_id, m.direction FROM messages m WHERE m.rfc822_message_id = ?', [e.message_id])
    ?? await get<any>('SELECT id, thread_id, direction FROM messages WHERE resend_email_id = ?', [e.id])
  const mark = stored ? `stored msg ${stored.id} (thread ${stored.thread_id}, ${stored.direction})` : '❌ NOT STORED'
  if (!stored) missing++
  console.log(`${e.created_at}  ${String(e.from).padEnd(38)} → ${String(e.to).padEnd(34)} ${mark}`)
  if (!stored) console.log(`    subject: ${e.subject}\n    id=${e.id} mid=${e.message_id}`)
}
console.log(`\n${data.data.length} received, ${missing} not stored`)
process.exit(0)
