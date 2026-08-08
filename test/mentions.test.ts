import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Member } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { findMentions, mentionedMembers, noteParts } from '../src/mentions.js'
import { resolveReplyAddress } from '../src/reply-tokens.js'
import { __observeAppMail, type AppMail } from '../src/appmail.js'

let seq = 0
const uniq = () => `${Date.now() % 1000000}${++seq}`

const member = (id: number, name: string, email: string): Member => ({
  id, collective_id: 1, email, name, role: 'member', notify_level: 'every',
  avatar_path: null, created_at: 0, last_seen_at: null, removed_at: null,
})

const ROSTER = [
  member(1, 'Marie Dupont', 'marie@example.org'),
  member(2, 'Leen Schelfhout', 'leen@example.org'),
  member(3, '', 'inge@example.org'),
]

// ---------- parser ----------

test('mentions: resolves full names, first names, login names and emails', () => {
  const ids = (body: string) => mentionedMembers(body, ROSTER).map((m) => m.id)
  assert.deepEqual(ids('@Marie Dupont can you take this?'), [1])
  assert.deepEqual(ids('ping @leen please'), [2])
  assert.deepEqual(ids('@marie@example.org knows'), [1])
  assert.deepEqual(ids('cc @inge'), [3]) // no name set → the email local part
  assert.deepEqual(ids('@Marie and @Leen Schelfhout both'), [1, 2])
})

test('mentions: case-insensitive, and each person is reported once', () => {
  assert.deepEqual(mentionedMembers('@MARIE @marie @Marie Dupont', ROSTER).map((m) => m.id), [1])
})

test('mentions: prefers the longest match', () => {
  const [hit] = findMentions('@Marie Dupont here', ROSTER)
  assert.equal(hit.member.id, 1)
  assert.equal(hit.end, '@Marie Dupont'.length)
})

test('mentions: an email address in prose is not a mention', () => {
  assert.deepEqual(mentionedMembers('write to hello@example.org instead', ROSTER), [])
  assert.deepEqual(mentionedMembers('bounced from x@marie@example.org', ROSTER), [])
})

test('mentions: unknown handles and bare @ are left alone', () => {
  assert.deepEqual(mentionedMembers('@nobody @ @123 see you @ 5pm', ROSTER), [])
})

test('mentions: an ambiguous first name needs the surname', () => {
  const twoMaries = [
    member(1, 'Marie Dupont', 'mdupont@example.org'),
    member(4, 'Marie Curie', 'mcurie@example.org'),
  ]
  assert.deepEqual(mentionedMembers('@Marie ?', twoMaries), [])
  assert.deepEqual(mentionedMembers('@Marie Curie ?', twoMaries).map((m) => m.id), [4])
  assert.deepEqual(mentionedMembers('@Marie Dupont ?', twoMaries).map((m) => m.id), [1])
})

test('mentions: a login name still resolves when the first name is shared', () => {
  // "marie" is Marie Dupont's address, so it points at her even though a second
  // Marie exists — the ambiguity rule only holds back bare first names
  const twoMaries = [...ROSTER, member(4, 'Marie Curie', 'mcurie@example.org')]
  assert.deepEqual(mentionedMembers('@marie ?', twoMaries).map((m) => m.id), [1])
})

test('mentions: a mention runs to the end of an accented name', () => {
  const roster = [member(9, 'José Ramos', 'jose@example.org')]
  assert.deepEqual(mentionedMembers('@José can you look?', roster).map((m) => m.id), [9])
})

test('noteParts: splits the body into text and mention runs', () => {
  const parts = noteParts('hey @Leen — ask @Marie Dupont', ROSTER)
  assert.deepEqual(parts, [
    { text: 'hey ' },
    { mention: '@Leen', member: ROSTER[1] },
    { text: ' — ask ' },
    { mention: '@Marie Dupont', member: ROSTER[0] },
  ])
  // the parts always reassemble into the original text
  assert.equal(parts.map((p) => ('text' in p ? p.text : p.mention)).join(''), 'hey @Leen — ask @Marie Dupont')
})

