/** Dev-only: many threads so the inbox page scrolls. */
import { run } from '../src/db.js'
import { now } from '../src/util.js'
for (let i = 0; i < 30; i++) {
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (1, 'Thread number ${'${i}'}', 'needs_reply', 'p@x.t', ?, ?, 'inbound', ?, ?)`, [now()-i*100, now()-i*100, now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, '<m${'${i}'}@x>', 'inbound', 'p@x.t', '[]', 'hello', ?, ?)`, [t.lastId, now(), now()])
}
console.log('seeded')
process.exit(0)
