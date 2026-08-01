/** One-off: merge a duplicate thread into the original (same conversation split
 *  because a teammate's reply couldn't be threaded). Moves messages, notes,
 *  events and tags, re-points the counterpart if the original lacked one, and
 *  deletes the empty duplicate. Usage: merge-threads.ts <from> <into> [--write] */
import { all, get, run } from '../src/db.js'
import { now } from '../src/util.js'

const fromId = Number(process.argv[2])
const intoId = Number(process.argv[3])
const write = process.argv.includes('--write')
const a = await get<any>('SELECT * FROM threads WHERE id = ?', [fromId])
const b = await get<any>('SELECT * FROM threads WHERE id = ?', [intoId])
if (!a || !b) { console.error('thread not found'); process.exit(1) }
if (a.collective_id !== b.collective_id) { console.error('different collectives'); process.exit(1) }

const msgs = await all<any>('SELECT id, direction, sent_at FROM messages WHERE thread_id = ?', [fromId])
console.log(`merge thread ${fromId} ("${a.subject}", ${msgs.length} messages) → ${intoId} ("${b.subject}")`)
console.log(`  counterpart: ${b.counterpart_email || '(none)'} ${b.counterpart_email ? '' : `← taking ${a.counterpart_email}`}`)
const last = Math.max(a.last_message_at || 0, b.last_message_at || 0)
const lastMsg = await get<any>('SELECT direction FROM messages WHERE thread_id IN (?, ?) ORDER BY sent_at DESC, id DESC LIMIT 1', [fromId, intoId])
console.log(`  last message after merge: ${lastMsg?.direction} → status ${lastMsg?.direction === 'outbound' ? 'answered' : 'needs_reply'}`)

if (write) {
  await run('UPDATE messages SET thread_id = ? WHERE thread_id = ?', [intoId, fromId])
  await run('UPDATE notes SET thread_id = ? WHERE thread_id = ?', [intoId, fromId])
  await run('UPDATE events SET thread_id = ? WHERE thread_id = ?', [intoId, fromId])
  await run('INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) SELECT ?, tag_id FROM thread_tags WHERE thread_id = ?', [intoId, fromId])
  await run('DELETE FROM thread_tags WHERE thread_id = ?', [fromId])
  if (!b.counterpart_email && a.counterpart_email) {
    await run('UPDATE threads SET counterpart_email = ?, counterpart_name = ? WHERE id = ?', [a.counterpart_email, a.counterpart_name, intoId])
  }
  await run('UPDATE threads SET last_message_at = ?, last_direction = ?, status = ?, assignee_member_id = COALESCE(assignee_member_id, ?), updated_at = ? WHERE id = ?',
    [last, lastMsg?.direction ?? b.last_direction, lastMsg?.direction === 'outbound' ? 'answered' : 'needs_reply', a.assignee_member_id, now(), intoId])
  await run('DELETE FROM threads WHERE id = ?', [fromId])
  console.log('  ✓ merged')
} else {
  console.log('  dry run — add --write')
}
process.exit(0)