// ---------- end to end: posting a note notifies the mentioned member ----------

async function addMember(collectiveId: number, email: string, name: string, role = 'member'): Promise<number> {
  const r = await run(
    'INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [collectiveId, email, name, role, 'every', now()])
  return r.lastId
}

async function fixture() {
  const slug = `mentions${uniq()}`
  const collective = await createCollective(slug, 'Mentions Test')
  const authorEmail = `author-${uniq()}@example.org`
  const authorId = await addMember(collective.id, authorEmail, 'Xavier Damman', 'admin')
  const targetId = await addMember(collective.id, `target-${uniq()}@example.org`, 'Marie Dupont')
  const target = (await get<Member>('SELECT * FROM members WHERE id = ?', [targetId]))!
  const thread = await run(
    `INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
      first_message_at, last_message_at, created_at, updated_at) VALUES (?, ?, 'needs_reply', ?, ?, ?, ?, ?, ?)`,
    [collective.id, 'Booking the big room', 'sender@outside.test', 'Outside Sender', now(), now(), now(), now()])
  const sid = await createSession(authorEmail)
  return { collective, slug, authorId, authorEmail, target, threadId: thread.lastId, sid }
}

const postNote = (slug: string, threadId: number, sid: string, body: string) =>
  app.request(`/inbox/${slug}/thread/${threadId}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams({ body }),
  })

test('posting a note with @mention emails the mentioned member and records it', async () => {
  const { slug, target, threadId, sid, authorEmail } = await fixture()
  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    const res = await postNote(slug, threadId, sid, '@Marie Dupont can you confirm the room is free?')
    assert.equal(res.status, 302)
    assert.match(decodeURIComponent(res.headers.get('location') || ''), /notified Marie Dupont/)

    const mail = sent.find((m) => m.to === target.email)
    assert.ok(mail, 'the mentioned member got an email')
    assert.match(mail.subject, /Xavier Damman mentioned you/)
    assert.match(mail.subject, /Booking the big room/)
    assert.match(mail.text, /can you confirm the room is free\?/)
    // a link to the full thread, and never a reply token pointed at the sender
    assert.match(mail.html, new RegExp(`/inbox/${slug}/thread/${threadId}`))
    // the header names the thread, links it, and says who it came from
    assert.match(mail.html, new RegExp(`mentioned you in an internal note about <a href="[^"]*/inbox/${slug}/thread/${threadId}"[^>]*>Booking the big room</a> from Outside Sender\\.`))
    // one way in, not two
    assert.equal((mail.html.match(/Open thread/g) || []).length, 1)
    assert.doesNotMatch(mail.html, /Reply in the thread/)
    assert.match(mail.html, /Just reply to this email/)

    // replying goes to a note-kind address — never onward to the outside sender
    const addr = /<([^>]+)>$/.exec(mail.replyTo!)![1]
    assert.match(addr, new RegExp(`^note-via-${slug}\\+[a-z0-9]{10}@collective\\.email$`))
    const ref = await resolveReplyAddress(addr)
    assert.equal(ref?.kind, 'note')
    assert.equal(ref?.memberId, target.id, 'the token identifies the recipient')
    assert.notEqual(ref?.authorMemberId, null)
    assert.notEqual(addr, authorEmail)

    const rows = await all<{ member_id: number }>(
      'SELECT nm.member_id FROM note_mentions nm JOIN notes n ON n.id = nm.note_id WHERE n.thread_id = ?', [threadId])
    assert.deepEqual(rows.map((r) => r.member_id), [target.id])
  } finally {
    __observeAppMail(null)
  }
})

