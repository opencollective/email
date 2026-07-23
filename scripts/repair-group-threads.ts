/** One-off repair: threads mislabeled with the collective's own custom address
 *  as counterpart (Google-group forwards ingested before effectiveSender).
 *  Re-fetches the raw MIME from Resend, re-derives the real author, and fixes
 *  threads.counterpart_* and messages.from_*. Run with RESEND_API_KEY set.
 *  Pass --write to apply; default is a dry run. */
import { simpleParser } from 'mailparser'
import { all, run } from '../src/db.js'
import { effectiveSender } from '../src/ingest.js'

const write = process.argv.includes('--write')
const key = process.env.RESEND_API_KEY
if (!key) { console.error('RESEND_API_KEY required'); process.exit(1) }

const collectives = await all<any>("SELECT * FROM collectives WHERE custom_domain IS NOT NULL")
for (const col of collectives) {
  const ownAddr = `${col.custom_local}@${col.custom_domain}`.toLowerCase()
  const msgs = await all<any>(`
    SELECT m.id, m.thread_id, m.resend_email_id FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.collective_id = ? AND m.direction = 'inbound' AND m.from_email = ? AND m.resend_email_id IS NOT NULL
    ORDER BY m.id`, [col.id, ownAddr])
  console.log(`${col.slug}: ${msgs.length} inbound messages recorded as ${ownAddr}`)
  for (const m of msgs) {
    const res = await fetch(`https://api.resend.com/emails/receiving/${m.resend_email_id}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) { console.log(`  msg ${m.id}: Resend fetch failed (${res.status}) — skipped`); continue }
    const data = await res.json() as any
    if (!data.raw?.download_url) { console.log(`  msg ${m.id}: no raw MIME — skipped`); continue }
    const rawRes = await fetch(data.raw.download_url)
    if (!rawRes.ok) { console.log(`  msg ${m.id}: raw download failed — skipped`); continue }
    const parsed = await simpleParser(Buffer.from(await rawRes.arrayBuffer()))
    const real = effectiveSender(parsed, col)
    if (!real.address || real.address === ownAddr) { console.log(`  msg ${m.id}: no better sender found — skipped`); continue }
    console.log(`  msg ${m.id} thread ${m.thread_id}: → ${real.name ? `${real.name} <${real.address}>` : real.address}`)
    if (write) {
      await run('UPDATE messages SET from_email = ?, from_name = ? WHERE id = ?', [real.address, real.name || null, m.id])
      await run('UPDATE threads SET counterpart_email = ?, counterpart_name = ? WHERE id = ? AND counterpart_email = ?',
        [real.address, real.name || null, m.thread_id, ownAddr])
    }
  }
}
console.log(write ? 'done (applied)' : 'dry run — re-run with --write to apply')
process.exit(0)
