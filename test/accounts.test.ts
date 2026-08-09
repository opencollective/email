import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Member } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now, randomToken } from '../src/util.js'
import { __observeAppMail, type AppMail } from '../src/appmail.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function collectiveWith(email: string, role = 'admin') {
  const slug = `acct${uniq()}`
  const col = await createCollective(slug, `Collective ${slug}`)
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, email, email.split('@')[0], role, 'every', now()])
  return col
}

const cookie = (tokens: string[]) => `requests_sid=${tokens.join('.')}`
const getPage = (path: string, tokens: string[]) => app.request(path, { headers: { cookie: cookie(tokens) } })
const postForm = (path: string, tokens: string[], body: Record<string, string>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie(tokens) },
    body: new URLSearchParams(body),
  })

/** Both accounts signed in at once — the heart of the feature. */
async function twoAccounts() {
  const emailA = `xavier-${uniq()}@gmail.test`
  const emailB = `xavier-${uniq()}@yahoo.test`
  const colA = await collectiveWith(emailA)
  const colB = await collectiveWith(emailB)
  const tokens = [await createSession(emailA), await createSession(emailB)]
  return { emailA, emailB, colA, colB, tokens }
}

test('one cookie, two accounts: each inbox resolves its own identity', async () => {
  const { emailA, emailB, colA, colB, tokens } = await twoAccounts()

  const pageA = await getPage(`/inbox/${colA.slug}`, tokens)
  assert.equal(pageA.status, 200)
  assert.match(await pageA.text(), new RegExp(emailA), 'inbox A acts as the gmail account')

  const pageB = await getPage(`/inbox/${colB.slug}`, tokens)
  assert.equal(pageB.status, 200)
  assert.match(await pageB.text(), new RegExp(emailB), 'inbox B acts as the yahoo account — no logout in between')
})

test('the switcher aggregates collectives across every signed-in account', async () => {
  const { colA, colB, emailA, emailB, tokens } = await twoAccounts()
  const d = await (await getPage('/mailboxes', tokens)).json() as any
  assert.equal(d.accounts, 2)
  const bySlug = new Map(d.mailboxes.map((m: any) => [m.slug, m]))
  assert.equal((bySlug.get(colA.slug) as any).email, emailA)
  assert.equal((bySlug.get(colB.slug) as any).email, emailB)
})

test('signing out of one account leaves the other signed in', async () => {
  const { emailA, colA, colB, tokens } = await twoAccounts()

  const res = await postForm('/logout', tokens, { email: emailA })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?m=' + encodeURIComponent(`Signed out of ${emailA}.`))
  const rewritten = /requests_sid=([^;]*)/.exec(res.headers.get('set-cookie') || '')![1]
  assert.equal(decodeURIComponent(rewritten).split('.').length, 1, 'one token left in the cookie')

  // A's session is dead even if someone replays the old cookie
  const a = await getPage(`/inbox/${colA.slug}`, tokens)
  assert.notEqual(a.status, 200, 'the signed-out account no longer works')
  // B sails on with the rewritten cookie
  const b = await app.request(`/inbox/${colB.slug}`, { headers: { cookie: `requests_sid=${decodeURIComponent(rewritten)}` } })
  assert.equal(b.status, 200)
})

test('signing in again adds an account instead of replacing the session', async () => {
  const emailA = `first-${uniq()}@gmail.test`
  const emailB = `second-${uniq()}@yahoo.test`
  const colA = await collectiveWith(emailA)
  const colB = await collectiveWith(emailB)
  const tokenA = await createSession(emailA)

  // B signs in by code while A's cookie is present
  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await postForm('/login', [tokenA], { email: emailB })
    const code = /(\d{6})/.exec(sent.find((m) => m.to === emailB)!.text)![1]
    const res = await postForm('/verify', [tokenA], { email: emailB, code })
    assert.equal(res.status, 302)
    const merged = decodeURIComponent(/requests_sid=([^;]*)/.exec(res.headers.get('set-cookie') || '')![1]).split('.')
    assert.equal(merged.length, 2, 'both sessions in the cookie')
    assert.equal(merged[0], tokenA, "A's session is untouched")
    // and the merged cookie opens both inboxes
    assert.equal((await app.request(`/inbox/${colA.slug}`, { headers: { cookie: `requests_sid=${merged.join('.')}` } })).status, 200)
    assert.equal((await app.request(`/inbox/${colB.slug}`, { headers: { cookie: `requests_sid=${merged.join('.')}` } })).status, 200)
  } finally {
    __observeAppMail(null)
  }
})

