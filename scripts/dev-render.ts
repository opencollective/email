/** Dev-only: render badge + OG cards to files for a visual check. */
import fs from 'node:fs'
import { ogApp, badgeState } from '../src/og.js'
import { signToken, now } from '../src/util.js'
import { createCollective, run, get } from '../src/db.js'

const out = process.argv[2]
const col = await createCollective(`r${Date.now() % 1000000}`, 'Render Co')
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'leen@t.test', 'Leen', 'admin', 'every', ?)", [col.id, now()])
const m = (await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id]))!
const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
  VALUES (?, 'R', 'needs_reply', 'x@y.t', ?, ?, 'inbound', ?, ?)`, [col.id, now()-7200, now()-7200, now()-7200, now()])
const tok = signToken({ a: 'aimg', th: Number(t.lastId) }, 3600)

const save = async (path: string, res: Response) => fs.writeFileSync(path, Buffer.from(await res.arrayBuffer()))
await save(`${out}/badge-unassigned.png`, await ogApp.request(`/aimg/${tok}`))
await run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [m.id, t.lastId])
await run("INSERT INTO events (thread_id, actor_member_id, type, created_at) VALUES (?, ?, 'assigned', ?)", [t.lastId, m.id, now() - 2580])
await save(`${out}/badge-assigned.png`, await ogApp.request(`/aimg/${tok}`))
await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
  VALUES (?, '<r@x>', 'outbound', 'a@b.c', '[]', 'ok', ?, ?, ?)`, [t.lastId, m.id, now() - 720, now()])
await run("UPDATE threads SET last_direction = 'outbound' WHERE id = ?", [t.lastId])
await save(`${out}/badge-answered.png`, await ogApp.request(`/aimg/${tok}`))
await save(`${out}/og-home.png`, await ogApp.request('/og/home.png'))
await save(`${out}/og-claim.png`, await ogApp.request('/og/claim.png?slug=citizencorner'))
await save(`${out}/og-about.png`, await ogApp.request('/og/about.png'))
console.log('rendered')
process.exit(0)
