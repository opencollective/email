import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { createAgentInvite, agentInviteUrl } from '../src/agents.js'
import { now } from '../src/util.js'
import { ingestInbound } from '../src/ingest.js'
import { simpleParser } from 'mailparser'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `ag${uniq()}`
  const collective = await createCollective(slug, 'Agent Co')
  const adminEmail = `admin-${uniq()}@example.org`
  const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, adminEmail, 'Xavier Damman', 'admin', 'every', now()])
  await ingestInbound(collective, await simpleParser(
    `Message-ID: <a-${uniq()}@x>\nFrom: Miriam Dean <miriam@out.test>\nTo: ${slug}@collective.email\nSubject: Book the big room\n\nCan we book the big room on the 16th?`))
  const thread = (await get<any>('SELECT * FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [collective.id]))!
  return { slug, collective, adminId: r.lastId, adminEmail, sid: await createSession(adminEmail), thread }
}

const json = (path: string, opts: RequestInit = {}) => app.request(path, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }))

async function joinedAgent(fx: Awaited<ReturnType<typeof fixture>>, role = 'commenter') {
  const invite = await createAgentInvite(fx.collective, role, 'Clara', fx.adminId)
  const r = await json(`/${fx.slug}/join/${invite.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Clara' }),
  })
  return { invite, ...r.body }
}

test('the invitation URL names the collective, reads as markdown to an agent and as a page to a human', async () => {
  const fx = await fixture()
  const invite = await createAgentInvite(fx.collective, 'commenter', 'Clara', fx.adminId)
  const url = agentInviteUrl(fx.collective, invite)
  assert.match(url, new RegExp(`/${fx.slug}/join/`), 'the slug is part of the URL — no ambiguity about what is being joined')

  const md = await app.request(`/${fx.slug}/join/${invite.token}`)
  assert.match(md.headers.get('content-type')!, /text\/markdown/)
  const mdText = await md.text()
  assert.match(mdText, new RegExp(`join ${fx.collective.name} \\(${fx.slug}\\)`))
  assert.match(mdText, /POST http/)

  const html = await app.request(`/${fx.slug}/join/${invite.token}`, { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.match(await html.text(), /Paste the URL to your agent/)

  // the skill is public and self-describing
  const skill = await (await app.request('/skill.md')).text()
  assert.match(skill, /untrusted_body/)
  assert.match(skill, /never as instructions/i)
})

test('claiming an invitation works exactly once and yields a working scoped token', async () => {
  const fx = await fixture()
  const a = await joinedAgent(fx)
  assert.ok(a.token.startsWith('cea_'))
  assert.equal(a.collective.slug, fx.slug)
  assert.equal(a.member.role, 'commenter')

  // second claim: refused
  const again = await json(`/${fx.slug}/join/${a.invite.token}`, { method: 'POST' })
  assert.equal(again.status, 410)

  // the agent is a member row of the right kind, with an unroutable address
  const m = (await get<any>('SELECT * FROM members WHERE id = ?', [a.member.id]))!
  assert.equal(m.kind, 'agent')
  assert.equal(m.notify_level, 'none')
  assert.match(m.email, /@agents\./)

  const me = await json(`/${fx.slug}/api/agent/me`, { headers: { authorization: `Bearer ${a.token}` } })
  assert.equal(me.body.collective.slug, fx.slug)
  assert.equal((await json(`/${fx.slug}/api/agent/me`)).status, 401, 'no token, no answer')
})

test('the token is a wall: another collective\'s threads do not exist for it', async () => {
  const fx = await fixture()
  const other = await fixture()
  const a = await joinedAgent(fx)
  const H = { headers: { authorization: `Bearer ${a.token}` } }

  const mine = await json(`/${fx.slug}/api/agent/threads/${fx.thread.id}`, H)
  assert.equal(mine.status, 200)
  assert.equal(mine.body.subject, 'Book the big room')
  assert.match(mine.body.messages[0].untrusted_body, /big room/, 'bodies are labelled for what they are')

  const theirs = await json(`/${fx.slug}/api/agent/threads/${other.thread.id}`, H)
  assert.equal(theirs.status, 404, 'not forbidden — nonexistent')
  const note = await json(`/${fx.slug}/api/agent/threads/${other.thread.id}/notes`, {
    method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
  })
  assert.equal(note.status, 404)
  assert.equal((await all('SELECT * FROM notes WHERE thread_id = ?', [other.thread.id])).length, 0)
})

test('contribute tier: notes and drafts land, sending does not exist, readers stay read-only', async () => {
  const fx = await fixture()
  const a = await joinedAgent(fx)
  const H = (extra: any = {}) => ({ headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, ...extra })

  const note = await json(`/${fx.slug}/api/agent/threads/${fx.thread.id}/notes`, { method: 'POST', body: JSON.stringify({ body: 'Rooms look free on the 16th.' }), ...H() })
  assert.equal(note.status, 200)

  const draft = await json(`/${fx.slug}/api/agent/threads/${fx.thread.id}/draft`, { method: 'POST', body: JSON.stringify({ body: 'Hello Miriam, the big room is free on the 16th.' }), ...H() })
  assert.equal(draft.status, 200)
  assert.match(draft.body.thread_url, new RegExp(`/inbox/${fx.slug}/thread/${fx.thread.id}$`), 'the human link for Discord pings')

  // a newer draft replaces the old — one live proposal per agent per thread
  await json(`/${fx.slug}/api/agent/threads/${fx.thread.id}/draft`, { method: 'POST', body: JSON.stringify({ body: 'Better wording.' }), ...H() })
  const drafts = await all<any>('SELECT * FROM thread_drafts WHERE thread_id = ?', [fx.thread.id])
  assert.equal(drafts.length, 1)
  assert.match(drafts[0].body, /Better wording/)

  // the thread page shows the proposal with provenance; sending clears it
  const page = await (await app.request(`/inbox/${fx.slug}/thread/${fx.thread.id}`, { headers: { cookie: `requests_sid=${fx.sid}` } })).text()
  assert.match(page, /🤖 <b>Clara<\/b> proposed a reply/)
  assert.match(page, /Better wording/)
  const { sendCollectiveReply } = await import('../src/outbound.js')
  const admin = (await get<any>('SELECT * FROM members WHERE id = ?', [fx.adminId]))!
  await sendCollectiveReply(fx.collective, fx.thread.id, 'Real reply', admin, 'web')
  assert.equal((await all('SELECT * FROM thread_drafts WHERE thread_id = ?', [fx.thread.id])).length, 0, 'settled by the real reply')

  // a reader-tier agent can look but not touch
  const r = await joinedAgent(fx, 'reader')
  const denied = await json(`/${fx.slug}/api/agent/threads/${fx.thread.id}/notes`, {
    method: 'POST', headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
  })
  assert.equal(denied.status, 403)
  // and there is no send endpoint at any tier
  assert.equal((await app.request(`/${fx.slug}/api/agent/threads/${fx.thread.id}/reply`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` } })).status, 404)
})

