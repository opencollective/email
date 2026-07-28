/** Dev-only: threads whose counterpart is a member of the same collective (read-only). */
import { all } from '../src/db.js'
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const threads = await all<any>(`
  SELECT t.id, c.slug, t.subject, t.status, t.counterpart_email, t.assignee_member_id, t.created_at
  FROM threads t
  JOIN collectives c ON c.id = t.collective_id
  JOIN members m ON m.collective_id = c.id AND m.email = t.counterpart_email AND m.removed_at IS NULL
  ORDER BY t.id`)
for (const t of threads) {
  console.log(`thread ${t.id} [${t.slug}] "${t.subject}" status=${t.status} assignee=${t.assignee_member_id} from=${t.counterpart_email} created=${fmt(t.created_at)}`)
  const msgs = await all<any>('SELECT id, direction, from_email, in_reply_to, rfc822_message_id, sent_at, substr(body_text,1,70) AS p FROM messages WHERE thread_id = ? ORDER BY id', [t.id])
  for (const m of msgs) console.log(`  msg ${m.id} ${m.direction} ${fmt(m.sent_at)} from=${m.from_email}\n    mid=${m.rfc822_message_id}\n    irt=${m.in_reply_to}\n    "${(m.p || '').replace(/\n/g, ' ')}"`)
}
console.log('member-counterpart threads:', threads.length)
process.exit(0)
