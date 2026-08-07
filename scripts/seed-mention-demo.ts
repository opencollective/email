/** Seed a staging thread for testing @mentions.
 *
 *  Teammates are plus-addressed variants of the operator's own address, so the
 *  mention notifications are actually delivered (to their inbox) and nothing
 *  bounces on the shared Resend reputation. Idempotent: re-running reuses the
 *  members and adds one fresh thread. */
import { all, get, getCollectiveBySlug, run } from '../src/db.js'
import { now } from '../src/util.js'

const slug = process.argv[2] || 'commonshub'
const owner = process.argv[3]
if (!owner) { console.error('usage: seed-mention-demo <slug> <your@email>'); process.exit(1) }

const [local, domain] = owner.split('@')
const col = await getCollectiveBySlug(slug)
if (!col) { console.error(`no collective "${slug}"`); process.exit(1) }

const mates = [
  { email: `${local}+leen@${domain}`, name: 'Leen Schelfhout', role: 'member' },
  { email: `${local}+inge@${domain}`, name: 'Inge Vermeulen', role: 'commenter' },
]
for (const m of mates) {
  const existing = await get<{ id: number }>('SELECT id FROM members WHERE collective_id = ? AND email = ?', [col.id, m.email])
  if (existing) {
    await run('UPDATE members SET removed_at = NULL, name = ?, role = ? WHERE id = ?', [m.name, m.role, existing.id])
    console.log(`member kept: ${m.name} <${m.email}>`)
  } else {
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [col.id, m.email, m.name, m.role, 'every', now()])
    console.log(`member added: ${m.name} <${m.email}> (${m.role})`)
  }
}

const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
  first_message_at, last_message_at, last_direction, created_at, updated_at)
  VALUES (?, ?, 'needs_reply', 'marie.dupont@example.org', 'Marie Dupont', ?, ?, 'inbound', ?, ?)`,
  [col.id, 'Booking the big room for a repair café in September', now() - 86400, now() - 5400, now() - 86400, now()])

const msgs = [
  [`Hello!

We run a monthly repair café and we're looking for a bigger space for the September edition — we expect about 60 people and we need tables we can put tools on.

Is the big room free on Saturday the 12th, from 13:00 to 18:00? And is there a fee for non-profits?

Thanks a lot,
Marie`, 86400],
  [`Sorry, one more thing I forgot: we'd need access from 11:00 to set up, if that's possible.

Marie`, 5400],
]
for (const [body, ago] of msgs) {
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'marie.dupont@example.org', 'Marie Dupont', ?, ?, ?, ?)`,
    [t.lastId, `<seed-${Date.now()}-${ago}@example.org>`, JSON.stringify([`${col.slug}@collective.email`]), body, now() - Number(ago), now()])
}

console.log(`\nthread ${t.lastId}: "Booking the big room for a repair café in September"`)
console.log(`https://staging.collective.email/inbox/${col.slug}/thread/${t.lastId}`)
console.log('\nactive members now:')
for (const m of await all<any>('SELECT name, email, role FROM members WHERE collective_id = ? AND removed_at IS NULL ORDER BY name', [col.id])) {
  console.log(`  ${m.name} <${m.email}> — ${m.role}`)
}
process.exit(0)
