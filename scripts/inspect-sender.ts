/** Dev-only: all messages from a given address, with their thread context (read-only). */
import { all } from '../src/db.js'
const email = process.argv[2]
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const msgs = await all<any>(`
  SELECT m.id, m.thread_id, m.direction, m.in_reply_to, m.to_json, m.cc_json, m.sent_at,
         t.subject, t.status, t.assignee_member_id, t.counterpart_email, c.slug,
         substr(m.body_text,1,60) AS p
  FROM messages m JOIN threads t ON t.id = m.thread_id JOIN collectives c ON c.id = t.collective_id
  WHERE m.from_email = ? ORDER BY m.id`, [email])
for (const m of msgs) {
  console.log(`msg ${m.id} ${m.direction} ${fmt(m.sent_at)} [${m.slug}] thread ${m.thread_id} "${m.subject}" (${m.status}, assignee=${m.assignee_member_id}, counterpart=${m.counterpart_email})`)
  console.log(`  to=${m.to_json} cc=${m.cc_json} irt=${m.in_reply_to}`)
  console.log(`  "${(m.p || '').replace(/\n/g, ' ')}"`)
}
console.log('total:', msgs.length)
process.exit(0)