test('a note without mentions emails nobody', async () => {
  const { slug, threadId, sid } = await fixture()
  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    const res = await postNote(slug, threadId, sid, 'Checked the calendar — the room is free.')
    assert.equal(res.status, 302)
    assert.equal(decodeURIComponent(res.headers.get('location') || '').includes('notified'), false)
    assert.equal(sent.length, 0)
    assert.deepEqual(await all(
      'SELECT nm.member_id FROM note_mentions nm JOIN notes n ON n.id = nm.note_id WHERE n.thread_id = ?', [threadId]), [])
  } finally {
    __observeAppMail(null)
  }
})

// ---------- replying to a mention email files another internal note ----------

const webhook = (data: Record<string, unknown>) =>
  app.request('/webhooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', data }),
  })

/** Post a mention note, and hand back the address its notification asks you to reply to. */
async function mentionAndGetReplyAddress(fx: Awaited<ReturnType<typeof fixture>>, body: string) {
  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await postNote(fx.slug, fx.threadId, fx.sid, body)
  } finally {
    __observeAppMail(null)
  }
  const mail = sent.find((m) => m.to === fx.target.email)!
  return /<([^>]+)>$/.exec(mail.replyTo!)![1]
}

test('replying to a mention email adds an internal note that starts with @author', async () => {
  const fx = await fixture()
  const addr = await mentionAndGetReplyAddress(fx, '@Marie Dupont can you confirm the room?')

  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    const res = await webhook({
      email_id: `note-${uniq()}`,
      from: `Marie Dupont <${fx.target.email}>`,
      to: [addr],
      subject: `Re: Xavier Damman mentioned you — Booking the big room`,
      message_id: `<reply-${uniq()}@example.org>`,
      text: 'Yes, the 12th is free — I will pencil them in.\n\nOn Fri, Xavier wrote:\n> can you confirm the room?',
    })
    assert.equal((await res.json()).handled, 'member_note')
  } finally {
    __observeAppMail(null)
  }

  const notes = await all<{ member_id: number; body: string }>(
    'SELECT * FROM notes WHERE thread_id = ? ORDER BY id', [fx.threadId])
  assert.equal(notes.length, 2, 'the reply became a second note')
  const reply = notes[1]
  assert.equal(reply.member_id, fx.target.id, 'authored by whoever replied')
  assert.equal(reply.body, '@Xavier Damman Yes, the 12th is free — I will pencil them in.',
    'opens with the person being answered, quoted tail dropped')

  // and that @author round-trips: the original author is notified back
  const back = sent.find((m) => m.to === fx.authorEmail)
  assert.ok(back, 'the member who mentioned them is notified of the answer')
  assert.match(back.subject, /Marie Dupont mentioned you/)

  // nothing was ever sent to the outside sender
  const outbound = await all('SELECT * FROM messages WHERE thread_id = ? AND direction = ?', [fx.threadId, 'outbound'])
  assert.equal(outbound.length, 0, 'a note reply never emails the counterpart')
  assert.equal(sent.some((m) => m.to === 'sender@outside.test'), false)
})

test('a forwarded mention email cannot be used to post as someone else', async () => {
  const fx = await fixture()
  const addr = await mentionAndGetReplyAddress(fx, '@Marie Dupont have a look?')
  const before = (await all('SELECT * FROM notes WHERE thread_id = ?', [fx.threadId])).length

  const res = await webhook({
    email_id: `fwd-${uniq()}`,
    from: 'Random Stranger <stranger@elsewhere.test>',
    to: [addr],
    subject: 'Fwd: mentioned you',
    message_id: `<fwd-${uniq()}@elsewhere.test>`,
    text: 'I am not Marie.',
  })
  assert.equal((await res.json()).handled, 'member_note')
  assert.equal((await all('SELECT * FROM notes WHERE thread_id = ?', [fx.threadId])).length, before,
    'the note was not written')
})

