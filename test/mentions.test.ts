import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { all, createCollective, get, run, type Member } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'
import { findMentions, mentionedMembers, noteParts } from '../src/mentions.js'
import { resolveReplyAddress } from '../src/reply-tokens.js'
import { slugAvailability } from '../src/claim.js'
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

// ---------- changing the address ----------

const rename = (slug: string, sid: string, to: string, confirm: string, keepOld = true) =>
  app.request(`/inbox/${slug}/settings/address`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
    body: new URLSearchParams(keepOld ? { slug: to, confirm, keep_old: '1' } : { slug: to, confirm }),
  })

/** A collective only counts as "in use" once something has actually arrived. */
async function receiveMail(collectiveId: number, threadId: number) {
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'outsider@example.org', '[]', 'hello', ?, ?)`,
    [threadId, `<in-${uniq()}@example.org>`, now(), now()])
}

test('keeping the old address works, and retires it for as long as it is kept', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId) // a used inbox
  const oldSlug = fx.slug
  const newSlug = `moved${uniq()}`

  const res = await rename(oldSlug, fx.sid, newSlug, `${oldSlug}@collective.email`)
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location')!, new RegExp(`^/inbox/${newSlug}/settings`))

  // mail to the old address still lands in the same inbox
  const routed = await app.request('/webhooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', data: {
      email_id: `moved-${uniq()}`, from: 'Outsider <old-contact@outside.test>',
      to: [`${oldSlug}@collective.email`], subject: 'Sent to the old address',
      message_id: `<old-${uniq()}@outside.test>`, text: 'Does this still reach you?',
    } }),
  })
  assert.equal((await routed.json()).routed, 1, 'the old address still delivers')
  const landed = await get<{ subject: string }>(
    'SELECT subject FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [fx.collective.id])
  assert.equal(landed!.subject, 'Sent to the old address')

  // links in already-sent emails redirect instead of 404ing
  const oldLink = await app.request(`/inbox/${oldSlug}/thread/${fx.threadId}`, { headers: { cookie: `requests_sid=${fx.sid}` } })
  assert.equal(oldLink.status, 302)
  assert.equal(oldLink.headers.get('location'), `/inbox/${newSlug}/thread/${fx.threadId}`)

  // and nobody else can ever claim the old address — by any route
  assert.match((await slugAvailability(oldSlug))!, /already taken/)
  await assert.rejects(createCollective(oldSlug, 'Squatter'), /already taken/,
    'not even the admin path can hand out a retired address')
})

test('the address only changes when the confirmation matches', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId)
  const res = await rename(fx.slug, fx.sid, `other${uniq()}`, 'not-the-address@collective.email')
  assert.match(decodeURIComponent(res.headers.get('location')!), /confirmation didn't match/)
  assert.equal((await get<{ slug: string }>('SELECT slug FROM collectives WHERE id = ?', [fx.collective.id]))!.slug, fx.slug)
})

test('the address cannot be moved onto a taken or invalid one, or by a non-admin', async () => {
  const fx = await fixture()
  const other = await createCollective(`taken${uniq()}`, 'Someone Else')
  const confirm = `${fx.slug}@collective.email`

  assert.match(decodeURIComponent((await rename(fx.slug, fx.sid, other.slug, confirm)).headers.get('location')!), /already taken/)
  assert.match(decodeURIComponent((await rename(fx.slug, fx.sid, 'ab', confirm)).headers.get('location')!), /6–40 characters/)

  const memberSid = await createSession(fx.target.email) // not an admin
  await rename(fx.slug, memberSid, `hostile${uniq()}`, confirm)
  assert.equal((await get<{ slug: string }>('SELECT slug FROM collectives WHERE id = ?', [fx.collective.id]))!.slug, fx.slug)
})

test('keeping the old address is opt-in — by default it is released', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId)
  const oldSlug = fx.slug
  const newSlug = `left${uniq()}`

  const res = await rename(oldSlug, fx.sid, newSlug, `${oldSlug}@collective.email`, false)
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')!), /is no longer yours/)

  assert.equal((await all('SELECT slug FROM former_slugs WHERE collective_id = ?', [fx.collective.id])).length, 0,
    'nothing is being held')
  assert.equal(await slugAvailability(oldSlug), null, 'the old address is free for someone else')
})

test('an address can only be changed once a week', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId)
  const second = `again${uniq()}`
  const first = `first${uniq()}`

  await rename(fx.slug, fx.sid, first, `${fx.slug}@collective.email`, false)
  const tooSoon = await rename(first, fx.sid, second, `${first}@collective.email`, false)
  assert.match(decodeURIComponent(tooSoon.headers.get('location')!), /once a week/)
  assert.equal((await get<{ slug: string }>('SELECT slug FROM collectives WHERE id = ?', [fx.collective.id]))!.slug, first)

  // a week later it is allowed again
  await run('UPDATE collectives SET slug_changed_at = ? WHERE id = ?', [now() - 8 * 86400, fx.collective.id])
  await rename(first, fx.sid, second, `${first}@collective.email`, false)
  assert.equal((await get<{ slug: string }>('SELECT slug FROM collectives WHERE id = ?', [fx.collective.id]))!.slug, second)
})

test('a never-used inbox renames without the warnings or the typed confirmation', async () => {
  const fx = await fixture() // no inbound mail
  const page = await (await app.request(`/inbox/${fx.slug}/settings`, { headers: { cookie: `requests_sid=${fx.sid}` } })).text()
  assert.match(page, /Nobody has written to/, 'the short version')
  assert.doesNotMatch(page, /mailing lists, forwarding rules/, 'not the full consequence list')
  assert.doesNotMatch(page, /Keep receiving mail sent to/, 'nothing to forward')

  // and it goes through with no confirm field at all
  const newSlug = `fresh${uniq()}`
  const res = await app.request(`/inbox/${fx.slug}/settings/address`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${fx.sid}` },
    body: new URLSearchParams({ slug: newSlug }),
  })
  assert.equal(res.status, 302)
  assert.equal((await get<{ slug: string }>('SELECT slug FROM collectives WHERE id = ?', [fx.collective.id]))!.slug, newSlug)
  assert.equal((await all('SELECT slug FROM former_slugs WHERE collective_id = ?', [fx.collective.id])).length, 0)
})

test('a used inbox still shows the warnings and demands the typed confirmation', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId)
  const page = await (await app.request(`/inbox/${fx.slug}/settings`, { headers: { cookie: `requests_sid=${fx.sid}` } })).text()
  assert.match(page, /mailing lists, forwarding rules/)
  assert.match(page, /Keep receiving mail sent to/)

  const res = await app.request(`/inbox/${fx.slug}/settings/address`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${fx.sid}` },
    body: new URLSearchParams({ slug: `nope${uniq()}` }), // no confirm
  })
  assert.match(decodeURIComponent(res.headers.get('location')!), /confirmation didn't match/)
})

test('a kept address can be released again, freeing it for others', async () => {
  const fx = await fixture()
  await receiveMail(fx.collective.id, fx.threadId)
  const oldSlug = fx.slug
  const newSlug = `kept${uniq()}`
  await rename(oldSlug, fx.sid, newSlug, `${oldSlug}@collective.email`, true)
  assert.match((await slugAvailability(oldSlug))!, /already taken/)

  await app.request(`/inbox/${newSlug}/settings/address/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${fx.sid}` },
    body: new URLSearchParams({ slug: oldSlug }),
  })
  assert.equal(await slugAvailability(oldSlug), null, 'released back to the pool')
})
