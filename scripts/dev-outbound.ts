/** Dev-only: record an outbound reply on the composer demo thread. */
import { get, run } from '../src/db.js'
import { now } from '../src/util.js'
const t = await get<any>("SELECT t.id, t.collective_id FROM threads t JOIN collectives c ON c.id = t.collective_id WHERE c.slug = 'composerdemo' ORDER BY t.id DESC LIMIT 1")
const m = await get<any>('SELECT id FROM members WHERE collective_id = ? LIMIT 1', [t.collective_id])
await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, cc_json, body_text, sent_by_member_id, sent_at, created_at)
  VALUES (?, ?, 'outbound', 'composerdemo@collective.email', 'Commons Hub Brussels', ?, '[]', ?, ?, ?, ?)`,
  [t.id, `<out-${Date.now()}@x>`, JSON.stringify(['ruta@europeancorrespondent.test']),
   'Hi Rūta,\n\nHere is the quote.\n\n— Leen, for Commons Hub Brussels', m.id, now(), now()])
console.log('ok', t.id)
process.exit(0)
