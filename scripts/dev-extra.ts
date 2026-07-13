/** Dev-only: add a commenter member + fresh session for screenshot runs. */
import { run, get } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

const existing = await get("SELECT id FROM members WHERE email = 'leen@test.local'")
if (!existing) {
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (1, 'leen@test.local', 'Leen', 'commenter', 'daily', ?)", [now()])
}
console.log('SID=' + await createSession('x@test.local'))
process.exit(0)
