/** Dev-only: inspect commonshub state + recent inbound traffic. */
import { all, get } from '../src/db.js'
const col = await get<any>("SELECT id, slug, plan, status, custom_domain, custom_local, domain_status, receive_mode FROM collectives WHERE slug = 'commonshub'")
console.log('collective:', JSON.stringify(col))
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const threads = await all<any>('SELECT id, subject, counterpart_email, last_direction, created_at FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 8', [col.id])
console.log('recent threads:'); for (const t of threads) console.log(' ', t.id, fmt(t.created_at), JSON.stringify(t.subject), t.counterpart_email)
const msgs = await all<any>('SELECT m.id, m.direction, m.from_email, substr(m.body_text,1,60) AS preview, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ? ORDER BY m.id DESC LIMIT 8', [col.id])
console.log('recent messages:'); for (const m of msgs) console.log(' ', m.id, m.direction, fmt(m.created_at), m.from_email, JSON.stringify(m.preview))
process.exit(0)
