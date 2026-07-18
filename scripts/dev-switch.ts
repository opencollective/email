/** Dev-only: two mailboxes for x@test.local with threads + assignments, for the switcher. */
import { createCollective, getCollectiveBySlug, run, get } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

async function ensure(slug: string, name: string) {
  let c = await getCollectiveBySlug(slug)
  if (!c) c = await createCollective(slug, name)
  const existing = await get<{ id: number }>('SELECT id FROM members WHERE collective_id = ? AND email = ?', [c.id, 'x@test.local'])
  const memberId = existing?.id ?? Number((await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'x@test.local', 'Xavier', 'admin', 'every', ?)", [c.id, now()])).lastId)
  return { id: c.id, memberId }
}

async function seedThreads(colId: number, memberId: number, waiting: number, mine: number) {
  for (let i = 0; i < waiting; i++) {
    await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', 'p@x.t', ?, ?, 'inbound', ?, ?)`, [colId, `Waiting ${i}-${colId}`, now(), now(), now(), now()])
  }
  for (let i = 0; i < mine; i++) {
    await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, assignee_member_id, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', 'p@x.t', ?, ?, ?, 'inbound', ?, ?)`, [colId, `Mine ${i}-${colId}`, memberId, now(), now(), now(), now()])
  }
}

const a = await ensure('commonshub', 'Commons Hub Brussels')
const b = await ensure('citizenspring', 'Citizen Spring')
await seedThreads(a.id, a.memberId, 3, 2)
await seedThreads(b.id, b.memberId, 5, 1)
console.log('SID=' + await createSession('x@test.local'))
process.exit(0)
