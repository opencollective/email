/** One-off: create the comped `contribute` collective with Xavier as admin. */
import { createCollective, getCollectiveBySlug, run } from '../src/db.js'
import { now } from '../src/util.js'

const ADMIN = 'xdamman@opencollective.com'
const existing = await getCollectiveBySlug('contribute')
if (existing) {
  console.log(`contribute@ already exists (id ${existing.id}, status ${existing.status})`)
} else {
  const col = await createCollective('contribute', 'Contribute — collective.email', 'collective', { trial: false })
  await run('UPDATE collectives SET comped = 1 WHERE id = ?', [col.id])
  await run(`INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Xavier', 'admin', 'every', ?)`,
    [col.id, ADMIN, now()])
  console.log(`created contribute@ (id ${col.id}), admin ${ADMIN}`)
}
process.exit(0)
