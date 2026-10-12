/** Seed a demo collective for the product video: a realistic Commons Hub inbox
 *  with members, an agent, assignments, notes, tags and drafts.
 *  Run with DATA_DIR pointing at a throwaway directory. Prints a session token. */
import fs from 'node:fs'
import { simpleParser } from 'mailparser'
import { createCollective, run, get, getThread } from '../../src/db.js'
import { ingestInbound } from '../../src/ingest.js'
import { createSession } from '../../src/auth.js'
import { now } from '../../src/util.js'

const T = now()
const H = 3600
const col = await createCollective('commonshub', 'Commons Hub Brussels', 'pro')
await run("UPDATE collectives SET custom_domain='commonshub.brussels', custom_local='hello', domain_status='verified', trial_ends_at=NULL, comped=1 WHERE id = ?", [col.id])

const people: [string, string, string, string?][] = [
  ['xavier@commonshub.brussels', 'Xavier', 'admin'],
  ['leen@commonshub.brussels', 'Leen', 'member'],
  ['cedric@commonshub.brussels', 'Cédric', 'member'],
  ['spencer@commonshub.brussels', 'Spencer', 'member'],
  ['ana@commonshub.brussels', 'Ana', 'commenter'],
  ['marta@commonshub.brussels', 'Marta', 'reader'],
  ['hubbie@agents.collective.email', 'Hubbie', 'commenter', 'agent'],
]
const M: Record<string, number> = {}
for (const [email, name, role, kind] of people) {
  const r = await run(`INSERT INTO members (collective_id, email, name, role, notify_level, kind, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [col.id, email, name, role, kind ? 'none' : 'every', kind || 'person', T - 40 * 86400, T - 600])
  M[name] = Number(r.lastId)
}
const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!

let n = 0
async function inbound(fromName: string, from: string, subject: string, body: string, agoH: number, cc = '') {
  const id = `<demo-${++n}@${from.split('@')[1]}>`
  await ingestInbound(pro, await simpleParser([
    `From: ${fromName} <${from}>`, 'To: hello@commonshub.brussels', ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`, `Message-ID: ${id}`, `Date: ${new Date((T - agoH * H) * 1000).toUTCString()}`, '', body,
  ].join('\r\n')))
  const m = (await get<any>('SELECT thread_id FROM messages WHERE rfc822_message_id = ?', [id]))!
  return Number(m.thread_id)
}
const assign = (th: number, who: string, by: string, agoH: number) => Promise.all([
  run('UPDATE threads SET assignee_member_id = ? WHERE id = ?', [M[who], th]),
  run("INSERT INTO events (thread_id, actor_member_id, type, data_json, created_at) VALUES (?, ?, 'assigned', ?, ?)", [th, M[by], JSON.stringify({ to: M[who] }), T - agoH * H]),
])
const note = (th: number, who: string, body: string, agoH: number, mention?: string) =>
  run('INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [th, M[who], body, T - agoH * H]).then(async (r) => {
    if (mention) await run('INSERT INTO note_mentions (note_id, member_id, created_at) VALUES (?, ?, ?)', [r.lastId, M[mention], T - agoH * H])
  })
