import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, kvGet, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { purgeDeletedTick } from '../src/archive.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `del${uniq()}`
  const collective = await createCollective(slug, 'Delete Co')
  const email = `admin-${uniq()}@example.org`
  const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, email, 'Xavier', 'admin', 'every', now()])
  const mk = async (subj: string) => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', 'x@y.test', ?, ?, 'inbound', ?, ?)`, [collective.id, subj, now(), now(), now(), now()])
    await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', 'x@y.test', '[]', 'hello there', ?, ?)`, [t.lastId, `<d${uniq()}@x>`, now(), now()])
    return t.lastId
  }
  return { slug, collective, memberId: r.lastId, sid: await createSession(email), t1: await mk('Doomed thread'), t2: await mk('Living thread') }
}
const page = (path: string, sid: string, extra: Record<string, string> = {}) =>
  app.request(path, { headers: { cookie: `requests_sid=${sid}`, ...extra } })
const post = (path: string, sid: string) => app.request(path, { method: 'POST', headers: { cookie: `requests_sid=${sid}` } })

test('the inbox remembers the last filter a member chose — but not prefetches, spam or deleted', async () => {
  const fx = await fixture()
  // default before any choice
  let html = await (await page(`/inbox/${fx.slug}`, fx.sid)).text()
  assert.match(html, /Doomed thread/)
  assert.equal(await kvGet(`lastfilter:${fx.memberId}`), null, 'a bare visit records nothing')

  await page(`/inbox/${fx.slug}?f=all`, fx.sid)
  assert.equal(await kvGet(`lastfilter:${fx.memberId}`), 'all', 'an explicit choice sticks')
  html = await (await page(`/inbox/${fx.slug}`, fx.sid)).text()
  assert.match(html.slice(html.indexOf('tag-bar')), /class="chip tag-chip on"[^>]*f=all/, 'the bare inbox opens on it next time')

  // a prefetch (pill warming, speculation rules) never counts as choosing
  await page(`/inbox/${fx.slug}?f=closed`, fx.sid, { 'x-prefetch': '1' })
  assert.equal(await kvGet(`lastfilter:${fx.memberId}`), 'all')
  await page(`/inbox/${fx.slug}?f=closed`, fx.sid, { 'sec-purpose': 'prefetch;prerender' })
  assert.equal(await kvGet(`lastfilter:${fx.memberId}`), 'all')
  // spam and deleted are visits, not homes
  await page(`/inbox/${fx.slug}?f=deleted`, fx.sid)
  await page(`/inbox/${fx.slug}?f=spam`, fx.sid)
  assert.equal(await kvGet(`lastfilter:${fx.memberId}`), 'all')
})

test('a deleted thread leaves every list for the Deleted view, wears the tag, and restores', async () => {
  const fx = await fixture()
  const r = await post(`/inbox/${fx.slug}/thread/${fx.t1}/delete`, fx.sid)
  assert.equal(r.status, 302)

  const inbox = await (await page(`/inbox/${fx.slug}?f=all`, fx.sid)).text()
  assert.doesNotMatch(inbox, /Doomed thread/, 'gone from the living inbox')
  assert.match(inbox.slice(inbox.indexOf('tag-bar'), inbox.indexOf('<dialog')), />deleted <span class="count">1<\/span>/, 'the deleted pill appears with its count')

  const deleted = await (await page(`/inbox/${fx.slug}?f=deleted`, fx.sid)).text()
  assert.match(deleted, /Doomed thread/)
  assert.match(deleted, /stay here for <b>30 days<\/b>/, 'the view explains the 30-day window')
  assert.match(deleted, /class="chip deleted-tag"/, 'rows wear the deleted tag')
  assert.doesNotMatch(deleted, /Living thread/)

  // the thread page offers restore, and restore brings everything back
  const tp = await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, fx.sid)).text()
  assert.match(tp, /removed permanently on/)
  assert.match(tp, /Restore thread/)
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/restore`, fx.sid)
  const back = await (await page(`/inbox/${fx.slug}?f=all`, fx.sid)).text()
  assert.match(back, /Doomed thread/)
  assert.equal((await get<any>('SELECT deleted_at FROM threads WHERE id = ?', [fx.t1]))!.deleted_at, null)
})

test('after 30 days the purge removes a deleted thread for good — and only then', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/delete`, fx.sid)
  await purgeDeletedTick()
  assert.ok(await get('SELECT id FROM threads WHERE id = ?', [fx.t1]), 'fresh deletions survive the tick')

  await run('UPDATE threads SET deleted_at = ? WHERE id = ?', [now() - 31 * 86400, fx.t1])
  await purgeDeletedTick()
  assert.equal(await get('SELECT id FROM threads WHERE id = ?', [fx.t1]), undefined, 'past the window it is gone')
  assert.equal((await all('SELECT * FROM messages WHERE thread_id = ?', [fx.t1])).length, 0, 'and its messages with it')
  assert.ok(await get('SELECT id FROM threads WHERE id = ?', [fx.t2]), 'the living thread is untouched')
})
