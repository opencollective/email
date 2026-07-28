/** One-off prod adjustments (2026-07-28):
 *  1. Inge's member email → inge@commonshub.brussels (she reads/writes there);
 *     old address becomes an alias so past/future mail still counts as her.
 *  2. leenschelfhout@commonshub.brussels → alias of leen@commonshub.brussels,
 *     with attribution backfill.
 *  3. Internal member questions (threads 43/44) go back to unclaimed —
 *     a genuine question waits for a teammate.
 *  Pass --write to apply. */
import { all, get, run } from '../src/db.js'
import { now } from '../src/util.js'

const write = process.argv.includes('--write')
const col = (await get<any>("SELECT * FROM collectives WHERE slug = 'commonshub'"))!

const inge = await get<any>("SELECT * FROM members WHERE collective_id = ? AND email = 'inge@weavingwolves.earth'", [col.id])
if (inge) {
  console.log(`inge (member ${inge.id}): email → inge@commonshub.brussels, alias inge@weavingwolves.earth`)
  if (write) {
    await run("UPDATE members SET email = 'inge@commonshub.brussels' WHERE id = ?", [inge.id])
    await run('INSERT INTO member_aliases (collective_id, member_id, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(collective_id, email) DO UPDATE SET member_id = excluded.member_id',
      [col.id, inge.id, 'inge@weavingwolves.earth', now()])
  }
} else {
  console.log('inge already migrated')
}

const leen = await get<any>("SELECT * FROM members WHERE collective_id = ? AND email = 'leen@commonshub.brussels'", [col.id])
if (leen) {
  console.log(`leen (member ${leen.id}): alias leenschelfhout@commonshub.brussels + backfill`)
  if (write) {
    await run('INSERT INTO member_aliases (collective_id, member_id, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(collective_id, email) DO UPDATE SET member_id = excluded.member_id',
      [col.id, leen.id, 'leenschelfhout@commonshub.brussels', now()])
    await run(`UPDATE messages SET sent_by_member_id = ? WHERE sent_by_member_id IS NULL AND direction = 'outbound'
               AND from_email = 'leenschelfhout@commonshub.brussels' AND thread_id IN (SELECT id FROM threads WHERE collective_id = ?)`, [leen.id, col.id])
    await run('UPDATE threads SET assignee_member_id = ? WHERE collective_id = ? AND assignee_member_id IS NULL AND id IN (SELECT thread_id FROM messages WHERE from_email = ?)',
      [leen.id, col.id, 'leenschelfhout@commonshub.brussels'])
  }
}

const internals = await all<any>("SELECT id, subject, assignee_member_id FROM threads WHERE collective_id = ? AND id IN (43, 44)", [col.id])
for (const t of internals) {
  console.log(`thread ${t.id} "${t.subject}": unclaim (was ${t.assignee_member_id})`)
  if (write) await run('UPDATE threads SET assignee_member_id = NULL, updated_at = ? WHERE id = ?', [now(), t.id])
}
console.log(write ? 'applied' : 'dry run — add --write')
process.exit(0)
