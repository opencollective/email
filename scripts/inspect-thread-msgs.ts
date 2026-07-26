/** Dev-only: dump threads + messages matching a subject substring (read-only). */
import { all } from '../src/db.js'
const q = process.argv[2] || 'Quotation'
const fmt = (ts: number) => new Date(ts * 1000).toISOString()
const threads = await all<any>(`
  SELECT t.*, c.slug FROM threads t JOIN collectives c ON c.id = t.collective_id
  WHERE t.subject LIKE '%' || ? || '%' ORDER BY t.id`, [q])
for (const t of threads) {
  console.log(`thread ${t.id} [${t.slug}] "${t.subject}" status=${t.status} counterpart=${t.counterpart_name} <${t.counterpart_email}> last=${fmt(t.last_message_at)}`)
  const msgs = await all<any>('SELECT id, direction, from_email, from_name, to_json, cc_json, rfc822_message_id, sent_at, substr(body_text,1,80) AS preview FROM messages WHERE thread_id = ? ORDER BY id', [t.id])
  for (const m of msgs) console.log(`  msg ${m.id} ${m.direction} ${fmt(m.sent_at)} from=${m.from_email} to=${m.to_json} cc=${m.cc_json}\n    mid=${m.rfc822_message_id}\n    "${(m.preview || '').replace(/\n/g, ' ')}"`)
}
console.log('threads:', threads.length)
process.exit(0)
