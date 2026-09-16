import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { cfg } from '../src/config.js'
import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { discountCodeFor } from '../src/claim.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`
const page = (sid: string, path = '/admin') => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })

test('ADMIN_EMAIL is a list: every address on it opens /admin, nobody else does', async () => {
  assert.deepEqual(cfg.adminEmails, ['admin@test.local', 'second-admin@test.local'], 'comma-separated, trimmed, lower-cased')
  for (const email of cfg.adminEmails) {
    assert.equal((await page(await createSession(email))).status, 200, email)
  }
  assert.equal((await page(await createSession(`nobody-${uniq()}@t.test`))).status, 404)
  const out = await app.request('/admin')
  assert.equal(out.status, 302)
  assert.equal(out.headers.get('location'), '/login?next=%2Fadmin')
})

test('the dashboard: stats, one row per collective with plan, start, traffic and days left, and a code generator', async () => {
  const sid = await createSession('second-admin@test.local')
  const slug = `dash${uniq()}`
  const col = await createCollective(slug, 'Dash Co', 'pro', { trialDays: 12 })
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, `a-${uniq()}@t.test`, 'A', 'admin', 'every', now()])
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Hello', 'answered', 'x@out.test', ?, ?, 'outbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'x@out.test', '[]', 'hi', ?, ?)`, [t.lastId, `<ad-${uniq()}@x>`, now() - 86400 * 3, now() - 86400 * 3])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'outbound', ?, '["x@out.test"]', 'hello back', ?, ?)`, [t.lastId, `<ad-${uniq()}@x>`, `${slug}@collective.email`, now() - 3600, now() - 3600])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'outbound', ?, '[]', 'draft', NULL, ?)`, [t.lastId, `<ad-${uniq()}@x>`, `${slug}@collective.email`, now()])

  const html = await (await page(sid)).text()
  assert.match(html, /admin-stats/)
  assert.match(html, /<small>collectives<\/small>/)
  const row = html.slice(html.indexOf(`<b>${slug}</b>`), html.indexOf(`<b>${slug}</b>`) + 800)
  assert.match(row, /Dash Co/)
  assert.match(row, /pro <span class="state state-trial">trial<\/span>/)
  const today = new Date().toISOString().slice(0, 10)
  const cells = [...row.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1])
  assert.deepEqual(cells.slice(0, 5), [today, '1', '1', today, new Date((now() - 86400 * 3) * 1000).toISOString().slice(0, 10)],
    'started · members · threads · last sent (the unsent draft does not count) · last received')
  assert.equal(cells[5], '12 d', 'days left in the trial')

  // the generator shows the code for exactly that slug, plan and length
  const gen = await (await page(sid, `/admin?dslug=${slug}&dmonths=6&dplan=pro`)).text()
  assert.match(gen, new RegExp(`<code class="invite-url">${discountCodeFor(slug, 6, 'pro')}</code>`))
  assert.match(gen, /6 months · pro/)
  const forever = await (await page(sid, `/admin?dslug=${slug}&dmonths=forever`)).text()
  assert.match(forever, new RegExp(discountCodeFor(slug, undefined, 'collective')))
  // and the noise is gone
  assert.doesNotMatch(html, /Waiting list|Create a collective|Issue credits/)
})
