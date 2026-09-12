import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCollective, get, grantThreadAccess, kvGet, run } from '../src/db.js'
import { digestTick } from '../src/notify.js'
import { cfg } from '../src/config.js'
import { now } from '../src/util.js'
import { __observeAppMail, type AppMail } from '../src/appmail.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

/** A clock at the digest hour. `dayOffset` moves it whole days; Monday = weekly day. */
function clock(dayOffset = 0, opts: { monday?: boolean } = {}) {
  const d = new Date()
  d.setHours(cfg.digestHour, 30, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  if (opts.monday) while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
  return d
}
const ts = (d: Date) => Math.floor(d.getTime() / 1000)

async function fixture(level: 'daily' | 'weekly' = 'daily') {
  const slug = `dg${uniq()}`
  const collective = await createCollective(slug, 'Digest Co')
  const email = `alice-${uniq()}@t.test`
  const admin = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, email, 'Alice', 'admin', 'every', now()])
  const readerEmail = `bob-${uniq()}@t.test`
  await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collective.id, readerEmail, 'Bob', 'member', level, now()])
  const thread = async (subject: string, at: number, status = 'needs_reply') => {
    const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, ?, 'marie@out.test', 'Marie Dupont', ?, ?, 'inbound', ?, ?)`, [collective.id, subject, status, at, at, at, at])
    return t.lastId
  }
  const inbound = (threadId: number, at: number, body: string) => run(
    `INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
     VALUES (?, ?, 'inbound', 'marie@out.test', 'Marie Dupont', '[]', ?, ?, ?)`, [threadId, `<dg-${uniq()}@x>`, body, at, at])
  const reply = (threadId: number, at: number, body: string, sentAt: number | null = at) => run(
    `INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_by_member_id, sent_at, created_at)
     VALUES (?, ?, 'outbound', ?, 'Digest Co', '["marie@out.test"]', ?, ?, ?, ?)`, [threadId, `<dg-${uniq()}@x>`, `${slug}@collective.email`, body, admin.lastId, sentAt, at])
  return { collective, slug, adminId: admin.lastId, readerEmail, thread, inbound, reply }
}

async function tick(at: Date): Promise<AppMail[]> {
  const mails: AppMail[] = []
  __observeAppMail((m) => mails.push(m))
  try { await digestTick(at) } finally { __observeAppMail(null) }
  return mails
}

test('daily digest: what came in and went out in the last day, thread by thread', async () => {
  const fx = await fixture('daily')
  const at = clock()
  const t1 = await fx.thread('Room booking', ts(at) - 3 * 3600)
  await fx.inbound(t1, ts(at) - 5 * 3600, 'Could we book the big room on Friday?')
  await fx.reply(t1, ts(at) - 4 * 3600, 'Yes, Friday works.')
  await fx.inbound(t1, ts(at) - 3 * 3600, 'Great, see you then.')
  const t2 = await fx.thread('Old news', ts(at) - 3 * 86400, 'answered')
  await fx.inbound(t2, ts(at) - 3 * 86400, 'This was days ago') // outside the window
  const t3 = await fx.thread('Draft only', ts(at) - 3600)
  await fx.reply(t3, ts(at) - 3600, 'unsent draft', null) // no sent_at → not traffic

  const mails = await tick(at)
  const mine = mails.filter((m) => m.to === fx.readerEmail)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].subject, '2 emails in, 1 reply out — daily digest')
  assert.match(mine[0].html, /Room booking/)
  assert.match(mine[0].html, /↓ Marie Dupont<\/span> — Could we book/)
  assert.match(mine[0].html, /↑ Alice replied<\/span> — Yes, Friday works/)
  assert.doesNotMatch(mine[0].html, /Old news/, 'nothing from before the window')
  assert.doesNotMatch(mine[0].html, /Draft only/, 'unsent drafts are not traffic')
  assert.match(mine[0].html, /2 conversations still need a reply/)
  assert.equal(mails.filter((m) => m.to !== fx.readerEmail).length, 0, "the 'every' member gets no digest")
})

test('a quiet day sends nothing, and the next digest covers everything since the previous one', async () => {
  const fx = await fixture('daily')
  const day1 = clock()
  const t1 = await fx.thread('First', ts(day1) - 3600)
  await fx.inbound(t1, ts(day1) - 3600, 'day one')
  assert.equal((await tick(day1)).filter((m) => m.to === fx.readerEmail).length, 1)
  const stamped = Number(await kvGet(`digest:${(await get<any>('SELECT id FROM members WHERE email = ?', [fx.readerEmail]))!.id}`))
  assert.equal(stamped, ts(day1))

  // day two: nothing happened → no email, no stamp
  const day2 = clock(1)
  assert.equal((await tick(day2)).filter((m) => m.to === fx.readerEmail).length, 0)

  // day three: one new email → the digest covers days two and three, not day one again
  const day3 = clock(2)
  await fx.inbound(t1, ts(day3) - 2 * 3600, 'day three follow-up')
  const mails = (await tick(day3)).filter((m) => m.to === fx.readerEmail)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, '1 email in, 0 replies out — daily digest')
  assert.match(mails[0].html, /day three follow-up/)
  assert.doesNotMatch(mails[0].html, /day one/)
})

test('weekly digest: Mondays only, the past week, nothing when the week was quiet', async () => {
  const fx = await fixture('weekly')
  const monday = clock(0, { monday: true })
  const t1 = await fx.thread('Grant', ts(monday) - 3 * 86400)
  await fx.inbound(t1, ts(monday) - 3 * 86400, 'midweek email')
  await fx.reply(t1, ts(monday) - 2 * 86400, 'midweek answer')
  const t2 = await fx.thread('Stale', ts(monday) - 10 * 86400, 'answered')
  await fx.inbound(t2, ts(monday) - 10 * 86400, 'ten days ago')

  // not a Monday → nothing, whatever happened
  const tuesday = new Date(monday); tuesday.setDate(tuesday.getDate() + 1)
  assert.equal((await tick(tuesday)).filter((m) => m.to === fx.readerEmail).length, 0)

  const mails = (await tick(monday)).filter((m) => m.to === fx.readerEmail)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, '1 email in, 1 reply out — weekly digest')
  assert.match(mails[0].html, /midweek email/)
  assert.doesNotMatch(mails[0].html, /ten days ago/)

  // a quiet week later: silence
  const nextMonday = new Date(monday); nextMonday.setDate(nextMonday.getDate() + 7)
  assert.equal((await tick(nextMonday)).filter((m) => m.to === fx.readerEmail).length, 0)
})

test('a guest only hears about the threads shared with them', async () => {
  const fx = await fixture('daily')
  const at = clock()
  const guestEmail = `guest-${uniq()}@t.test`
  const guest = await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.collective.id, guestEmail, 'Guest', 'guest', 'daily', now()])
  const shared = await fx.thread('Shared with guest', ts(at) - 3600)
  await fx.inbound(shared, ts(at) - 3600, 'for the guest')
  await grantThreadAccess(guest.lastId, shared)
  const secret = await fx.thread('Not theirs', ts(at) - 3600)
  await fx.inbound(secret, ts(at) - 3600, 'members only')

  const mails = (await tick(at)).filter((m) => m.to === guestEmail)
  assert.equal(mails.length, 1)
  assert.match(mails[0].html, /Shared with guest/)
  assert.doesNotMatch(mails[0].html, /Not theirs/)
  assert.doesNotMatch(mails[0].html, /members only/)
})
