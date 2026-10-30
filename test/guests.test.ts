import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { __observeAppMail } from '../src/appmail.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `gu${uniq()}`
  const collective = await createCollective(slug, 'Guest Co')
  const adminEmail = `admin-${uniq()}@example.org`
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, adminEmail, 'Xavier', 'admin', 'every', now()])
  const mkThread = async (subj: string, from = 'miriam@out.test') => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', ?, 'Miriam', ?, ?, 'inbound', ?, ?)`, [collective.id, subj, from, now(), now(), now(), now()])
    await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', ?, '[]', 'hello', ?, ?)`, [t.lastId, `<g${uniq()}@x>`, from, now(), now()])
    return t.lastId
  }
  const t1 = await mkThread('Shared thread')
  const t2 = await mkThread('Private thread', 'other@out.test')
  return { slug, collective, sid: await createSession(adminEmail), t1, t2 }
}

const page = (path: string, sid: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })
const post = (path: string, sid: string, body: string) => app.request(path, {
  method: 'POST', headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
})

test('assign to someone else: guest by default, sees exactly the shared thread, invited by email', async () => {
  const fx = await fixture()
  const mails: any[] = []
  __observeAppMail((m) => mails.push(m))
  try {
    const r = await post(`/inbox/${fx.slug}/thread/${fx.t1}/assign-new`, fx.sid, 'email=ruta%40out.test&name=Ruta&access=thread')
    assert.equal(r.status, 302)
  } finally { __observeAppMail(null) }

  const guest = (await get<any>("SELECT * FROM members WHERE collective_id = ? AND email = 'ruta@out.test'", [fx.collective.id]))!
  assert.equal(guest.role, 'guest')
  assert.equal((await get<any>('SELECT * FROM threads WHERE id = ?', [fx.t1]))!.assignee_member_id, guest.id)
  assert.equal(mails.length, 1)
  assert.match(mails[0].subject, /assigned you a conversation/)
  assert.match(mails[0].text, /guest access/)

  // her world: the shared thread exists, the private one does not
  const gsid = await createSession('ruta@out.test')
  assert.equal((await page(`/inbox/${fx.slug}/thread/${fx.t1}`, gsid)).status, 200)
  assert.equal((await page(`/inbox/${fx.slug}/thread/${fx.t2}`, gsid)).status, 404)
  const inbox = await (await page(`/inbox/${fx.slug}?f=all`, gsid)).text()
  assert.match(inbox, /Shared thread/)
  assert.doesNotMatch(inbox, /Private thread/)
  // and, the thread being assigned to her, she answers it as the collective
  assert.match(await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, gsid)).text(), /data-pane="reply"/)

  // assigning her another thread through the normal picker shares it
  await post(`/inbox/${fx.slug}/thread/${fx.t2}/assign`, fx.sid, `member_id=${guest.id}`)
  assert.equal((await page(`/inbox/${fx.slug}/thread/${fx.t2}`, gsid)).status, 200)
})

test('assign to someone else with full access makes a commenter; autoassign writes the rule', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/assign-new`, fx.sid, 'email=carla%40out.test&access=collective&autoassign=1')
  const m = (await get<any>("SELECT * FROM members WHERE collective_id = ? AND email = 'carla@out.test'", [fx.collective.id]))!
  assert.equal(m.role, 'commenter')
  const rule = await get<any>("SELECT * FROM rules WHERE collective_id = ? AND match_from = 'miriam@out.test'", [fx.collective.id])
  assert.equal(rule.assign_member_id, m.id)
  // a commenter sees everything
  const sid = await createSession('carla@out.test')
  assert.equal((await page(`/inbox/${fx.slug}/thread/${fx.t2}`, sid)).status, 200)
})

test('guests appear in their own section, edited through the same pencil-modal as members', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/assign-new`, fx.sid, 'email=guesty%40out.test&access=thread')
  const html = await (await page(`/inbox/${fx.slug}/members`, fx.sid)).text()
  const gsec = html.slice(html.indexOf('Guests'), html.indexOf('<dialog id="member-edit-modal"'))
  assert.match(gsec, /guesty@out\.test/)
  assert.match(gsec, /1 thread shared/)
  assert.match(gsec, /data-edit-member=/, 'guests get the same pencil as members')
  assert.doesNotMatch(gsec, /role-select/, 'no inline dropdown of its own')
  const guest = (await get<any>("SELECT * FROM members WHERE email = 'guesty@out.test'", []))!
  // promoting to commenter goes through the shared edit route
  await post(`/inbox/${fx.slug}/members/${guest.id}/update`, fx.sid, 'name=Guesty&kind=person&role=commenter&notify_level=every')
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [guest.id]))!.role, 'commenter')
  // a person cannot be turned INTO a guest by role edit — guesthood is made by sharing
  await post(`/inbox/${fx.slug}/members/${guest.id}/update`, fx.sid, 'name=Guesty&kind=person&role=guest&notify_level=every')
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [guest.id]))!.role, 'commenter')
})