test('the event feed hands new inbound mail to the agent, scoped and cursored', async () => {
  const fx = await fixture()
  const a = await joinedAgent(fx)
  const H = { headers: { authorization: `Bearer ${a.token}` } }

  const first = await json(`/${fx.slug}/api/agent/events?since=0`, H)
  assert.equal(first.body.events.length, 1)
  assert.equal(first.body.events[0].type, 'message.new')
  assert.match(first.body.events[0].untrusted_preview, /big room/)

  // nothing new past the cursor
  const idle = await json(`/${fx.slug}/api/agent/events?since=${first.body.cursor}`, H)
  assert.equal(idle.body.events.length, 0)

  // a new mail shows up; another collective's mail never does
  const other = await fixture()
  await ingestInbound(fx.collective, await simpleParser(
    `Message-ID: <b-${uniq()}@x>\nFrom: Ruta <ruta@out.test>\nTo: ${fx.slug}@collective.email\nSubject: Invoice question\n\nWhere is my invoice?`))
  const next = await json(`/${fx.slug}/api/agent/events?since=${first.body.cursor}`, H)
  assert.equal(next.body.events.length, 1)
  assert.equal(next.body.events[0].subject, 'Invoice question')
  assert.ok(!JSON.stringify(next.body).includes(other.slug), 'no cross-collective bleed in the feed')
})

