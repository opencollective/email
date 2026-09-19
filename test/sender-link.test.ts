import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

test('linking an unattributed answer to a member is only offered when the name matches one', async () => {
  const slug = `sl${uniq()}`
  const col = await createCollective(slug, 'Link Co')
  const admin = `adm-${uniq()}@t.test`
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Bruno', 'admin', 'every', ?)", [col.id, admin, now()])
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Liève Poulis', 'member', 'every', ?)", [col.id, `lieve-${uniq()}@t.test`, now()])
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Zaal', 'answered', 'vincent@out.test', ?, ?, 'outbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  const msg = (from: string, name: string) => run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'outbound', ?, ?, '["vincent@out.test"]', 'answer', ?, ?)`, [t.lastId, `<sl-${uniq()}@x>`, from, name, now(), now()])
  await msg('lieve@moralambition.test', 'Lieve Poulis') // a member's name, from an address we don't know
  await msg('someone@elsewhere.test', 'Someone Else')  // nobody by that name here

  const html = await (await app.request(`/inbox/${slug}/thread/${t.lastId}`, { headers: { cookie: `requests_sid=${await createSession(admin)}` } })).text()
  // each card ends at its message body — the page after it is not the card
  const cards = html.split('class="person-card"').slice(1).map((c) => c.slice(0, c.indexOf('class="msg-body"')))
  const lieve = cards.find((c) => c.includes('lieve@moralambition.test'))!
  const other = cards.find((c) => c.includes('someone@elsewhere.test'))!
  assert.match(lieve, /Is this Liève Poulis\?/, 'the lookalike is named, accents and all')
  assert.match(lieve, /It.{0,6}s them/)
  assert.doesNotMatch(lieve, /<option/, 'one match: nothing to choose from')
  assert.doesNotMatch(other, /s them|Not a teammate|Is this/, 'a stranger gets no link prompt at all')
})