test('guests are only notified about their threads', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/assign-new`, fx.sid, 'email=quiet%40out.test&access=thread')
  const { notifyInbound } = await import('../src/notify.js')
  const mails: any[] = []
  __observeAppMail((m) => mails.push(m))
  try {
    const msg1 = (await get<any>('SELECT * FROM messages WHERE thread_id = ?', [fx.t1]))!
    const msg2 = (await get<any>('SELECT * FROM messages WHERE thread_id = ?', [fx.t2]))!
    await notifyInbound(fx.collective, (await get<any>('SELECT * FROM threads WHERE id = ?', [fx.t1]))!, msg1)
    await notifyInbound(fx.collective, (await get<any>('SELECT * FROM threads WHERE id = ?', [fx.t2]))!, msg2)
  } finally { __observeAppMail(null) }
  const toGuest = mails.filter((m) => m.to === 'quiet@out.test')
  assert.equal(toGuest.length, 1, 'the shared thread notifies the guest; the private one does not')
})

test('"N threads shared" opens the inbox list narrowed to what that guest can see, assigned or not', async () => {
  const { createCollective, run, get, grantThreadAccess } = await import('../src/db.js')
  const { createSession } = await import('../src/auth.js')
  const { now } = await import('../src/util.js')
  const slug = `sh${Date.now() % 1000000}`
  const col = await createCollective(slug, 'Share Co')
  const admin = `adm-${Date.now()}@t.test`
  const a = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Leen', 'admin', 'every', ?)", [col.id, admin, now()])
  const g = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Ruta', 'guest', 'every', ?)", [col.id, `ruta-${Date.now()}@t.test`, now()])
  const mk = async (subject: string, assignee: number | null) => (await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, assignee_member_id, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, ?, 'needs_reply', 'x@out.test', ?, ?, ?, 'inbound', ?, ?)`, [col.id, subject, assignee, now(), now(), now(), now()])).lastId
  const stillHers = await mk('Shared and assigned', g.lastId)
  const handedBack = await mk('Shared, now with Leen', a.lastId)
  await mk('Never shared', null)
  await grantThreadAccess(g.lastId, stillHers)
  await grantThreadAccess(g.lastId, handedBack)
  const cookie = { cookie: `requests_sid=${await createSession(admin)}` }

  const members = await (await app.request(`/inbox/${slug}/members`, { headers: cookie })).text()
  assert.match(members, new RegExp(`<a href="/inbox/${slug}\\?f=all&amp;shared=${g.lastId}">2 threads shared</a>`))

  const list = await (await app.request(`/inbox/${slug}?f=all&shared=${g.lastId}`, { headers: cookie })).text()
  assert.match(list, /Threads shared with <b>Ruta<\/b>/)
  assert.match(list, /Shared and assigned/)
  assert.match(list, /Shared, now with Leen/, 'still shared even though no longer assigned to her')
  assert.doesNotMatch(list, /Never shared/)
  assert.doesNotMatch(list, /class="chip tag-chip on"/, 'no pill claims this view')
  // and visiting it does not become the inbox's remembered filter
  const inbox = await (await app.request(`/inbox/${slug}`, { headers: cookie })).text()
  assert.doesNotMatch(inbox, /Threads shared with/)
  void get
})

