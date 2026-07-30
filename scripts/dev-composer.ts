/** Dev-only: a thread with a Cc already set, to view the composer. */
import { simpleParser } from 'mailparser'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { ingestInbound } from '../src/ingest.js'
import { now } from '../src/util.js'
const col = (await get<any>("SELECT * FROM collectives WHERE slug = 'composerdemo'")) || await createCollective('composerdemo', 'Commons Hub Brussels')
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) SELECT ?, 'leen@test.local', 'Leen', 'member', 'every', ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE collective_id = ? AND email = 'leen@test.local')", [col.id, now(), col.id])
await ingestInbound(col, await simpleParser([
  'From: Rūta <ruta@europeancorrespondent.test>',
  'To: composerdemo@collective.email',
  'Subject: Quotation for the event spaces',
  `Message-ID: <c-${Date.now()}@x.test>`,
  '', 'Dear Cédric,\n\nAny updates on my request above?\n\nBest,\nRuta',
].join('\r\n')))
const t = await get<any>('SELECT id FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [col.id])
await run("UPDATE threads SET cc_json = ? WHERE id = ?", [JSON.stringify(['carla@europeancorrespondent.test']), t.id])
console.log('THREAD=' + t.id)
console.log('SID=' + await createSession('leen@test.local'))
process.exit(0)
