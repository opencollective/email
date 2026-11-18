import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture(cc: string[] = [], bcc: string[] = []) {
  const slug = `dl${uniq()}`
  const collective = await createCollective(slug, 'Delivery Co')
  const email = `alice-${uniq()}@example.org`
  const m = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, email, 'Alice', 'admin', 'every', now()])
  const sid = await createSession(email)
  const t0 = now() - 3600
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
    first_message_at, last_message_at, last_direction, created_at, updated_at) VALUES (?, 'Venue', 'answered', 'stef@out.test', 'Stef', ?, ?, 'outbound', ?, ?)`,
    [collective.id, t0, t0, t0, now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'Stef Lumen', 'stef@out.test', ?, 'hi', ?, ?)`, [t.lastId, `<in${uniq()}@x>`, JSON.stringify([`${slug}@collective.email`]), t0 - 60, t0 - 60])
  const resendId = `re-${uniq()}`
  const msg = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, body_text, sent_at, created_at, sent_by_member_id, resend_email_id)
    VALUES (?, ?, 'outbound', 'Delivery Co', ?, ?, ?, ?, 'hello', ?, ?, ?, ?)`,
    [t.lastId, `<out${uniq()}@x>`, `${slug}@collective.email`, JSON.stringify(['stef@out.test']), JSON.stringify(cc), JSON.stringify(bcc), t0, t0, m.lastId, resendId])
  return { slug, sid, email, threadId: t.lastId, msgId: msg.lastId, resendId }
}

const page = (path: string, sid: string) => app.request(path, { headers: { cookie: `requests_sid=${sid}` } })
const hook = (body: unknown) => app.request('/webhooks/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('the header card says who sent a message, from which address, and to whom', async () => {
  const fx = await fixture(['marco@out.test'], ['secret@out.test'])
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.sid)).text()
  assert.match(html, /class="meta-card"/)
  assert.match(html, new RegExp(`Alice &lt;${fx.email}&gt;`), 'sent by, with the member address')
  assert.match(html, /Delivery Co &lt;dl\d+@collective\.email&gt;/, 'from address')
  assert.match(html, /Stef Lumen &lt;stef@out\.test&gt;/, 'To, named after how they signed in')
  assert.match(html, /marco@out\.test/, 'Cc')
  assert.match(html, /secret@out\.test/, 'Bcc, for the team')
  assert.match(html, /&lt;out\d+@x&gt;/, 'Message-ID')
  assert.match(html, /data-dlv="\/inbox\/dl\d+\/thread\/\d+\/message\/\d+\/delivery"/, 'delivery looked up on demand')
})

test('Resend events say the email arrived and was opened, under the message', async () => {
  const fx = await fixture()
  let r = await hook({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: fx.resendId, to: ['stef@out.test'] } })
  assert.equal((await r.json() as any).recorded, true)
  r = await hook({ type: 'email.opened', created_at: new Date().toISOString(), data: { email_id: fx.resendId, to: ['stef@out.test'] } })
  assert.equal((await r.json() as any).recorded, true)
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.sid)).text()
  assert.match(html, /class="ext-seen"/)
  assert.match(html, /Delivered · /)
  assert.match(html, /Opened by Stef Lumen · /, 'one recipient: we can say who')
  // unknown emails (app mail) are ignored, not errors
  r = await hook({ type: 'email.delivered', data: { email_id: 'nope', to: [] } })
  assert.equal((await r.json() as any).recorded, false)
  // the on-demand endpoint answers from what we know without asking Resend
  const d = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}/message/${fx.msgId}/delivery`, fx.sid)).text()
  assert.match(d, /Delivered/)
})

test('several recipients: an open is not pinned on anyone, a bounce names who', async () => {
  const fx = await fixture(['marco@out.test', 'marg@out.test'])
  await hook({ type: 'email.opened', data: { email_id: fx.resendId, to: ['stef@out.test'] } })
  await hook({ type: 'email.bounced', data: { email_id: fx.resendId, to: ['marg@out.test'], bounce: { type: 'Permanent', message: 'mailbox unknown' } } })
  const html = await (await page(`/inbox/${fx.slug}/thread/${fx.threadId}`, fx.sid)).text()
  assert.match(html, /Opened by at least one of the 3 recipients/)
  assert.match(html, /Bounced for marg@out\.test/)
  assert.match(html, /Permanent · mailbox unknown/)
})

test('a stranger cannot read another inbox message delivery', async () => {
  const fx = await fixture()
  const other = await fixture()
  const r = await page(`/inbox/${fx.slug}/thread/${other.threadId}/message/${other.msgId}/delivery`, fx.sid)
  assert.notEqual(r.status, 200)
})

test('our own tracking image: a reply carries one, loading it records "opened" and nothing else', async () => {
  const { sendCollectiveReply } = await import('../src/outbound.js')
  const { createCollective: cc, get } = await import('../src/db.js')
  const slug = `px${uniq()}`
  const col = await cc(slug, 'Pixel Co')
  const memEmail = `m-${uniq()}@t.test`
  const m = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Mo', 'admin', 'every', ?)", [col.id, memEmail, now()])
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Hi', 'needs_reply', 'ext@out.test', ?, ?, 'inbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'ext@out.test', '[]', 'hello', ?, ?)`, [t.lastId, `<px${uniq()}@x>`, now(), now()])
  const member = (await get<any>('SELECT * FROM members WHERE id = ?', [m.lastId]))!
  const sent = await sendCollectiveReply(col, t.lastId, 'Sure.', member, 'web')
  assert.match(String(sent.open_token), /^[A-Za-z0-9_-]{20,}$/)
  assert.equal(await get('SELECT * FROM message_events WHERE message_id = ?', [sent.id]), undefined, 'nothing before it is opened')

  const r = await app.request(`/o/${sent.open_token}.gif`, { headers: { 'user-agent': 'Secret UA', 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/gif')
  assert.match(String(r.headers.get('cache-control')), /no-store/)
  await app.request(`/o/${sent.open_token}.gif`)
  const ev = (await get<any>("SELECT * FROM message_events WHERE message_id = ? AND type = 'opened'", [sent.id]))!
  assert.equal(ev.count, 2)
  assert.equal(ev.recipients, null)
  assert.doesNotMatch(JSON.stringify(ev), /Secret UA|203\.0\.113/, 'no user agent, no IP')
  // an unknown token still answers with an image and records nothing
  const bad = await app.request('/o/AAAAAAAAAAAAAAAAAAAAAA.gif')
  assert.equal(bad.status, 200)
})

test('our image quoted inside someone else\'s reply is stripped before it can be shown', async () => {
  const { sanitizeEmailHtml } = await import('../src/sanitize.js')
  const html = sanitizeEmailHtml('<p>Thanks!</p><blockquote><img src="https://collective.email/o/abcdefghijklmnopqrstuv.gif" width="1" height="1"><img src="https://example.org/logo.png"></blockquote>')
  assert.doesNotMatch(html, /\/o\/abcdef/)
  assert.match(html, /logo\.png/)
})
