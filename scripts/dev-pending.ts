/** Dev-only: a pending (reserved, unactivated) claim + session, to view /claim/:slug. */
import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

const slug = process.argv[2] || 'pendinggroup'
const col = await createCollective(slug, 'Pending Group', 'collective', { status: 'pending', trial: false })
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'p@test.local', 'Pat', 'admin', 'every', ?)", [col.id, now()])
console.log('SID=' + await createSession('p@test.local'))
process.exit(0)
