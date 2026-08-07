/** Dev-only: find a thread worth testing @mentions on — a collective where the
 *  given member can write notes and has teammates to mention. */
import { all } from '../src/db.js'

const me = (process.argv[2] || '').toLowerCase()

const rows = await all<{
  slug: string; cname: string; thread_id: number; subject: string; msgs: number
  my_role: string; mates: number; mate_names: string
}>(`
  SELECT c.slug, c.name AS cname, t.id AS thread_id, t.subject, t.last_message_at,
    (SELECT COUNT(*) FROM messages WHERE thread_id = t.id) AS msgs,
    me.role AS my_role,
    (SELECT COUNT(*) FROM members o WHERE o.collective_id = c.id AND o.removed_at IS NULL AND o.id != me.id) AS mates,
    (SELECT GROUP_CONCAT(COALESCE(NULLIF(o.name, ''), o.email), ', ') FROM members o
       WHERE o.collective_id = c.id AND o.removed_at IS NULL AND o.id != me.id) AS mate_names
  FROM threads t
  JOIN collectives c ON c.id = t.collective_id AND c.status = 'active'
  JOIN members me ON me.collective_id = c.id AND me.email = ? AND me.removed_at IS NULL
  ORDER BY mates DESC, msgs DESC, t.last_message_at DESC
  LIMIT 8`, [me])

for (const r of rows) {
  console.log(`${r.slug} (${r.cname}) — thread ${r.thread_id}: "${r.subject}"`)
  console.log(`   ${r.msgs} message(s) · you are ${r.my_role} · ${r.mates} teammate(s) to mention: ${r.mate_names || '—'}`)
  console.log(`   https://staging.collective.email/inbox/${r.slug}/thread/${r.thread_id}?pane=note#composer`)
}
if (!rows.length) console.log(`no threads found for ${me}`)
process.exit(0)
