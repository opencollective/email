/** Dev-only: find threads whose counterpart is the collective's own custom address (group-forward mislabels). */
import { all } from '../src/db.js'
const rows = await all<any>(`
  SELECT t.id, c.slug, t.subject, t.counterpart_email, t.counterpart_name, t.assignee_member_id, t.status,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS n,
         (SELECT m.resend_email_id FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.id LIMIT 1) AS first_resend_id
  FROM threads t JOIN collectives c ON c.id = t.collective_id
  WHERE c.custom_domain IS NOT NULL AND t.counterpart_email = lower(c.custom_local || '@' || c.custom_domain)
  ORDER BY t.id`)
for (const r of rows) console.log(JSON.stringify(r))
console.log('total:', rows.length)
process.exit(0)
