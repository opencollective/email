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
  const slug = `cm${uniq()}`
  const col = await createCollective(slug, 'Comment Co')
  const mk = async (name: string, role: string) => {
    const email = `${name.toLowerCase()}-${uniq()}@t.test`
    const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)', [col.id, email, name, role, 'every', now()])
    return { id: r.lastId, cookie: { cookie: `requests_sid=${await createSession(email)}` } }
  }
  const sender = await mk('Leen', 'member')
  const commenter = await mk('Friedger', 'commenter')
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Journalist query', 'needs_reply', 'cain@press.test', 'Cain Burdeau', ?, ?, 'inbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at) VALUES (?, ?, 'inbound', 'cain@press.test', 'Cain Burdeau', '[]', 'A question', ?, ?)`, [t.lastId, `<cm-${uniq()}@x>`, now(), now()])
  return { slug, threadId: t.lastId, sender, commenter }
}
const post = (path: string, cookie: Record<string, string>, fields: Record<string, string>) => app.request(path, {
  method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
})

test('a commenter writes notes or proposes a reply, is told so, and cannot close, spam or delete', async () => {
  const fx = await fixture()
  const url = `/inbox/${fx.slug}/thread/${fx.threadId}`
  const html = await (await app.request(url, { headers: fx.commenter.cookie })).text()
  assert.match(html, /data-tab="note"[^>]*>.*Internal note/s)
  assert.match(html, /data-tab="propose"[^>]*>.*Propose a reply/s)
  assert.match(html, /signed in as a <b>commenter<\/b>/)
  assert.doesNotMatch(html, /class="thread-actions"/)
  assert.doesNotMatch(html, /data-kbd="[csd]"/)
  assert.doesNotMatch(html, /mark as closed/)

  for (const [path, body] of [[`${url}/status`, { status: 'closed' }], [`${url}/status`, { status: 'spam' }], [`${url}/delete`, {}]] as const) {
    assert.equal((await post(path, fx.commenter.cookie, body)).status, 403, path)
  }
  const th = (await get<any>('SELECT status, deleted_at FROM threads WHERE id = ?', [fx.threadId]))!
  assert.equal(th.status, 'needs_reply')
  assert.equal(th.deleted_at, null)

  // the proposal reaches the senders, with "Use this draft"
  const res = await post(`${url}/propose`, fx.commenter.cookie, { body: 'Dear Cain, happy to talk.' })
  assert.match(decodeURIComponent(res.headers.get('location')!), /Reply proposed ✓/)
  const senderView = await (await app.request(url, { headers: fx.sender.cookie })).text()
  assert.match(senderView, /<b>Friedger<\/b> proposed a reply/)
  assert.match(senderView, /Use this draft/)
  assert.match(senderView, /class="thread-actions"/, 'senders keep the triage buttons')
  assert.doesNotMatch(senderView, /signed in as a/)
  // proposing again replaces, and the form comes back with their text
  await post(`${url}/propose`, fx.commenter.cookie, { body: 'Dear Cain, second try.' })
  assert.equal((await get<any>('SELECT COUNT(*) AS n FROM thread_drafts WHERE thread_id = ?', [fx.threadId]))!.n, 1)
  assert.match(await (await app.request(url, { headers: fx.commenter.cookie })).text(), /data-draft="propose" required="">Dear Cain, second try\./)
})

test('the thread header keeps people and chips on one line each', async () => {
  const fx = await fixture()
  const html = await (await app.request(`/inbox/${fx.slug}/thread/${fx.threadId}`, { headers: fx.sender.cookie })).text()
  const sub = html.slice(html.indexOf('class="thread-sub"'), html.indexOf('class="tag-add"'))
  assert.match(sub, /<div class="chip-scroll">/, 'status, assignee and tags scroll sideways; + tag stays put after them')
})
