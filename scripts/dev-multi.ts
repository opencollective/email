/** Dev-only: a member of two collectives, to view the chooser page. */
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
const email = 'multi@test.local'
for (const [slug, name] of [['commonshubdemo', 'Commons Hub Brussels'], ['xlcollectivedemo', 'XL Collective']] as const) {
  const col = (await get<any>('SELECT * FROM collectives WHERE slug = ?', [slug])) || await createCollective(slug, name)
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) SELECT ?, ?, 'Multi', 'admin', 'every', ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE collective_id = ? AND email = ?)", [col.id, email, now(), col.id, email])
}
console.log(await createSession(email))
process.exit(0)