test('a member replying from a linked second address is still attributed to them', async () => {
  // the common real case: the notification goes to a +tag, the mail client
  // sends from the bare address
  const fx = await fixture()
  const addr = await mentionAndGetReplyAddress(fx, '@Marie Dupont thoughts?')
  const second = `marie-personal-${uniq()}@gmail.test`
  await run('INSERT INTO member_aliases (collective_id, member_id, email, created_at) VALUES (?, ?, ?, ?)',
    [fx.collective.id, fx.target.id, second, now()])

  await webhook({
    email_id: `alias-${uniq()}`,
    from: `Marie Dupont <${second}>`,
    to: [addr],
    subject: 'Re: mentioned you',
    message_id: `<alias-${uniq()}@gmail.test>`,
    text: 'Looks good to me.',
  })
  const notes = await all<{ member_id: number; body: string }>(
    'SELECT * FROM notes WHERE thread_id = ? ORDER BY id', [fx.threadId])
  assert.equal(notes.length, 2)
  assert.equal(notes[1].member_id, fx.target.id)
  assert.equal(notes[1].body, '@Xavier Damman Looks good to me.')
})

test('an autoresponder bouncing off a mention email writes nothing', async () => {
  const fx = await fixture()
  const addr = await mentionAndGetReplyAddress(fx, '@Marie Dupont quick one')
  const before = (await all('SELECT * FROM notes WHERE thread_id = ?', [fx.threadId])).length
  await webhook({
    email_id: `ooo-${uniq()}`,
    from: `Marie Dupont <${fx.target.email}>`,
    to: [addr],
    subject: 'Automatic reply: mentioned you',
    message_id: `<ooo-${uniq()}@example.org>`,
    text: 'I am on holiday until September.',
  })
  assert.equal((await all('SELECT * FROM notes WHERE thread_id = ?', [fx.threadId])).length, before)
})

test('mentioning yourself does not send you an email', async () => {
  const { slug, threadId, sid } = await fixture()
  const sent: AppMail[] = []
  __observeAppMail((m) => sent.push(m))
  try {
    await postNote(slug, threadId, sid, '@Xavier Damman note to self: follow up Monday')
    assert.equal(sent.length, 0)
  } finally {
    __observeAppMail(null)
  }
})

// ---------- settings: renaming the collective ----------

test('an admin can rename the collective; the address is untouched', async () => {
  const fx = await fixture()
  const res = await app.request(`/inbox/${fx.slug}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${fx.sid}` },
    body: new URLSearchParams({ name: '  Commons   Hub  Brussels  ' }),
  })
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /Renamed to Commons Hub Brussels/)
  const c = (await get<{ name: string; slug: string }>('SELECT name, slug FROM collectives WHERE id = ?', [fx.collective.id]))!
  assert.equal(c.name, 'Commons Hub Brussels', 'trimmed, inner whitespace collapsed')
  assert.equal(c.slug, fx.slug, 'the address never moves')

  // the new name is what notifications now say they are from
  const page = await app.request(`/inbox/${fx.slug}/settings`, { headers: { cookie: `requests_sid=${fx.sid}` } })
  assert.match(await page.text(), /Commons Hub Brussels/)
})

test('renaming is refused for empty names and for non-admins', async () => {
  const fx = await fixture()
  const before = fx.collective.name

  const empty = await app.request(`/inbox/${fx.slug}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${fx.sid}` },
    body: new URLSearchParams({ name: '   ' }),
  })
  assert.match(decodeURIComponent(empty.headers.get('location') || ''), /cannot be empty/)

  const memberSid = await createSession(fx.target.email) // role 'member', not admin
  const denied = await app.request(`/inbox/${fx.slug}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${memberSid}` },
    body: new URLSearchParams({ name: 'Hostile Takeover' }),
  })
  assert.equal(denied.headers.get('location'), `/inbox/${fx.slug}`)
  assert.equal((await get<{ name: string }>('SELECT name FROM collectives WHERE id = ?', [fx.collective.id]))!.name, before)

  // and the settings page itself is admin-only
  const page = await app.request(`/inbox/${fx.slug}/settings`, { headers: { cookie: `requests_sid=${memberSid}` } })
  assert.equal(page.status, 302)
})
