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
  // and she can note but not send
  assert.doesNotMatch(await (await page(`/inbox/${fx.slug}/thread/${fx.t1}`, gsid)).text(), /data-pane="reply"/)

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
