import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArchive } from '../src/export.js'
import { importArchive } from '../src/import.js'
import { createCollective, get, all, run } from '../src/db.js'
import { saveBlob, readBlob } from '../src/storage.js'
import { now } from '../src/util.js'

test('an exported archive imports back: threads, notes, tags, assignments and attachments, all remapped', async () => {
  const slug = `imp${Date.now() % 100000}`
  const col = await createCollective(slug, 'Import Co')
  const ada = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'ada@t.test', 'Ada', 'admin', 'every', ?)", [col.id, now()])
  const bo = await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'bo@t.test', 'Bo', 'member', 'daily', ?)", [col.id, now()])
  await run("INSERT INTO members (collective_id, email, name, role, kind, notify_level, created_at) VALUES (?, 'bot@agents.test', 'Bot', 'commenter', 'agent', 'none', ?)", [col.id, now()])
  const t = await run(`INSERT INTO threads (collective_id, subject, status, assignee_member_id, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, 'Booking question', 'answered', ?, 'ann@example.org', ?, ?, 'outbound', ?, ?)`, [col.id, bo.lastId, now() - 99, now(), now(), now()])
  const msgId = `<imp-${Date.now()}@example.org>`
  const m = await run(`INSERT INTO messages (thread_id, rfc822_message_id, direction, from_email, to_json, body_text, sent_at, created_at)
    VALUES (?, ?, 'inbound', 'ann@example.org', '[]', 'Can we book Saturday?', ?, ?)`, [t.lastId, msgId, now() - 99, now() - 99])
  await run(`INSERT INTO messages (thread_id, direction, from_email, to_json, body_text, sent_by_member_id, sent_at, created_at)
    VALUES (?, 'outbound', 'x@collective.email', '[]', 'Yes!', ?, ?, ?)`, [t.lastId, bo.lastId, now(), now()])
  await run('INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [t.lastId, ada.lastId, '@Bo can you take it?', now()])
  await run("INSERT INTO events (thread_id, actor_member_id, type, data_json, created_at) VALUES (?, ?, 'assigned', ?, ?)",
    [t.lastId, ada.lastId, JSON.stringify({ to: Number(bo.lastId) }), now()])
  await run('INSERT INTO tags (collective_id, name) VALUES (?, ?)', [col.id, 'events'])
  const tag = (await get<{ id: number }>('SELECT id FROM tags WHERE collective_id = ?', [col.id]))!
  await run('INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [t.lastId, tag.id])
  const loc = await saveBlob(`imp-${Date.now()}.txt`, Buffer.from('flyer contents'), 'text/plain')
  await run("INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, 'flyer.txt', 'text/plain', 14, ?)", [m.lastId, loc])

  const zip = await buildArchive((await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!)
  // into the same instance under a new address — the hardest case: ids and
  // Message-IDs already exist
  const s = await importArchive(zip, { slug: `${slug}b` })

  assert.equal(s.collective.slug, `${slug}b`)
  assert.equal(s.collective.name, 'Import Co')
  assert.deepEqual([s.members, s.threads, s.messages, s.notes, s.attachments, s.skippedAgents], [2, 1, 2, 1, 1, 1])

  const members = await all<any>('SELECT * FROM members WHERE collective_id = ? ORDER BY email', [s.collective.id])
  assert.deepEqual(members.map((x) => [x.email, x.role, x.notify_level]), [['ada@t.test', 'admin', 'every'], ['bo@t.test', 'member', 'daily']])
  const newBo = members[1].id
  const th = (await get<any>('SELECT * FROM threads WHERE collective_id = ?', [s.collective.id]))!
  assert.notEqual(th.id, Number(t.lastId))
  assert.equal(th.assignee_member_id, newBo, 'assignee remapped to the imported member')
  const msgs = await all<any>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id', [th.id])
  assert.equal(msgs[0].rfc822_message_id, null, 'a Message-ID already on this instance is not duplicated')
  assert.equal(msgs[1].sent_by_member_id, newBo)
  const ev = (await get<any>('SELECT * FROM events WHERE thread_id = ?', [th.id]))!
  assert.equal(JSON.parse(ev.data_json).to, newBo, 'member ids inside event JSON are remapped too')
  assert.equal(ev.actor_member_id, members[0].id)
  const tagged = await get<any>('SELECT g.name FROM thread_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.thread_id = ?', [th.id])
  assert.equal(tagged?.name, 'events')
  const att = (await get<any>('SELECT * FROM attachments WHERE message_id = ?', [msgs[0].id]))!
  assert.equal((await readBlob(att.path))?.toString(), 'flyer contents')

  await assert.rejects(importArchive(zip, { slug: `${slug}b` }), /already taken/, 'never merges into an existing inbox')
  await assert.rejects(importArchive(new Uint8Array([1, 2, 3])), 'garbage is refused')
})
