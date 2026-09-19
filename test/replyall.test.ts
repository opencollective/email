import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { replyAllCc } from '../src/outbound.js'
import { now } from '../src/util.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

async function fixture() {
  const slug = `ra${uniq()}`
  const collective = await createCollective(slug, 'Reply All Co')
  await run("UPDATE collectives SET plan = 'pro', custom_domain = 'chb.test', custom_local = 'hello', domain_status = 'verified' WHERE id = ?", [collective.id])
  const email = `leen-${uniq()}@t.test`
  const m = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, 'Leen', 'admin', 'every', ?)", [collective.id, email, now()])
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'cedric@chb.test', 'Cedric', 'member', 'every', ?)", [collective.id, now()])
  await run("INSERT INTO member_aliases (collective_id, member_id, email, created_at) VALUES (?, ?, 'leen.private@gmail.test', ?)", [collective.id, m.lastId, now()])
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Zaalgebruik', 'needs_reply', 'vincent@gmail.test', 'Vincent', ?, ?, 'inbound', ?, ?)`, [collective.id, now(), now(), now(), now()])
  return { collective: (await get<any>('SELECT * FROM collectives WHERE id = ?', [collective.id]))!, slug, threadId: t.lastId, sid: await createSession(email), email }
}
const inbound = (threadId: number, to: string[], cc: string[], at = now()) => run(
  `INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, cc_json, body_text, sent_at, created_at)
   VALUES (?, ?, 'inbound', 'vincent@gmail.test', 'Vincent', ?, ?, 'hi', ?, ?)`,
  [threadId, `<ra-${uniq()}@x>`, JSON.stringify(to), JSON.stringify(cc), at, at])

test('reply-all: everyone on the last inbound email, minus us, minus the sender', async () => {
  const fx = await fixture()
  await inbound(fx.threadId, ['hello@chb.test', 'Fellow@sma.test'], ['cedric@chb.test', 'leen.private@gmail.test', 'anna@sma.test', `${fx.slug}@collective.email`, 'reply-abc@collective.email', 'vincent@gmail.test'])
  const thread = (await get<any>('SELECT * FROM threads WHERE id = ?', [fx.threadId]))!
  assert.deepEqual(await replyAllCc(fx.collective, thread), ['fellow@sma.test', 'anna@sma.test'],
    'external people only: not the inbox, not our domain, not the team or its aliases, not the counterpart')
})

test('the reply form is reply-all: Cc prefilled and open, the footer names everyone, sending honours it', async () => {
  const fx = await fixture()
  await inbound(fx.threadId, ['hello@chb.test'], ['anna@sma.test', 'bob@sma.test'], now() - 100)
  await inbound(fx.threadId, ['hello@chb.test'], ['anna@sma.test'], now()) // Bob dropped on the latest email
  const html = await (await app.request(`/inbox/${fx.slug}/thread/${fx.threadId}`, { headers: { cookie: `requests_sid=${fx.sid}` } })).text()
  const form = html.slice(html.indexOf('data-pane="reply"'), html.indexOf('data-pane="note"'))
  assert.match(form, /<details class="ccb" open/, 'the Cc line is open when it carries people')
  assert.match(form, /name="cc" value="anna@sma.test"/, 'the last email decides, like a mail client')
  assert.match(form, /copying <b data-cc-echo="true">anna@sma.test<\/b>/)
  assert.match(form, /Sending to <b>vincent@gmail.test<\/b>/)

  // sending with the prefilled Cc copies Anna; the thread remembers her
  const res = await app.request(`/inbox/${fx.slug}/thread/${fx.threadId}/reply`, {
    method: 'POST', headers: { cookie: `requests_sid=${fx.sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: 'Ja, dat kan.', cc: 'anna@sma.test', bcc: '' }),
  })
  assert.equal(res.status, 302)
  const sent = (await get<any>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1", [fx.threadId]))!
  assert.deepEqual(JSON.parse(sent.cc_json), ['anna@sma.test'])
  assert.deepEqual(JSON.parse((await get<any>('SELECT cc_json FROM threads WHERE id = ?', [fx.threadId]))!.cc_json), ['anna@sma.test'])

  // the sender took Anna off — the next reply respects that, and the footer's hidden copy line is there for the script
  const res2 = await app.request(`/inbox/${fx.slug}/thread/${fx.threadId}/reply`, {
    method: 'POST', headers: { cookie: `requests_sid=${fx.sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: 'Alleen voor jou.', cc: '', bcc: '' }),
  })
  assert.equal(res2.status, 302)
  const sent2 = (await get<any>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1", [fx.threadId]))!
  assert.deepEqual(JSON.parse(sent2.cc_json), [])
})

test('a reply that omits Cc (one-click, email-in) is reply-all too, minus people the member already copied', async () => {
  const fx = await fixture()
  await inbound(fx.threadId, ['hello@chb.test'], ['anna@sma.test', 'bob@sma.test'])
  const { sendCollectiveReply } = await import('../src/outbound.js')
  const member = (await get<any>('SELECT * FROM members WHERE email = ?', [fx.email]))!
  const msg = await sendCollectiveReply(fx.collective, fx.threadId, 'Dag allemaal', member, 'email', [], undefined, [], ['bob@sma.test'])
  assert.deepEqual(JSON.parse(msg.cc_json || '[]').sort(), ['anna@sma.test', 'bob@sma.test'].sort(), 'the archive lists everyone in the conversation')
})
