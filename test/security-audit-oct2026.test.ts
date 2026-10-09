/** Regression tests for the internal security audit (Oct 2026). Each test
 *  reproduces a finding and fails on the code before the fix. */
import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { app } from '../src/app.js'
import { all, createCollective, get, grantThreadAccess, run, storeAttachment } from '../src/db.js'
import { checkCode, createSession, issueCode } from '../src/auth.js'
import { cfg } from '../src/config.js'
import { now, sha256, signToken } from '../src/util.js'
import { notifyInbound } from '../src/notify.js'
import { sanitizeEmailHtml } from '../src/sanitize.js'
import { __observeAppMail, type AppMail } from '../src/appmail.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `au${uniq()}`
  const col = await createCollective(slug, 'Audit Co')
  const mk = async (name: string, role: string, email = `${name.toLowerCase()}-${uniq()}@t.test`) => {
    const r = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)', [col.id, email, name, role, 'every', now()])
    return { id: r.lastId, email, cookie: { cookie: `requests_sid=${await createSession(email)}` } }
  }
  const thread = async (subject: string, counterpart = 'customer@out.test') => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', ?, ?, ?, 'inbound', ?, ?)`, [col.id, subject, counterpart, now(), now(), now(), now()])
    const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
      VALUES (?, ?, 'inbound', ?, 'Customer', '[]', ?, ?, ?)`, [t.lastId, `<au-${uniq()}@x>`, counterpart, `body of ${subject}`, now(), now()])
    return { id: t.lastId, msgId: m.lastId }
  }
  return { slug, col, mk, thread }
}
const form = (path: string, headers: Record<string, string>, fields: Record<string, string>) => app.request(path, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
})
async function capture(fn: () => Promise<unknown>): Promise<AppMail[]> {
  const mails: AppMail[] = []
  __observeAppMail((m) => mails.push(m))
  try { await fn() } finally { __observeAppMail(null) }
  return mails
}

// ---------- authentication ----------

test('login codes: the replay window is not a free-guess window, and attempts are capped', async () => {
  const email = `rp-${uniq()}@t.test`
  await issueCode(email, 'login')
  const row = (await get<any>('SELECT * FROM login_codes WHERE email = ?', [email]))!
  // plant a known code, consume it once (the real sign-in)
  await run('UPDATE login_codes SET code_hash = ? WHERE id = ?', [sha256('123456' + cfg.secret), row.id])
  assert.equal((await checkCode(email, '123456')).ok, true)
  // an attacker hammering right after: a handful of tries at most, then nothing — not even the right code
  for (let i = 0; i < 20; i++) await checkCode(email, String(100000 + i))
  assert.equal((await checkCode(email, '123456')).ok, false, 'replay attempts are capped too')

  // and on a fresh code: five wrong guesses lock it, the right one then fails
  const e2 = `rp2-${uniq()}@t.test`
  await issueCode(e2, 'login')
  await run('UPDATE login_codes SET code_hash = ? WHERE email = ?', [sha256('654321' + cfg.secret), e2])
  await Promise.all(Array.from({ length: 12 }, (_, i) => checkCode(e2, String(200000 + i))))
  assert.ok((await get<any>('SELECT attempts FROM login_codes WHERE email = ?', [e2]))!.attempts <= 5, 'concurrent guesses can\'t exceed the limit')
  assert.equal((await checkCode(e2, '654321')).ok, false)
})

test('login codes: at most ten per address per day', async () => {
  const email = `cap-${uniq()}@t.test`
  let ok = 0
  for (let i = 0; i < 14; i++) {
    await run('UPDATE login_codes SET created_at = ? WHERE email = ?', [now() - 60, email]) // step past the 30s gap
    if (await issueCode(email, 'login')) ok++
  }
  assert.equal(ok, 10)
})

test('/resend only ever sends the code to the address it signs in as', async () => {
  const email = `rs-${uniq()}@t.test`
  await issueCode(email, 'claim', { claimSlug: `oc${uniq()}`, name: 'X' })
  await run('UPDATE login_codes SET created_at = ? WHERE email = ?', [now() - 60, email])
  const mails = await capture(() => form('/resend', {}, { email }))
  assert.deepEqual(mails.map((m) => m.to), [email])
})

test('safeNext refuses paths a browser would fold into another host', async () => {
  const sid = await createSession(`n-${uniq()}@t.test`)
  for (const bad of ['/\t/evil.example', '/\n/evil.example', '/ /evil.example', '//evil.example', '/\\evil.example']) {
    const res = await app.request(`/login?next=${encodeURIComponent(bad)}`, { headers: { cookie: `requests_sid=${sid}` } })
    assert.equal(res.headers.get('location'), '/', JSON.stringify(bad))
  }
  const ok = await app.request(`/login?next=${encodeURIComponent('/inbox/x?f=all')}`, { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(ok.headers.get('location'), '/inbox/x?f=all')
})

test('a removed admin who opens a share link comes back as a guest, not an admin', async () => {
  const fx = await fixture()
  const admin = await fx.mk('Admin', 'admin')
  const ex = await fx.mk('Ex', 'admin')
  const t = await fx.thread('Shared')
  await run('UPDATE members SET removed_at = ? WHERE id = ?', [now(), ex.id])
  const token = `tok${uniq()}`
  await run("INSERT INTO invites (collective_id, token, role, thread_id, created_by, created_at, expires_at) VALUES (?, ?, 'guest', ?, ?, ?, ?)",
    [fx.col.id, token, t.id, admin.id, now(), now() + 86400])
  await form(`/join/${token}`, ex.cookie, { account: ex.email, name: 'Ex', level: 'every' })
  const back = (await get<any>('SELECT role, removed_at FROM members WHERE id = ?', [ex.id]))!
  assert.equal(back.removed_at, null)
  assert.equal(back.role, 'guest')
})

test('the agent invitation page escapes the collective name', async () => {
  const fx = await fixture()
  await run('UPDATE collectives SET name = ? WHERE id = ?', ['<img src=x onerror=alert(1)>', fx.col.id])
  const token = `agt${uniq()}`
  const { createAgentInvite } = await import('../src/agents.js')
  const fresh = (await get<any>('SELECT * FROM collectives WHERE id = ?', [fx.col.id]))!
  const admin = await fx.mk('Admin', 'admin')
  const inv = await createAgentInvite(fresh, 'commenter', 'Bot', admin.id)
  void token
  const html = await (await app.request(`/${fx.slug}/join/${inv.token}`, { headers: { accept: 'text/html' } })).text()
  assert.doesNotMatch(html, /<img src=x onerror/)
  assert.match(html, /&lt;img src=x onerror/)
})

test('webhooks fail closed when email or billing is live but the secret is missing', async () => {
  const saved = { stripeKey: cfg.stripeKey, stripeWebhookSecret: cfg.stripeWebhookSecret, resendKey: cfg.resendKey, resendWebhookSecret: cfg.resendWebhookSecret }
  try {
    Object.assign(cfg, { stripeKey: 'sk_test_x', stripeWebhookSecret: '' })
    const s = await app.request('/webhooks/stripe', { method: 'POST', body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { collective_id: '1', plan: 'pro' } } } }) })
    assert.equal(s.status, 503)
    Object.assign(cfg, { resendKey: 're_x', resendWebhookSecret: '' })
    const r = await app.request('/webhooks/resend', { method: 'POST', body: JSON.stringify({ type: 'email.received', data: {} }) })
    assert.ok(r.status === 401 || r.status === 400 || r.status === 403, `forged inbound refused (${r.status})`)
  } finally {
    Object.assign(cfg, saved)
  }
})

test('a Pro approval link works once', async () => {
  const fx = await fixture()
  const token = signToken({ a: 'approvepro', cid: fx.col.id, m: 12, t: uniq() }, 3600)
  await app.request(`/a/${token}`)
  const once = (await get<any>('SELECT trial_ends_at FROM collectives WHERE id = ?', [fx.col.id]))!.trial_ends_at
  await app.request(`/a/${token}`)
  await app.request(`/a/${token}`)
  assert.equal((await get<any>('SELECT trial_ends_at FROM collectives WHERE id = ?', [fx.col.id]))!.trial_ends_at, once)
})

// ---------- authorization ----------

test('a guest cannot download attachments of threads not shared with them', async () => {
  const fx = await fixture()
  const guest = await fx.mk('Guest', 'guest')
  const shared = await fx.thread('Shared')
  const priv = await fx.thread('Private')
  await grantThreadAccess(guest.id, shared.id)
  await storeAttachment(priv.msgId, 'payroll.pdf', 'application/pdf', Buffer.from('SECRET'))
  await storeAttachment(shared.msgId, 'ok.pdf', 'application/pdf', Buffer.from('FINE'))
  const [privAtt, okAtt] = [
    (await get<any>('SELECT id FROM attachments WHERE message_id = ?', [priv.msgId]))!,
    (await get<any>('SELECT id FROM attachments WHERE message_id = ?', [shared.msgId]))!,
  ]
  assert.equal((await app.request(`/attachment/${privAtt.id}`, { headers: guest.cookie })).status, 404)
  assert.equal((await app.request(`/attachment/${okAtt.id}`, { headers: guest.cookie })).status, 200)
})

test('one-click links: a scanner GET does nothing; guests, readers and removed members can\'t act', async () => {
  const fx = await fixture()
  const sender = await fx.mk('Sender', 'member')
  const guest = await fx.mk('Guest', 'guest')
  const gone = await fx.mk('Gone', 'member')
  await run('UPDATE members SET removed_at = ? WHERE id = ?', [now(), gone.id])
  const t = await fx.thread('Triage')
  await grantThreadAccess(guest.id, t.id)
  const status = async () => (await get<any>('SELECT status, assignee_member_id FROM threads WHERE id = ?', [t.id]))!
  for (const by of [guest.id, gone.id]) {
    await app.request(`/a/${signToken({ a: 'spam', th: t.id, by }, 3600)}`, { method: 'POST' })
    await app.request(`/a/${signToken({ a: 'assign', th: t.id, tg: by, by, r: 0 }, 3600)}`, { method: 'POST' })
  }
  assert.deepEqual(await status(), { status: 'needs_reply', assignee_member_id: null })
  await app.request(`/a/${signToken({ a: 'spam', th: t.id, by: sender.id }, 3600)}`)
  assert.equal((await status()).status, 'needs_reply', 'GET is inert')
  // and the notification only offers what the recipient may do
  const mails = await capture(async () => notifyInbound((await get<any>('SELECT * FROM collectives WHERE id = ?', [fx.col.id]))!,
    (await get<any>('SELECT * FROM threads WHERE id = ?', [t.id]))!, (await get<any>('SELECT * FROM messages WHERE id = ?', [t.msgId]))!))
  const toGuest = mails.find((m) => m.to === guest.email)!
  assert.doesNotMatch(toGuest.html, /Mark as spam|Assign to me/)
  assert.doesNotMatch(toGuest.html, /Just reply to this email/)
})

test('a guest\'s pages say nothing about threads not shared with them', async () => {
  const fx = await fixture()
  const guest = await fx.mk('Guest', 'guest')
  const shared = await fx.thread('Shared', 'customer@out.test')
  await fx.thread('TOPSECRET merger plan', 'customer@out.test')
  const tg = await run("INSERT INTO tags (collective_id, name, created_at) VALUES (?, 'layoffs-2027', ?)", [fx.col.id, now()]).catch(() => run("INSERT INTO tags (collective_id, name) VALUES (?, 'layoffs-2027')", [fx.col.id]))
  const other = await fx.thread('Other')
  await run('INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [other.id, tg.lastId])
  await grantThreadAccess(guest.id, shared.id)
  const page = await (await app.request(`/inbox/${fx.slug}/thread/${shared.id}`, { headers: guest.cookie })).text()
  assert.doesNotMatch(page, /TOPSECRET/)
  const inbox = await (await app.request(`/inbox/${fx.slug}?f=all`, { headers: guest.cookie })).text()
  assert.doesNotMatch(inbox, /layoffs-2027/)
})

test('auto-assign rules only point at members of the same collective', async () => {
  const fx = await fixture()
  const admin = await fx.mk('Admin', 'admin')
  const otherCol = await createCollective(`ot${uniq()}`, 'Other Co')
  const foreign = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Bob Victim', 'member', 'every', ?)", [otherCol.id, `bob-${uniq()}@t.test`, now()])
  const res = await form(`/inbox/${fx.slug}/contact/${encodeURIComponent('x@out.test')}/auto-assign`, admin.cookie, { member_id: String(foreign.lastId) })
  assert.doesNotMatch(decodeURIComponent(res.headers.get('location') || ''), /Bob Victim/)
  assert.equal(await get('SELECT 1 FROM rules WHERE collective_id = ? AND assign_member_id = ?', [fx.col.id, foreign.lastId]), undefined)
})

// ---------- content ----------

test('rewriting widths in a notification cannot smuggle markup past the sanitizer', async () => {
  const fx = await fixture()
  await fx.mk('Admin', 'admin')
  const t = await fx.thread('Newsletter')
  const evil = sanitizeEmailHtml('<p>Hello there friend, a long enough body.</p><img src="https://x.test/a.png" alt=" width=600 onerror=alert(1) "><a href="https://x.test" title=" width=600 href=javascript:alert(1) ">x</a>')
  await run('UPDATE messages SET body_html = ? WHERE id = ?', [evil, t.msgId])
  const mails = await capture(async () => notifyInbound((await get<any>('SELECT * FROM collectives WHERE id = ?', [fx.col.id]))!,
    (await get<any>('SELECT * FROM threads WHERE id = ?', [t.id]))!, (await get<any>('SELECT * FROM messages WHERE id = ?', [t.msgId]))!))
  assert.ok(mails.length)
  for (const m of mails) {
    assert.doesNotMatch(m.html, /\sonerror\s*=/i)
    assert.doesNotMatch(m.html, /href\s*=\s*["']?javascript:/i)
  }
})

test('?f=constructor neither breaks nor sticks to the inbox; every response carries security headers', async () => {
  const fx = await fixture()
  const m = await fx.mk('Admin', 'admin')
  const res = await app.request(`/inbox/${fx.slug}?f=constructor`, { headers: m.cookie })
  assert.equal(res.status, 200)
  assert.equal((await app.request(`/inbox/${fx.slug}`, { headers: m.cookie })).status, 200)
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
})

test('the waitlist escapes what a stranger typed in the email to admins', async () => {
  const mails = await capture(() => form('/waitlist', {}, { email: `<a/href="//evil">x</a>@x.co`, collective_name: 'abcdefgh' }))
  for (const m of mails) assert.doesNotMatch(m.html, /<a\/href/)
  const ok = await capture(() => form('/waitlist', {}, { email: `wl-${uniq()}@x.co`, collective_name: 'abcdefgh' }))
  assert.ok(ok.length >= 1, 'a normal signup still notifies')
})

test('names never carry line breaks into raw email headers', async () => {
  const fx = await fixture()
  const m = await fx.mk('Admin', 'admin')
  await form(`/inbox/${fx.slug}/profile`, m.cookie, { name: 'x <ceo@bigorg.org>\r\nX-Evil: 1' })
  const name = (await get<any>('SELECT name FROM members WHERE id = ?', [m.id]))!.name
  assert.doesNotMatch(name, /[\r\n]/)
})

test('an outsider adding X-Original-From is not treated as a team member', async () => {
  const fx = await fixture()
  const alice = await fx.mk('Alice', 'member')
  const t = await fx.thread('Help with booking')
  const { ingestInbound } = await import('../src/ingest.js')
  await ingestInbound((await get<any>('SELECT * FROM collectives WHERE id = ?', [fx.col.id]))!, await simpleParser([
    'From: Mallory <mallory@evil.test>', `X-Original-From: ${alice.email}`, `To: ${fx.slug}@collective.email, customer@out.test`,
    'Subject: Re: Help with booking', `Message-ID: <m-${uniq()}@evil.test>`, '', 'All sorted, no need to reply.',
  ].join('\r\n')))
  const th = (await get<any>('SELECT status, assignee_member_id FROM threads WHERE id = ?', [t.id]))!
  assert.notEqual(th.status, 'answered')
  assert.notEqual(th.assignee_member_id, alice.id)
  assert.equal((await all<any>("SELECT id FROM messages WHERE sent_by_member_id = ?", [alice.id])).length, 0)
})
