/** Dev-only: dump one thread with all messages/events (read-only). */
import { all, get } from '../src/db.js'
const id = Number(process.argv[2])
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const t = await get<any>('SELECT t.*, c.slug FROM threads t JOIN collectives c ON c.id = t.collective_id WHERE t.id = ?', [id])
console.log(`thread ${t.id} [${t.slug}] "${t.subject}"\n  status=${t.status} assignee=${t.assignee_member_id} counterpart=${t.counterpart_name} <${t.counterpart_email}> cc=${t.cc_json} last=${fmt(t.last_message_at)}`)
for (const m of await all<any>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id', [id])) {
  console.log(`  msg ${m.id} ${m.direction} ${fmt(m.sent_at)} from=${m.from_name} <${m.from_email}> by_member=${m.sent_by_member_id}`)
  console.log(`    to=${m.to_json} cc=${m.cc_json}`)
  console.log(`    mid=${m.rfc822_message_id}\n    irt=${m.in_reply_to}`)
  console.log(`    "${(m.body_text || '').slice(0, 90).replace(/\n/g, ' ')}"`)
}
for (const e of await all<any>('SELECT * FROM events WHERE thread_id = ? ORDER BY id', [id])) {
  console.log(`  event ${fmt(e.created_at)} ${e.type} actor=${e.actor_member_id} ${e.data_json || ''}`)
}
process.exit(0)