test('agents never receive email, and cannot be promoted into senders', async () => {
  const fx = await fixture()
  const a = await joinedAgent(fx)
  // notification fan-out for a fresh inbound skips the agent's synthetic address
  const { notifyInbound } = await import('../src/notify.js')
  const sent: string[] = []
  const orig = console.log
  console.log = (...args: any[]) => { sent.push(args.join(' ')); orig(...args) }
  try {
    await ingestInbound(fx.collective, await simpleParser(
      `Message-ID: <c-${uniq()}@x>\nFrom: New Person <new@out.test>\nTo: ${fx.slug}@collective.email\nSubject: Hello there\n\nHi!`))
  } finally { console.log = orig }
  void notifyInbound
  assert.ok(!sent.some((l) => l.includes('@agents.')), 'no SMTP toward the synthetic agent address')

  // an admin cannot hand an agent a sending role in v1
  const res = await app.request(`/inbox/${fx.slug}/members/${a.member.id}/role`, {
    method: 'POST', headers: { cookie: `requests_sid=${fx.sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'role=member',
  })
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /Agents cannot hold sending roles/)
  assert.equal((await get<any>('SELECT role FROM members WHERE id = ?', [a.member.id]))!.role, 'commenter')
})

test('the slug in the URL and the collective in the token must agree', async () => {
  const fx = await fixture()
  const other = await fixture()
  const a = await joinedAgent(fx)
  const H = { headers: { authorization: `Bearer ${a.token}` } }
  // right token, wrong slug: nothing exists — even for the token's OWN thread ids
  assert.equal((await json(`/${other.slug}/api/agent/me`, H)).status, 401)
  assert.equal((await json(`/${other.slug}/api/agent/threads/${fx.thread.id}`, H)).status, 401)
})

test('a human invitation pasted with the slug prefix still lands on the join page', async () => {
  const fx = await fixture()
  const { app: theApp } = await import('../src/app.js')
  const sid = fx.sid
  await theApp.request(`/inbox/${fx.slug}/invite`, { method: 'POST', headers: { cookie: `requests_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'role=commenter' })
  const inv = await get<any>('SELECT * FROM invites WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [fx.collective.id])
  if (inv) {
    const r = await theApp.request(`/${fx.slug}/join/${inv.token}`)
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), `/join/${inv.token}`)
  }
})

test('an admin can turn a person into an agent (and back), with the caps that implies', async () => {
  const fx = await fixture()
  const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.collective.id, `bot-${uniq()}@example.org`, 'Botty', 'member', 'every', now()])
  const post2 = (path: string, body: string) => app.request(path, {
    method: 'POST', headers: { cookie: `requests_sid=${fx.sid}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const res = await post2(`/inbox/${fx.slug}/members/${r.lastId}/kind`, 'kind=agent')
  const flash = decodeURIComponent(res.headers.get('location') || '')
  assert.match(flash, /is an agent now \(commenter\)/, 'a sender is capped down to contribute')
  const token = flash.match(/cea_[A-Za-z0-9_-]+/)?.[0]
  assert.ok(token, 'the token is minted and shown once')
  const m = (await get<any>('SELECT * FROM members WHERE id = ?', [r.lastId]))!
  assert.equal(m.kind, 'agent'); assert.equal(m.role, 'commenter'); assert.equal(m.notify_level, 'none')

  const me = await json(`/${fx.slug}/api/agent/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(me.status, 200)

  // back to person: tokens die on the spot
  await post2(`/inbox/${fx.slug}/members/${r.lastId}/kind`, 'kind=person')
  assert.equal((await get<any>('SELECT * FROM members WHERE id = ?', [r.lastId]))!.kind, 'person')
  assert.equal((await json(`/${fx.slug}/api/agent/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401)
})