test('thread share links: comment by default, send on request — on that one thread only', async () => {
  const fx = await fixture()
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, fx.sid)).text()
  assert.match(html, /data-dialog="#share-modal"/, 'a share button on the thread')
  assert.match(html, /Join the thread “Shared thread” started by Miriam<\/textarea>/, 'a ready-to-post text')
  const link = async (mode: string) => (await (await post(`/inbox/${fx.slug}/thread/${fx.t1}/share`, fx.sid, `mode=${mode}`)).json()).url as string
  const commentUrl = await link('comment')
  const sendUrl = await link('send')
  assert.notEqual(commentUrl, sendUrl)
  assert.equal(await link('send'), sendUrl, 'one live link per mode, reused')
  const tokenOf = (u: string) => u.split('/').pop()!

  // signed out: the link asks for a name and an email, nothing else
  const join = await (await app.request(`/join/${tokenOf(sendUrl)}`)).text()
  assert.match(join, /name="name"/)
  assert.match(join, /type="email" name="email"/)
  assert.doesNotMatch(join, /name="level" value="daily"/, 'no notification choices for one thread')
  assert.match(join, /send it as/)

  // a commenter guest can propose but not send
  const joinAs = async (token: string) => {
    const email = `g-${uniq()}@t.test`
    const sid = await createSession(email)
    await app.request(`/join/${token}`, {
      method: 'POST', headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ account: email, name: 'Ruta', level: 'every' }),
    })
    return sid
  }
  const commenter = await joinAs(tokenOf(commentUrl))
  const cRes = await post(`/inbox/${fx.slug}/thread/${fx.t1}/reply`, commenter, 'body=hi')
  assert.match(decodeURIComponent(cRes.headers.get('location')!), /comment but not send/)
  assert.equal((await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, commenter, 'status=answered')).status, 403)

  // a sender guest replies and marks answered on THIS thread — and nowhere else
  const sender = await joinAs(tokenOf(sendUrl))
  const page1 = await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, sender)).text()
  assert.match(page1, /action="[^"]*\/thread\/\d+\/reply"/, 'the reply composer is there')
  assert.doesNotMatch(page1, /data-dialog="#share-modal"/, 'a guest does not re-share')
  assert.doesNotMatch(page1, /\/delete"/, 'nor delete')
  const sRes = await post(`/inbox/${fx.slug}/thread/${fx.t1}/reply`, sender, 'body=On it!')
  assert.match(decodeURIComponent(sRes.headers.get('location')!), /Reply sent/)
  assert.equal((await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, sender, 'status=spam')).status, 302)
  assert.notEqual((await get<any>('SELECT status FROM threads WHERE id = ?', [fx.t1])).status, 'spam', 'spam stays a member\'s call')
  assert.notEqual((await page(`/inbox/${fx.slug}/thread/${fx.t2}`, sender)).status, 200, 'other threads stay invisible')
  const assignNew = await post(`/inbox/${fx.slug}/thread/${fx.t1}/assign-new`, sender, 'email=friend@t.test')
  assert.match(decodeURIComponent(assignNew.headers.get('location') || ''), /comment but not send/, 'cannot invite others')

  // the log says who brought whom in
  const log = (await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, fx.sid)).text()).replace(/&#39;|&quot;/g, "'")
  assert.match(log, /Ruta \(invited by Xavier\) joined this thread(?! —)/)
  assert.match(log, /Ruta \(invited by Xavier\) joined this thread — can send replies/)
  // opening the link again logs nothing new
  const before = (await all("SELECT id FROM events WHERE thread_id = ? AND type = 'joined'", [fx.t1])).length
  await page(`/join/${tokenOf(sendUrl)}`, sender)
  assert.equal((await all("SELECT id FROM events WHERE thread_id = ? AND type = 'joined'", [fx.t1])).length, before)

  // turning the links off kills both; joined guests keep access
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/share/revoke`, fx.sid, '')
  assert.match(await (await app.request(`/join/${tokenOf(sendUrl)}`)).text(), /expired/)
  assert.equal((await page(`/inbox/${fx.slug}/thread/${fx.t1}`, sender)).status, 200)
})

test('flipping the status back within seconds is a slip: restored, and not logged', async () => {
  const fx = await fixture()
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, fx.sid, 'status=answered')
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, fx.sid, 'status=needs_reply')
  assert.equal((await get<any>('SELECT status FROM threads WHERE id = ?', [fx.t1])).status, 'needs_reply')
  assert.equal((await all("SELECT id FROM events WHERE thread_id = ? AND type = 'status'", [fx.t1])).length, 0)
  // a deliberate change later still logs
  await run("UPDATE events SET created_at = created_at - 60 WHERE thread_id = ?", [fx.t1])
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, fx.sid, 'status=answered')
  await run("UPDATE events SET created_at = created_at - 60 WHERE thread_id = ?", [fx.t1])
  await post(`/inbox/${fx.slug}/thread/${fx.t1}/status`, fx.sid, 'status=needs_reply')
  assert.equal((await all("SELECT id FROM events WHERE thread_id = ? AND type = 'status'", [fx.t1])).length, 2)
})
