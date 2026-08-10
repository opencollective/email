import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
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
const post = (path: string, sid: string, body: Record<string, string>) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
  body: new URLSearchParams(body),
})

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
  // a member replied and another left a note — both count as participants
  const m2 = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.collective.id, `leen-${uniq()}@example.org`, 'Leen', 'member', 'every', now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
    VALUES (?, ?, 'outbound', 'x@collective.email', '[]', 'On it!', ?, ?, ?)`, [t1, `<out-${uniq()}@x>`, m2.lastId, now(), now()])
  await run('INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [t1, m2.lastId, 'checking the calendar', now()])

  const html = await (await page(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}`, fx.sid)).text()
  assert.match(html, /Room booking/)
  assert.doesNotMatch(html, /Unrelated thing/, 'other senders stay out')
  assert.match(html, new RegExp(`/thread/${t1}`), 'threads link through')
  assert.match(html, /compose\?to=marie%40example\.org/, 'one click to email them')
  assert.match(html, /class="participants"/)
  assert.match(html, /title="Leen"/, 'the member who replied/noted shows as a participant')
  assert.match(html, /class="r-d1"/, 'first + last dates rendered')
  assert.match(html, /class="row no-sender/, 'the shared ThreadRow, sender column dropped')
  assert.match(html, /r-notes/, 'note count on the second line')
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

test('threads with a sender include ones where they were only Cc\'d', async () => {
  const fx = await fixture()
  const primary = await fx.thread('marie@example.org', 'Marie Dupont', 'Direct thread')
  // a thread whose counterpart is someone else, but Marie is on the Cc
  const other = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Cc thread', 'answered', 'bob@example.org', 'Bob', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, cc_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'bob@example.org', '["commonshub@collective.email"]', '["marie@example.org"]', 'fyi', ?, ?)`,
    [other.lastId, `<cc-${uniq()}@x>`, now(), now()])

  const html = await (await page(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}`, fx.sid)).text()
  assert.match(html, /Direct thread/)
  assert.match(html, /Cc thread/, 'the Cc-only thread shows up too')
  assert.match(html, new RegExp(`/thread/${other.lastId}`))
})

test('an admin can set who new threads from a contact auto-assign to', async () => {
  const fx = await fixture()
  await fx.thread('marie@example.org', 'Marie Dupont', 'Hi')
  const leen = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.collective.id, `leen-${uniq()}@example.org`, 'Leen', 'member', 'every', now()])

  // starts as nobody
  let html = await (await page(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}`, fx.sid)).text()
  assert.match(html, /New threads auto-assigned to\s*<span class="muted">nobody/)

  const set = await post(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}/auto-assign`, fx.sid, { member_id: String(leen.lastId) })
  assert.match(decodeURIComponent(set.headers.get('location')!), /will be assigned to Leen/)
  const rule = (await get<any>("SELECT * FROM rules WHERE collective_id = ? AND lower(match_from) = 'marie@example.org'", [fx.collective.id]))!
  assert.equal(rule.assign_member_id, leen.lastId)
  assert.equal(rule.close, 0, 'a pure auto-assign rule, never closes')

  // clearing removes it
  const clear = await post(`/inbox/${fx.slug}/contact/${encodeURIComponent('marie@example.org')}/auto-assign`, fx.sid, { member_id: '' })
  assert.match(decodeURIComponent(clear.headers.get('location')!), /no longer auto-assigned/)
  assert.equal(await get("SELECT id FROM rules WHERE collective_id = ? AND lower(match_from) = 'marie@example.org'", [fx.collective.id]), undefined)
})
