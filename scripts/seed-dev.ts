import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

const col = await createCollective('commonshub', 'Commons Hub', 'collective')
await run(`INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'x@test.local', 'Xavier', 'admin', 'every', ?)`, [col.id, now()])
const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
  VALUES (?, 'Booking the space for a repair café', 'answered', 'ann@example.org', 'Ann', ?, ?, 'outbound', ?, ?)`, [col.id, now()-86400, now()-3600, now()-86400, now()])
await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at) VALUES (?, '<a@x>', 'inbound', 'ann@example.org', '[]', 'Hi! Can we book the space next Saturday?', ?, ?)`, [t.lastId, now()-86400, now()-86400])
console.log('SID=' + await createSession('x@test.local'))
process.exit(0)
