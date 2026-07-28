/** One-off: re-apply the team-sender semantics to already-ingested messages.
 *  Inbound messages whose sender is the team (exact member email, or an alias
 *  on the collective's custom domain) become outbound answers; threads they
 *  opened point at the external recipient; team threads get an owner.
 *  Pass --write to apply; default dry run. */
import { all, get, run } from '../src/db.js'
import { teamSender, externalRecipient } from '../src/ingest.js'
import { now } from '../src/util.js'

const write = process.argv.includes('--write')
const collectives = await all<any>('SELECT * FROM collectives')
let changes = 0
for (const col of collectives) {
  const msgs = await all<any>(`
    SELECT m.*, t.status AS t_status, t.assignee_member_id, t.counterpart_email
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.collective_id = ? AND m.direction = 'inbound' ORDER BY m.id`, [col.id])
  for (const m of msgs) {
    const { team, member } = await teamSender(col, m.from_email || '')
    if (!team) continue
    const first = await get<any>('SELECT id FROM messages WHERE thread_id = ? ORDER BY id LIMIT 1', [m.thread_id])
    const isFirst = first!.id === m.id
    const isLast = !(await get('SELECT 1 FROM messages WHERE thread_id = ? AND id > ?', [m.thread_id, m.id]))
    const recipients = [...JSON.parse(m.to_json || '[]'), ...JSON.parse(m.cc_json || '[]')].map((a: string) => ({ address: a, name: '' }))
    const ext = isFirst && m.in_reply_to ? await externalRecipient(col, recipients) : undefined
    const isAnswer = !isFirst || !!ext

    const acts: string[] = []
    if (isAnswer) {
      acts.push('→ outbound' + (member ? ` (by ${member.email})` : ''))
      if (write) await run("UPDATE messages SET direction = 'outbound', sent_by_member_id = ? WHERE id = ?", [member?.id ?? null, m.id])
      if (ext && m.counterpart_email === m.from_email) {
        acts.push(`counterpart → ${ext.address}`)
        if (write) await run('UPDATE threads SET counterpart_email = ?, counterpart_name = NULL WHERE id = ?', [ext.address, m.thread_id])
      }
      if (isLast && m.t_status === 'needs_reply') {
        acts.push('answered')
        if (write) await run("UPDATE threads SET status = 'answered', last_direction = 'outbound', updated_at = ? WHERE id = ?", [now(), m.thread_id])
      }
    }
    if (member && !m.assignee_member_id) {
      acts.push(`assign ${member.email}`)
      if (write) await run('UPDATE threads SET assignee_member_id = ? WHERE id = ? AND assignee_member_id IS NULL', [member.id, m.thread_id])
    }
    if (acts.length) { changes++; console.log(`[${col.slug}] thread ${m.thread_id} msg ${m.id} from=${m.from_email}: ${acts.join(', ')}`) }
  }
}
console.log(`${changes} messages ${write ? 'repaired' : 'would change (dry run — add --write)'}`)
process.exit(0)
