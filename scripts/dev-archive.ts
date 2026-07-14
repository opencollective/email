/** Dev-only: build a sample archive zip for a visual file:// check. */
import fs from 'node:fs'
import { buildArchive } from '../src/export.js'
import { createCollective, run, get } from '../src/db.js'
import { saveBlob } from '../src/storage.js'
import { now } from '../src/util.js'

const col = await createCollective(`demo${Date.now() % 100000}`, 'Demo Co')
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'leen@t.test', 'Leen', 'admin', 'every', ?)", [col.id, now()])
const member = (await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id]))!
for (const [i, subj] of ['Booking the space for a repair café', 'Press question about the opening', 'Volunteering on Saturdays'].entries()) {
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, ?, ?, 'ann@example.org', 'Ann', ?, ?, ?, ?, ?)`,
    [col.id, subj, i === 0 ? 'answered' : 'needs_reply', now() - 86400 * (i + 1), now() - 3600 * (i + 1), i === 0 ? 'outbound' : 'inbound', now(), now()])
  const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'ann@example.org', 'Ann', '[]', ?, ?, ?)`,
    [t.lastId, `<d${i}@x>`, `Hi!\n\nWe would love to ${subj.toLowerCase()}. Is next week possible?\n\nWarmly,\nAnn`, now() - 86400 * (i + 1), now()])
  if (i === 0) {
    await run("INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, 'I know Ann from the neighborhood assembly — taking this one.', ?)", [t.lastId, member.id, now() - 82000])
    await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
      VALUES (?, '<r0@x>', 'outbound', 'demo@collective.email', '[]', 'Hi Ann!\n\nSaturday works — the space is yours from 14:00. See you then!\n\n— Leen, for Demo Co', ?, ?, ?)`, [t.lastId, member.id, now() - 80000, now()])
    const loc = await saveBlob(`flyer-${Date.now()}.txt`, Buffer.from('REPAIR CAFE — every first Saturday'), 'text/plain')
    await run("INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, 'flyer.txt', 'text/plain', 34, ?)", [m.lastId, loc])
  }
}
const zip = await buildArchive((await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!)
fs.writeFileSync(process.argv[2], zip)
console.log('zip written', zip.length, 'bytes')
process.exit(0)