test('an invite offers the signed-in account, and joining with it needs no code', async () => {
  const { emailA, tokens } = await twoAccounts()
  const inviter = `owner-${uniq()}@example.org`
  const col = await collectiveWith(inviter)
  const token = randomToken(24)
  await run("INSERT INTO invites (collective_id, token, created_at, expires_at, role) VALUES (?, ?, ?, ?, 'commenter')",
    [col.id, token, now(), now() + 86400])

  const page = await (await getPage(`/join/${token}`, tokens)).text()
  assert.match(page, new RegExp(emailA))
  assert.match(page, /no code needed/i)
  assert.match(page, /Another email/i, 'picking a different address stays possible')

  const res = await postForm(`/join/${token}`, tokens, { account: emailA, name: 'Xavier', level: 'daily' })
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location')!, new RegExp(`^/inbox/${col.slug}`))
  const m = (await get<Member>('SELECT * FROM members WHERE collective_id = ? AND email = ?', [col.id, emailA]))!
  assert.equal(m.role, 'commenter')
  assert.equal(m.name, 'Xavier')
  assert.equal((await all('SELECT id FROM login_codes WHERE email = ?', [emailA])).length, 0, 'no code was ever issued')
})

test('the invite cannot be joined as an email that is not actually signed in', async () => {
  const { tokens } = await twoAccounts()
  const stranger = `victim-${uniq()}@example.org`
  const col = await collectiveWith(`owner-${uniq()}@example.org`)
  const token = randomToken(24)
  await run("INSERT INTO invites (collective_id, token, created_at, expires_at, role) VALUES (?, ?, ?, ?, 'reader')",
    [col.id, token, now(), now() + 86400])

  const res = await postForm(`/join/${token}`, tokens, { account: stranger, name: 'X', level: 'daily' })
  assert.equal(res.headers.get('location'), `/join/${token}`, 'bounced back')
  assert.equal(await get('SELECT id FROM members WHERE collective_id = ? AND email = ?', [col.id, stranger]), undefined,
    'the form naming an email is not proof of owning it')
})

test('an invite with "another email" still goes through the code flow', async () => {
  const { tokens } = await twoAccounts()
  const other = `fresh-${uniq()}@example.org`
  const col = await collectiveWith(`owner-${uniq()}@example.org`)
  const token = randomToken(24)
  await run("INSERT INTO invites (collective_id, token, created_at, expires_at, role) VALUES (?, ?, ?, ?, 'reader')",
    [col.id, token, now(), now() + 86400])

  const res = await postForm(`/join/${token}`, tokens, { account: 'other', email: other, name: 'New', level: 'daily' })
  assert.match(await res.text(), /check your inbox/i)
  assert.ok(await get('SELECT id FROM login_codes WHERE email = ?', [other]), 'code issued for the new address')
  assert.equal(await get('SELECT id FROM members WHERE collective_id = ? AND email = ?', [col.id, other]), undefined,
    'not a member until the code comes back')
})

test('the home page groups collectives per account with independent sign-out', async () => {
  const { emailA, emailB, tokens } = await twoAccounts()
  const html = await (await getPage('/', tokens)).text()
  assert.match(html, new RegExp(emailA))
  assert.match(html, new RegExp(emailB))
  assert.match(html, /Add another account/)
  assert.match(html, /Sign out of all accounts/)
  // one per-account sign-out form each
  assert.equal((html.match(/name="email" value="/g) || []).length, 2)
})

// ---------- activation: a collective is at least two people ----------

test('a reserved address goes live when a second person accepts the invite', async () => {
  const founder = `founder-${uniq()}@example.org`
  const slug = `pend${uniq()}`
  const col = await createCollective(slug, 'Pending Co', 'collective', { status: 'pending' })
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, founder, 'Founder', 'admin', 'every', now()])
  const invite = randomToken(18)
  await run("INSERT INTO invites (collective_id, token, created_at, expires_at, role) VALUES (?, ?, ?, ?, 'reader')",
    [col.id, invite, now(), now() + 86400])

  // the second human joins with a signed-in account — that is the activation
  const second = `second-${uniq()}@example.org`
  const tok = await createSession(second)
  const res = await postForm(`/join/${invite}`, [tok], { account: second, name: 'Sam', level: 'daily' })
  assert.equal(res.status, 302)

  const fresh = (await get<any>('SELECT status, trial_ends_at, activated_at FROM collectives WHERE id = ?', [col.id]))!
  assert.equal(fresh.status, 'active')
  assert.ok(fresh.trial_ends_at > now() + 29 * 86400 && fresh.trial_ends_at < now() + 31 * 86400, '30-day trial started')
  assert.ok(fresh.activated_at)
})

test('the instant self-serve trial is gone, and agents can read the flow', async () => {
  const res = await app.request('/claim/whatever/trial', { method: 'POST' })
  assert.equal(res.status, 404, 'no more one-click activation without a second human')

  const llms = await app.request('/llms.txt')
  assert.equal(llms.status, 200)
  const text = await llms.text()
  assert.match(text, /POST .*\/claim/)
  assert.match(text, /second person accepts the invite/i)
  assert.match(text, /\/compose/)
  assert.match(await (await app.request('/robots.txt')).text(), /llms\.txt/)
})