async function tag(th: number, name: string) {
  await run('INSERT OR IGNORE INTO tags (collective_id, name) VALUES (?, ?)', [col.id, name])
  const t = (await get<any>('SELECT id FROM tags WHERE collective_id = ? AND name = ?', [col.id, name]))!
  await run('INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [th, t.id])
}
async function reply(th: number, who: string, to: string, body: string, agoH: number) {
  await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, cc_json, body_text, sent_by_member_id, sent_at, created_at)
    VALUES (?, ?, 'outbound', 'hello@commonshub.brussels', 'Commons Hub Brussels', ?, '[]', ?, ?, ?, ?)`,
    [th, `<demo-out-${++n}@commonshub.brussels>`, JSON.stringify([to]), body, M[who], T - agoH * H, T - agoH * H])
  await run("UPDATE threads SET status = 'answered', last_direction = 'outbound', last_message_at = ? WHERE id = ?", [T - agoH * H, th])
}
const seen = (th: number, ...who: string[]) => Promise.all(who.map((w) =>
  run('INSERT OR REPLACE INTO thread_reads (thread_id, member_id, first_seen_at, last_seen_at, via) VALUES (?, ?, ?, ?, ?)', [th, M[w], T - 2 * H, T - H, 'web'])))

// --- the inbox ---
const repair = await inbound('Ann Peeters', 'ann.peeters@gmail.com', 'Booking the space for a repair café on Saturday',
  `Hi Commons Hub team,

We run a small repair café in Saint-Gilles and our usual venue fell through. Could we use your main room this Saturday from 10:00 to 16:00?

We'd be about 12 volunteers with their tools, and we expect around 40 visitors over the day. We'd of course leave the space as we found it.

Thanks a lot!
Ann`, 3, 'Jonas De Smet <jonas@repaircafe.brussels>')
await assign(repair, 'Leen', 'Xavier', 2.5)
await tag(repair, 'events')
await note(repair, 'Leen', '@Cédric do we still have the folding tables, or did they go to the climate fair?', 2.2, 'Cédric')
await note(repair, 'Cédric', 'They\'re back in the storage room, all 8 of them 👍', 1.9)
await run('INSERT INTO thread_drafts (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [repair, M.Hubbie,
  `Hi Ann,

Good news: the main room is free this Saturday from 10:00 to 16:00, and we have 8 folding tables your volunteers can use.

Could you send us the name of the person who will open and close with us? We'll share the door code the day before.

Warmly,
Leen — Commons Hub Brussels`, T - 1.5 * H])
await seen(repair, 'Xavier', 'Leen', 'Cédric', 'Spencer')

const climate = await inbound('Marie Laurent', 'marie@climateweek.brussels', 'Partnership proposal – Brussels Climate Week 2026',
  `Dear Commons Hub,

Brussels Climate Week is looking for community venues to host 3 evening talks in November. Would you be interested in being a partner venue?

Best regards,
Marie Laurent`, 1)
fs.copyFileSync(`${process.env.DATA_DIR}/last-email.html`, `${process.env.DATA_DIR}/notif-climate.html`)
await tag(climate, 'partnerships')
await seen(climate, 'Xavier')

const press = await inbound('Sophie Martin', 's.martin@lesoir.test', 'Press: an article on third places in Brussels',
  `Bonjour,

I'm writing a piece on third places in Brussels for next week's weekend edition. Could someone from the Commons Hub speak with me for 20 minutes?

Merci,
Sophie Martin`, 5)
await tag(press, 'press')

const meetup = await inbound('Tomás Ruiz', 'tomas@brusselsjs.test', 'Can we host our JS meetup in November?',
  `Hey! Brussels JS would love to come back for our November meetup (around 50 people, Thursday evening). Is the 20th free?`, 20)
await assign(meetup, 'Spencer', 'Spencer', 19)
await tag(meetup, 'events')
await seen(meetup, 'Spencer', 'Xavier')

const invoice = await inbound('Bureau Vert', 'billing@bureauvert.test', 'Invoice 2026-114 for September cleaning',
  `Hello, please find attached our invoice for September. Payment within 30 days. Thank you!`, 26)
await assign(invoice, 'Cédric', 'Xavier', 25)
await tag(invoice, 'finance')
await seen(invoice, 'Cédric')

const member = await inbound('Tom Willems', 'tom.willems@proton.me', 'How do I become a member?',
  `Hi, I've been coming to your Friday lunches and I'd love to become a member. How does it work?`, 30)
await assign(member, 'Leen', 'Leen', 29)
await reply(member, 'Leen', 'tom.willems@proton.me', `Hi Tom,

Lovely to hear! Membership is open to everyone: you can join at commonshub.brussels/join, and you'll get access to the space and the weekly members' dinner.

See you Friday,
Leen`, 28)
await seen(member, 'Leen', 'Xavier', 'Ana')

const vol = await inbound('Inès Haddad', 'ines.haddad@gmail.com', 'Volunteering on Sunday mornings',
  `Hello! I have some free time on Sunday mornings and would love to help out. Anything I can do?`, 50)
await assign(vol, 'Ana', 'Xavier', 49)
await reply(vol, 'Spencer', 'ines.haddad@gmail.com', 'Hi Inès, that would be wonderful. I added you to the Sunday garden crew!', 47)
await tag(vol, 'volunteers')

const grant = await inbound('Ville de Bruxelles', 'subsides@bruxelles.test', 'Your application to the "Quartiers durables" call',
  `Dear applicant, we have received your application. Could you send us your 2025 annual accounts before October 20?`, 8)
await assign(grant, 'Xavier', 'Cédric', 6)
await tag(grant, 'finance')
await note(grant, 'Cédric', '@Xavier the accounts are in the shared drive, under /2025/closing. Can you send them?', 6, 'Xavier')

// --- drafts ---
async function draft(who: string, to: string, subject: string, body: string, agoH: number) {
  const ts = T - agoH * H
  const th = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, assignee_member_id, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, 'outbound', ?, ?)`, [col.id, subject, to, M[who], ts, ts, ts, ts])
  await run(`INSERT INTO messages (thread_id, direction, from_email, from_name, to_json, cc_json, bcc_json, body_text, sent_by_member_id, draft_rev, draft_editor_member_id, created_at)
    VALUES (?, 'outbound', 'hello@commonshub.brussels', 'Commons Hub Brussels', ?, '[]', '[]', ?, ?, 1, ?, ?)`, [th.lastId, JSON.stringify([to]), body, M[who], M[who], ts])
  await run("INSERT INTO events (thread_id, actor_member_id, type, data_json, created_at) VALUES (?, ?, 'assigned', ?, ?)", [th.lastId, M[who], JSON.stringify({ to: M[who] }), ts])
  return Number(th.lastId)
}
const nl = await draft('Xavier', 'members@commonshub.brussels', 'October at the Commons Hub 🍂', `Hi everyone,

October is here, and so is a full month at the Hub:

• Repair café, Saturday 10:00–16:00
• Brussels JS meetup, Thursday 20th
• Members' dinner every Wednesday

Got an idea for November? Just reply to this email.

Xavier — Commons Hub Brussels`, 4)
await tag(nl, 'newsletter')
await draft('Leen', 'info@climateweek.brussels', 'Venue for Climate Week talks', 'Hi Marie, we would love to host…', 0.5)

console.log('SID=' + await createSession('xavier@commonshub.brussels'))
console.log('THREADS', JSON.stringify({ repair, climate, press, meetup, invoice, member, grant, nl }))
void getThread
process.exit(0)
