/** Dev-only: post a note with an @mention and dump the rendered thread page +
 *  the notification email, for a visual check of the highlight and the picker. */
import fs from 'node:fs'
import { app } from '../src/app.js'
import { createCollective, get, run, type Member } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { now } from '../src/util.js'

const out = process.argv[2] || '/tmp'
const slug = `m${Date.now() % 1000000}`
const col = await createCollective(slug, 'Commons Hub')
const add = async (email: string, name: string, role = 'member') =>
  (await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [col.id, email, name, role, 'every', now()])).lastId

const meId = await add('xavier@t.test', 'Xavier Damman', 'admin')
await add('leen@t.test', 'Leen Schelfhout')
await add('inge@t.test', 'Inge Vermeulen')
const me = (await get<Member>('SELECT * FROM members WHERE id = ?', [meId]))!

const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name,
  first_message_at, last_message_at, last_direction, created_at, updated_at)
  VALUES (?, 'Booking the big room in September', 'needs_reply', 'marie@outside.test', 'Marie Dupont', ?, ?, 'inbound', ?, ?)`,
  [col.id, now() - 7200, now() - 7200, now() - 7200, now()])
await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
  VALUES (?, '<m@x>', 'inbound', 'marie@outside.test', 'Marie Dupont', ?, ?, ?, ?)`,
  [t.lastId, JSON.stringify([`${slug}@collective.email`]), 'Hi! Is the big room free on the 12th?', now() - 7200, now()])

const sid = await createSession('xavier@t.test')
const res = await app.request(`/inbox/${slug}/thread/${t.lastId}/note`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `requests_sid=${sid}` },
  body: new URLSearchParams({ body: '@Leen Schelfhout you had the September calendar — is the 12th taken?\nCc @inge in case it clashes with the workshop.' }),
})
console.log('POST /note →', res.status, decodeURIComponent(res.headers.get('location') || ''))

// read it back as Leen, so the "mentions you" markers show
const leen = (await get<Member>('SELECT * FROM members WHERE email = ?', ['leen@t.test']))!
const leenSid = await createSession(leen.email)
const page = await app.request(`/inbox/${slug}/thread/${t.lastId}`, { headers: { cookie: `requests_sid=${leenSid}` } })
const html = await page.text()
fs.writeFileSync(`${out}/thread.html`, html.replace('/static/style.css?v=25', 'style.css'))
fs.copyFileSync('public/static/style.css', `${out}/style.css`)
console.log('thread page →', page.status, `${out}/thread.html`)
console.log('mention spans:', (html.match(/class="mention[^"]*"/g) || []).join(' | '))
console.log('mentions-you chips:', (html.match(/mention-chip/g) || []).length)
console.log('picker roster:', /data-mentions="([^"]*)"/.exec(html)?.[1]?.slice(0, 200))
console.log('note email dumped to', `${process.env.DATA_DIR || 'data'}/last-email.html`, `(author: ${me.email})`)
process.exit(0)
