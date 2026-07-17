/** Dev-only: a few members with different roles for the members-page screenshot. */
import { run, get } from '../src/db.js'
import { now } from '../src/util.js'
for (const [email, name, role] of [['cedric@t.test','Cedric','member'],['inge@t.test','Inge Wiame','member'],['rita@t.test','Rita','reader']]) {
  const existing = await get('SELECT id FROM members WHERE email = ?', [email])
  if (!existing) await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (1, ?, ?, ?, ?, ?)', [email, name, role, 'every', now()])
}
console.log('ok')
process.exit(0)
