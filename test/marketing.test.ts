import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'

test('marketing pages render with their key content', async () => {
  const faq = await app.request('/faq')
  assert.equal(faq.status, 200)
  const faqHtml = await faq.text()
  assert.match(faqHtml, /own domain/i)
  assert.match(faqHtml, /no free plan/i)

  const docs = await app.request('/docs')
  assert.equal(docs.status, 200)
  const docsHtml = await docs.text()
  assert.match(docsHtml, /MX record/)
  assert.match(docsHtml, /Commenter/)

  const about = await app.request('/about')
  assert.equal(about.status, 200)
  assert.match(await about.text(), /share the password/i)

  const home = await app.request('/')
  assert.match(await home.text(), /href="\/about"/)
})

test('/homepage shows the homepage even with a session', async () => {
  const { createSession } = await import('../src/auth.js')
  const sid = await createSession('somebody@t.test')
  const res = await app.request('/homepage', { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /An email address for your collective/)
})

test('admin data archive: browsable inbox.html + canonical JSON + attachments', async () => {
  const { unzipSync, strFromU8 } = await import('fflate')
  const { buildArchive } = await import('../src/export.js')
  const { createCollective, run, get } = await import('../src/db.js')
  const { createSession } = await import('../src/auth.js')
  const { saveBlob } = await import('../src/storage.js')
  const { now } = await import('../src/util.js')
  const { cfg } = await import('../src/config.js')

  const col = await createCollective(`arch${Date.now() % 100000}`, 'Archive Co')
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'ada@t.test', 'Ada', 'admin', 'every', ?)", [col.id, now()])
  const member = (await get<any>('SELECT * FROM members WHERE collective_id = ?', [col.id]))!
  const t = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Booking question', 'answered', 'ann@x.test', 'Ann', ?, ?, 'outbound', ?, ?)`, [col.id, now(), now(), now(), now()])
  const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, from_name, to_json, body_text, sent_at, created_at)
    VALUES (?, '<a1@x>', 'inbound', 'ann@x.test', 'Ann', '[]', 'Can we book Saturday?', ?, ?)`, [t.lastId, now(), now()])
  await run("INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, 'I know Ann — I will take it', ?)", [t.lastId, member.id, now()])
  const loc = await saveBlob(`test-${Date.now()}.txt`, Buffer.from('flyer contents'), 'text/plain')
  await run("INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, 'flyer.txt', 'text/plain', 14, ?)", [m.lastId, loc])

  const zip = await buildArchive((await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!)
  const entries = unzipSync(zip)
  const root = `${col.slug}@${cfg.emailDomain}/`
  assert.ok(entries[`${root}inbox.html`], 'inbox.html present')
  const html = strFromU8(entries[`${root}inbox.html`])
  assert.match(html, /data\/bundle\.js/, 'html loads the script bundle (file:// cannot fetch json)')
  const threads = JSON.parse(strFromU8(entries[`${root}data/threads.json`]))
  assert.equal(threads[0].subject, 'Booking question')
  assert.match(strFromU8(entries[`${root}data/notes.json`]), /I know Ann/)
  const atts = JSON.parse(strFromU8(entries[`${root}data/attachments.json`]))
  assert.ok(atts[0].archive_path.startsWith('attachments/'), 'attachment metadata points into the archive')
  assert.equal(strFromU8(entries[`${root}${atts[0].archive_path}`]), 'flyer contents')
  assert.match(strFromU8(entries[`${root}data/bundle.js`]), /^window\.ARCHIVE = /)

  // route: admins only
  const adminSid = await createSession('ada@t.test')
  const res = await app.request(`/inbox/${col.slug}/export`, { headers: { cookie: `requests_sid=${adminSid}` } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'rd@t.test', 'R', 'reader', 'daily', ?)", [col.id, now()])
  const readerSid = await createSession('rd@t.test')
  const res2 = await app.request(`/inbox/${col.slug}/export`, { headers: { cookie: `requests_sid=${readerSid}` } })
  assert.equal(res2.status, 302, 'non-admins are redirected')
})
