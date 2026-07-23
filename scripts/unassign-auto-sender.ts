/** One-off: clear auto_sender assignments on commonshub threads that were
 *  lumped onto one member because group forwards all looked like the same
 *  sender. Only touches threads still awaiting a reply whose ONLY assignment
 *  event is the automatic one (nobody manually claimed or re-assigned).
 *  Pass --write to apply; default dry run. */
import { all, run } from '../src/db.js'
import { now as ts } from '../src/util.js'

const write = process.argv.includes('--write')
const rows = await all<any>(`
  SELECT t.id, t.subject, t.assignee_member_id
  FROM threads t JOIN collectives c ON c.id = t.collective_id
  WHERE c.slug = 'commonshub' AND t.assignee_member_id IS NOT NULL AND t.status = 'needs_reply'
    AND (SELECT COUNT(*) FROM events e WHERE e.thread_id = t.id AND e.type IN ('assigned', 'unassigned')) = 1
    AND EXISTS (SELECT 1 FROM events e WHERE e.thread_id = t.id AND e.type = 'assigned' AND e.data_json LIKE '%auto_sender%')`)
for (const r of rows) {
  console.log(`thread ${r.id} (assignee ${r.assignee_member_id}): ${r.subject}`)
  if (write) {
    await run('UPDATE threads SET assignee_member_id = NULL, updated_at = ? WHERE id = ?', [ts(), r.id])
    await run('DELETE FROM events WHERE thread_id = ? AND type = ?', [r.id, 'assigned'])
  }
}
console.log(`${rows.length} threads ${write ? 'unassigned' : 'would be unassigned (dry run — add --write)'}`)
process.exit(0)
