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

async function fixture() {
  const slug = `rn${uniq()}`
  const col = await createCollective(slug, 'Renotify Co')
  for (const [email, name] of [['admin@test.local', 'Xavier'], [`leen-${uniq()}@t.test`, 'Leen']]) {
    await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, 'admin', 'every', ?)", [col.id, email, name, now()])
  }
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Re: Change email on account', 'needs_reply', 'noreply@odoo.test', ?, ?, 'inbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  const html = '<table width="600"><tr><td><p>Your ticket <b>6622915</b> was successfully updated.</p><a href="https://odoo.test/t">View Ticket</a></td></tr></table>'
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, body_html, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'noreply@odoo.test', 'Odoo Support Team', '[]', 'odoo_logo_purple_small [4]', ?, ?, ?)`, [t.lastId, `<rn-${uniq()}@x>`, html, now(), now()])
  return { slug, col: (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!, thread: (await get<any>('SELECT * FROM threads WHERE id = ?', [t.lastId]))! }
}

test('notifications show the HTML email, not its junk text part; text-only mail keeps the text', async () => {
  const fx = await fixture()
  const msg = (await get<any>('SELECT * FROM messages WHERE thread_id = ?', [fx.thread.id]))!
  const mails = await capture(() => notifyInbound(fx.col, fx.thread, msg))
  assert.ok(mails.length >= 1)
  assert.match(mails[0].html, /Your ticket <b>6622915<\/b> was successfully updated/)
  assert.doesNotMatch(mails[0].html, /odoo_logo_purple_small/)
  assert.match(mails[0].html, /max-width:720px;margin:0;padding:4px 0 0/, 'no side padding of its own: the mail app already has margins')

  await run("UPDATE messages SET body_html = NULL, body_text = 'Plain hello' WHERE id = ?", [msg.id])
  const plain = await capture(async () => notifyInbound(fx.col, fx.thread, (await get<any>('SELECT * FROM messages WHERE id = ?', [msg.id]))!))
  assert.match(plain[0].html, /Plain hello/)
})

test('admin "resend to me": only to a signed-in account of the admin that is a member there', async () => {
  const fx = await fixture()
  const sid = await createSession('admin@test.local')
  const post = (fields: Record<string, string>, s = sid) => app.request('/admin/renotify', {
    method: 'POST', headers: { cookie: `requests_sid=${s}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  })
  const url = `https://collective.email/inbox/${fx.slug}/thread/${fx.thread.id}`
  let mails = await capture(() => post({ url, account: 'admin@test.local' }))
  assert.deepEqual(mails.map((m) => m.to), ['admin@test.local'], 'one email, to the admin only — not the whole team')

  // naming an address the session does not hold changes nothing
  mails = await capture(() => post({ url, account: 'someone@else.test' }))
  assert.deepEqual(mails.map((m) => m.to), ['admin@test.local'])
  // non-admins cannot use it at all
  const other = await createSession(`x-${uniq()}@t.test`)
  assert.equal((await post({ url }, other)).status, 404)
})

test('fitWidths: fixed desktop widths become "fill, at most that wide"; small ones and proportions are kept', async () => {
  const { fitWidths } = await import('../src/notify.js')
  const out = fitWidths('<table width="600" style="background:#eee"><tr><td style="width:560px;padding:30px"><img src=x width="680" height="120"><img src=y width="40"></td></tr></table>')
  assert.doesNotMatch(out, /\swidth="(600|680)"/)
  assert.match(out, /style="width:100%;max-width:560px;padding:30px"/)
  assert.match(out, /<img style="max-width:100%;height:auto" src=x/)
  assert.match(out, /width="40"/, 'icons keep their size')
})
