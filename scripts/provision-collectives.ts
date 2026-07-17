/** One-off, idempotent: ensure the given slugs exist as comped (free) Pro
 *  collectives with a given admin. Safe to re-run. Bypasses the reserved-slug
 *  guard on purpose (these are platform-owned addresses). */
import { get, getCollectiveBySlug, run } from '../src/db.js'
import { now } from '../src/util.js'

const ADMIN = 'xdamman@gmail.com'
const SPECS: { slug: string; name: string }[] = [
  { slug: 'hello', name: 'collective.email' },
  { slug: 'xlcollective', name: 'XL Collective' },
]

for (const { slug, name } of SPECS) {
  let col = await getCollectiveBySlug(slug)
  if (!col) {
    const r = await run(
      "INSERT INTO collectives (slug, name, status, plan, comped, trial_ends_at, activated_at, created_at) VALUES (?, ?, 'active', 'pro', 1, NULL, ?, ?)",
      [slug, name, now(), now()],
    )
    col = (await get<any>('SELECT * FROM collectives WHERE id = ?', [r.lastId]))!
    console.log(`created ${slug}@collective.email (id ${col.id}) — comped Pro`)
  } else {
    await run("UPDATE collectives SET status = 'active', plan = 'pro', comped = 1, activated_at = COALESCE(activated_at, ?) WHERE id = ?", [now(), col.id])
    console.log(`updated ${slug}@collective.email (id ${col.id}) → active comped Pro`)
  }

  const member = await get<any>('SELECT id, role, removed_at FROM members WHERE collective_id = ? AND email = ?', [col.id, ADMIN])
  if (!member) {
    await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Xavier', 'admin', 'every', ?)", [col.id, ADMIN, now()])
    console.log(`  + added ${ADMIN} as admin`)
  } else {
    await run("UPDATE members SET role = 'admin', removed_at = NULL WHERE id = ?", [member.id])
    console.log(`  · ${ADMIN} confirmed admin`)
  }
}
process.exit(0)
