import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { notifyInbound } from '../src/notify.js'
import { __observeAppMail, type AppMail } from '../src/appmail.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function capture(fn: () => Promise<unknown>): Promise<AppMail[]> {
  const mails: AppMail[] = []
  __observeAppMail((m) => mails.push(m))
  try { await fn() } finally { __observeAppMail(null) }
  return mails
}

test('"Assigned to me & mentions": quiet on new mail, emailed for their threads, mentions and hand-overs', async () => {
  const slug = `nl${uniq()}`
  const col = await createCollective(slug, 'Level Co')
  const mk = async (name: string, level: string) => {
    const email = `${name.toLowerCase()}-${uniq()}@t.test`
    const r = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, 'member', ?, ?)", [col.id, email, name, level, now()])
    return { id: r.lastId, email, cookie: { cookie: `requests_sid=${await createSession(email)}` } }
  }
  const leen = await mk('Leen', 'every')
  const cedric = await mk('Cedric', 'assigned')
  const thread = async (assignee: number | null) => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, assignee_member_id, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', 'v@out.test', ?, ?, ?, 'inbound', ?, ?)`, [col.id, `Subject ${uniq()}`, assignee, now(), now(), now(), now()])
    const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', 'v@out.test', 'Vincent', '[]', 'Hello there', ?, ?)`, [t.lastId, `<nl-${uniq()}@x>`, now(), now()])
    return { thread: (await get<any>('SELECT * FROM threads WHERE id = ?', [t.lastId]))!, message: (await get<any>('SELECT * FROM messages WHERE id = ?', [m.lastId]))! }
  }
  const fresh = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!

  // new mail nobody has: Leen hears about it, Cedric does not
  const a = await thread(null)
  let mails = await capture(() => notifyInbound(fresh, a.thread, a.message))
  assert.deepEqual(mails.map((m) => m.to).sort(), [leen.email])

  // new mail on Cedric's thread: Cedric hears about it
  const b = await thread(cedric.id)
  mails = await capture(() => notifyInbound(fresh, b.thread, b.message))
  assert.ok(mails.some((m) => m.to === cedric.email))

  // Leen hands thread A to Cedric: he gets "Leen assigned you"
  mails = await capture(() => app.request(`/inbox/${slug}/thread/${a.thread.id}/assign`, {
    method: 'POST', headers: { ...leen.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ member_id: String(cedric.id) }),
  }))
  const handed = mails.find((m) => m.to === cedric.email)
  assert.ok(handed, 'the assignee is told')
  assert.match(handed!.subject, /^Leen assigned you: Subject/)
  assert.match(handed!.html, /Hello there/)

  // taking a thread yourself sends nothing
  const c2 = await thread(null)
  mails = await capture(() => app.request(`/inbox/${slug}/thread/${c2.thread.id}/assign`, {
    method: 'POST', headers: { ...cedric.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ member_id: String(cedric.id) }),
  }))
  assert.equal(mails.length, 0)

  // a note that @mentions Cedric reaches him on this level too
  mails = await capture(() => app.request(`/inbox/${slug}/thread/${c2.thread.id}/note`, {
    method: 'POST', headers: { ...leen.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ body: '@Cedric can you check?' }),
  }))
  assert.ok(mails.some((m) => m.to === cedric.email), 'mentions ignore the level')

  // the level is offered wherever levels are chosen, and saved
  const page = await (await app.request(`/inbox/${slug}/members`, { headers: leen.cookie })).text()
  assert.match(page, /Assigned to me &amp; mentions<small>/, 'shown as Cedric\'s level in the list')
  const own = await (await app.request(`/inbox/${slug}/notifications`, { headers: leen.cookie })).text()
  assert.match(own, /name="level" value="assigned"/)
  await app.request(`/inbox/${slug}/notifications`, {
    method: 'POST', headers: { ...leen.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ level: 'assigned' }),
  })
  assert.equal((await get<any>('SELECT notify_level FROM members WHERE id = ?', [leen.id]))!.notify_level, 'assigned')
})
