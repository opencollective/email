import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `cont${uniq()}`
  const collective = await createCollective(slug, 'Contacts Test')
  const email = `member-${uniq()}@example.org`
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, email, 'Xavier', 'admin', 'every', now()])
  const thread = async (from: string, name: string, subject: string, status = 'needs_reply', ago = 0) => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
      first_message_at, last_message_at, last_direction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', ?, ?)`,
      [collective.id, subject, status, from, name, now() - ago, now() - ago, now() - ago, now()])
    await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', ?, ?, '[]', ?, ?, ?)`,
      [t.lastId, `<c-${uniq()}@x>`, from, name, `body of ${subject}`, now() - ago, now()])
    return t.lastId
  }
  return { slug, collective, sid: await createSession(email), thread }
}

const page = (path: string, sid: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })

test('contacts: one row per sender, counts aggregated, spam excluded', async () => {
  const fx = await fixture()
  await fx.thread('marie@example.org', 'Marie Dupont', 'Room booking', 'needs_reply', 3600)
  await fx.thread('MARIE@example.org', 'Marie Dupont', 'Invoice', 'answered', 7200) // case-folded into the same contact
  await fx.thread('bob@example.org', 'Bob', 'Hello', 'answered', 60)
  await fx.thread('spammer@junk.test', 'Spam King', 'WIN NOW', 'spam', 30)

  const html = await (await page(`/inbox/${fx.slug}/contacts`, fx.sid)).text()
  assert.match(html, /Marie Dupont/)
  assert.match(html, /2 conversations/)
  assert.match(html, /1 waiting for a reply/)
  assert.match(html, /Bob/)
  assert.doesNotMatch(html, /Spam King/, 'spam senders are not contacts')
  assert.equal((html.match(/marie@example\.org/gi) || []).length >= 1, true)
})

test('contact view: only that sender\'s threads, with a compose shortcut', async () => {
  const fx = await fixture()
  const t1 = await fx.thread('marie@example.org', 'Marie Dupont', 'Room booking')
  await fx.thread('bob@example.org', 'Bob', 'Unrelated thing')

  const html = await (await page(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}`, fx.sid)).text()
  assert.match(html, /Room booking/)
  assert.doesNotMatch(html, /Unrelated thing/, 'other senders stay out')
  assert.match(html, new RegExp(`/thread/${t1}`), 'threads link through')
  assert.match(html, /compose\?to=marie%40example\.org/, 'one click to email them')
})

test('the sender on a thread links to their contact view', async () => {
  const fx = await fixture()
  const t1 = await fx.thread('marie@example.org', 'Marie Dupont', 'Room booking')
  const html = await (await page(`/inbox/${fx.slug}/thread/${t1}`, fx.sid)).text()
  assert.match(html, /contact\/marie%40example\.org/, 'both the message header and the sidebar point there')
})

test('compose ?to= prefills the recipient', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/compose?to=marie%40example.org`, fx.sid)).text()
  assert.match(html, /name="to" value="marie@example\.org"/)
})
