/** One-off: inbound messages that were actually a member's own reply (arrived
 *  via the group) → outbound with sent_by_member_id; threads whose last
 *  message is such a reply flip to answered. Pass --write to apply. */
import { all, get, run } from '../src/db.js'
import { now } from '../src/util.js'

const write = process.argv.includes('--write')
const rows = await all<any>(`
  SELECT m.id, m.thread_id, m.from_email, m.sent_at, c.slug, mem.id AS member_id, t.status, t.assignee_member_id
  FROM messages m
  JOIN threads t ON t.id = m.thread_id
  JOIN collectives c ON c.id = t.collective_id
  JOIN members mem ON mem.collective_id = c.id AND mem.email = m.from_email AND mem.removed_at IS NULL
  WHERE m.direction = 'inbound'
    AND m.id != (SELECT MIN(m2.id) FROM messages m2 WHERE m2.thread_id = m.thread_id)
  ORDER BY m.id`)
for (const r of rows) {
  const isLast = !(await get('SELECT 1 FROM messages WHERE thread_id = ? AND id > ?', [r.thread_id, r.id]))
  console.log(`msg ${r.id} [${r.slug}] thread ${r.thread_id}: ${r.from_email} → outbound${isLast ? ' + thread answered' : ''}`)
  if (write) {
    await run("UPDATE messages SET direction = 'outbound', sent_by_member_id = ? WHERE id = ?", [r.member_id, r.id])
    if (isLast) {
      await run("UPDATE threads SET status = 'answered', last_direction = 'outbound', updated_at = ? WHERE id = ? AND status = 'needs_reply'", [now(), r.thread_id])
      if (!r.assignee_member_id) await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [r.member_id, r.thread_id])
    }
  }
}
console.log(`${rows.length} messages ${write ? 'converted' : 'would be converted (dry run — add --write)'}`)
process.exit(0)
