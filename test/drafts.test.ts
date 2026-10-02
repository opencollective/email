import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { signOffDrift, signatureFor } from '../src/outbound.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `dr${uniq()}`
  const collective = await createCollective(slug, 'Commons Hub Brussels')
  const email = `x-${uniq()}@t.test`
  const m = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'xdamman', 'admin', 'every', ?)", [collective.id, email, now()])
  const sid = await createSession(email)
  const cookie = { cookie: `requests_sid=${sid}` }
  const form = (path: string, fields: Record<string, string>) => app.request(path, {
    method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  })
  const compose = async (body: string, action = 'draft') => {
    const res = await form(`/inbox/${slug}/compose`, { to: 'help@monerium.test', subject: 'Change of organisation name', body, action })
    const loc = res.headers.get('location')!
    return { loc, threadId: Number(loc.match(/thread\/(\d+)/)![1]) }
  }
  const page = async (path: string, c = cookie) => (await app.request(path, { headers: c })).text()
  return { slug, collective, memberId: m.lastId, email, sid, cookie, form, compose, page }
}

test('a sign-off that differs from the signature is spotted; the default shape is not', async () => {
  const fx = await fixture()
  const me = (await get<any>('SELECT * FROM members WHERE id = ?', [fx.memberId]))!
  assert.equal(signOffDrift(`Hi.\n\n${signatureFor(fx.collective, me)}`, fx.collective, me), null)
  assert.equal(signOffDrift('Hi.\n\n— Xavier, for Commons Hub Brussels', fx.collective, me), '— Xavier, for Commons Hub Brussels')
  assert.equal(signOffDrift('Hi, no sign-off at all.', fx.collective, me), null, 'nothing that reads like a sign-off: nothing to offer')
})

test('save as draft: lands on the draft, offers to adopt the new sign-off, one click updates it', async () => {
  const fx = await fixture()
  const { loc, threadId } = await fx.compose('Hi, we renamed.\n\n— Xavier, for Commons Hub Brussels')
  assert.match(decodeURIComponent(loc), /&sig=— Xavier, for Commons Hub Brussels$/)
  const html = await fx.page(loc)
  assert.match(html, /You signed as <b>— Xavier, for Commons Hub Brussels<\/b>/)
  assert.match(html, /Update my signature/)

  // the default shape with another name: their name changes, and with it the signature
  const res = await fx.form(`/inbox/${fx.slug}/signature`, { text: '— Xavier, for Commons Hub Brussels', back: `/inbox/${fx.slug}/thread/${threadId}` })
  assert.match(res.headers.get('location')!, new RegExp(`^/inbox/${fx.slug}/thread/${threadId}\\?m=`))
  const me = (await get<any>('SELECT name, signature FROM members WHERE id = ?', [fx.memberId]))!
  assert.equal(me.name, 'Xavier')
  assert.equal(me.signature, null)
  // and the offer does not come back once it is the signature
  assert.doesNotMatch(await fx.page(loc), /Update my signature/)

  // any other sign-off becomes the signature itself
  await fx.form(`/inbox/${fx.slug}/signature`, { text: '— Xavier & the CHB team', back: `/inbox/${fx.slug}` })
  assert.equal((await get<any>('SELECT signature FROM members WHERE id = ?', [fx.memberId]))!.signature, '— Xavier & the CHB team')
  const compose = await fx.page(`/inbox/${fx.slug}/compose`)
  assert.match(compose, /data-signature="— Xavier &amp; the CHB team"/)
})

test('a draft is assigned to whoever started it, labelled "draft vN by", and versioned on real changes', async () => {
  const fx = await fixture()
  const { threadId } = await fx.compose('First version')
  assert.equal((await get<any>('SELECT assignee_member_id FROM threads WHERE id = ?', [threadId]))!.assignee_member_id, fx.memberId)
  let html = await fx.page(`/inbox/${fx.slug}/thread/${threadId}`)
  assert.match(html, /· draft v1 by xdamman/)
  assert.doesNotMatch(html, /sent by/)
  assert.match(html, /not sent yet/)

  const save = (body: string) => fx.form(`/inbox/${fx.slug}/thread/${threadId}/draft`, { to: 'help@monerium.test', subject: 'Change of organisation name', body, action: 'save' })
  await save('First version') // unchanged
  assert.match(await fx.page(`/inbox/${fx.slug}/thread/${threadId}`), /draft v1 by/)
  await save('Second version')
  assert.match(await fx.page(`/inbox/${fx.slug}/thread/${threadId}`), /draft v2 by/)
})

test('a draft offers a share link: anyone who joins with it is a guest on that thread only, and lands on it', async () => {
  const fx = await fixture()
  const other = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Private matter', 'needs_reply', 'z@out.test', ?, ?, 'inbound', ?, ?)`, [fx.collective.id, now(), now(), now(), now()])
  const { threadId } = await fx.compose('Please review')
  const html = await fx.page(`/inbox/${fx.slug}/thread/${threadId}`)
  assert.match(html, /Get a second pair of eyes/)
  assert.match(html, /data-dialog="#assign-modal">Assign to someone/)
  const link = html.match(new RegExp(`(http://test\\.local/${fx.slug}/join/[A-Za-z0-9_-]+)`))![1]
  // the same link on the next visit, not a new one each time
  assert.ok((await fx.page(`/inbox/${fx.slug}/thread/${threadId}`)).includes(link))

  // making a member invite does not revoke it
  await fx.form(`/inbox/${fx.slug}/members/add`, { type: 'person', role: 'member' })
  const token = link.split('/').pop()!
  assert.equal((await get<any>('SELECT revoked_at FROM invites WHERE token = ?', [token]))!.revoked_at, null)

  // a stranger, signed in elsewhere, follows the link
  const slugPath = new URL(link).pathname
  const hop = await app.request(slugPath)
  assert.equal(hop.headers.get('location'), `/join/${token}`)
  const guestEmail = `ruta-${uniq()}@t.test`
  const guestCookie = { cookie: `requests_sid=${await createSession(guestEmail)}` }
  const joinPage = await fx.page(`/join/${token}`, guestCookie)
  assert.match(joinPage, /Collaborate on “Change of organisation name”/)
  const joined = await app.request(`/join/${token}`, {
    method: 'POST', headers: { ...guestCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: guestEmail, name: 'Ruta', level: 'every' }),
  })
  assert.match(joined.headers.get('location')!, new RegExp(`^/inbox/${fx.slug}/thread/${threadId}\\?m=`))
  const guest = (await get<any>('SELECT role FROM members WHERE email = ? AND collective_id = ?', [guestEmail, fx.collective.id]))!
  assert.equal(guest.role, 'guest')
  assert.equal((await app.request(`/inbox/${fx.slug}/thread/${threadId}`, { headers: guestCookie })).status, 200)
  assert.notEqual((await app.request(`/inbox/${fx.slug}/thread/${other.lastId}`, { headers: guestCookie })).status, 200, 'nothing beyond the shared thread')
})

test('Drafts: its own menu entry and view, never the remembered inbox filter', async () => {
  const fx = await fixture()
  await fx.compose('A draft')
  const drafts = await fx.page(`/inbox/${fx.slug}?f=drafts`)
  assert.match(drafts, new RegExp(`class="nav-item active" href="/inbox/${fx.slug}\\?f=drafts">`))
  assert.match(drafts, /Change of organisation name/)
  assert.match(drafts, /Drafts <span class="count">1<\/span>/)
  // opening the inbox afterwards does not land on Drafts
  const inbox = await fx.page(`/inbox/${fx.slug}`)
  assert.doesNotMatch(inbox, new RegExp(`class="nav-item active" href="/inbox/${fx.slug}\\?f=drafts">`))
})
