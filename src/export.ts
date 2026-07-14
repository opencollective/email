import { zipSync, strToU8 } from 'fflate'
import { all, type Attachment, type Collective } from './db.js'
import { readBlob } from './storage.js'
import { cfg } from './config.js'

/** Full data takeout for a collective, as a zip that expands into:
 *
 *    <slug>@collective.email/
 *      inbox.html        ← self-contained local browser (open by double-click)
 *      data/*.json       ← the canonical machine-readable export
 *      data/bundle.js    ← the SAME data as a script — file:// pages cannot
 *                          fetch() local JSON, but <script src> works, so the
 *                          html loads this and the .json files stay pristine
 *      attachments/…     ← every attachment, referenced from the messages
 *
 *  No lock-in: everything a collective ever received or wrote, browsable
 *  offline forever, importable elsewhere from the JSON. */
export async function buildArchive(collective: Collective): Promise<Uint8Array> {
  const [members, threads, messages, notes, events, tags, threadTags, attachments] = await Promise.all([
    all<Record<string, unknown>>('SELECT id, email, name, role, notify_level, created_at, removed_at FROM members WHERE collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT * FROM threads WHERE collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT n.* FROM notes n JOIN threads t ON t.id = n.thread_id WHERE t.collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT e.* FROM events e JOIN threads t ON t.id = e.thread_id WHERE t.collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT * FROM tags WHERE collective_id = ?', [collective.id]),
    all<Record<string, unknown>>('SELECT tt.* FROM thread_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.collective_id = ?', [collective.id]),
    all<Attachment>('SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ?', [collective.id]),
  ])

  const addr = `${collective.slug}@${cfg.emailDomain}`
  const root = `${addr}/`
  const files: Record<string, Uint8Array> = {}

  // attachments/<id>-<safe filename>; the metadata carries the archive path
  const attachmentsMeta: Record<string, unknown>[] = []
  for (const a of attachments) {
    const safe = (a.filename || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120)
    const rel = `attachments/${a.id}-${safe}`
    const content = await readBlob(a.path).catch(() => null)
    if (content) files[root + rel] = new Uint8Array(content)
    attachmentsMeta.push({ id: a.id, message_id: a.message_id, filename: a.filename, content_type: a.content_type, size: a.size, archive_path: content ? rel : null })
  }

  const data: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    collective: { slug: collective.slug, name: collective.name, address: addr, plan: collective.plan, created_at: collective.created_at },
    members, threads, messages, notes, events, tags, thread_tags: threadTags, attachments: attachmentsMeta,
  }
  for (const [name, rows] of Object.entries(data)) {
    files[`${root}data/${name}.json`] = strToU8(JSON.stringify(rows, null, 1))
  }
  files[`${root}data/bundle.js`] = strToU8(`window.ARCHIVE = ${JSON.stringify(data)};`)
  files[`${root}inbox.html`] = strToU8(INBOX_HTML)

  return zipSync(files, { level: 6 })
}

/** Self-contained offline inbox browser. No external requests, no build step:
 *  plain DOM + the data from data/bundle.js. */
const INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archive — collective.email</title>
<style>
:root { --paper:#f7f7f4; --ink:#26282c; --muted:#6e7076; --line:#dcdedd; --card:#fff; --accent:#1869f5; --warn:#b05619; --fill:#efefec; }
@media (prefers-color-scheme: dark) { :root { --paper:#17181b; --ink:#e6e5e1; --muted:#9a9ca2; --line:#3b3d43; --card:#222327; --accent:#6ca2f8; --warn:#d98e4f; --fill:#1f2024; } }
* { box-sizing:border-box }
body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.5 system-ui,-apple-system,sans-serif }
.app { display:grid; grid-template-columns:minmax(280px,380px) 1fr; height:100vh }
.list { border-right:1.5px solid var(--line); overflow-y:auto }
.head { padding:16px; border-bottom:1.5px solid var(--line); position:sticky; top:0; background:var(--paper) }
.head b { font-family:ui-monospace,Menlo,monospace }
.head small { display:block; color:var(--muted) }
.search { width:100%; margin-top:10px; padding:8px 12px; border:1.5px solid var(--line); border-radius:8px; background:var(--fill); color:var(--ink); font:inherit }
.row { display:block; width:100%; text-align:left; padding:12px 16px; border:0; border-bottom:1px solid var(--line); background:none; color:inherit; font:inherit; cursor:pointer }
.row:hover, .row.on { background:var(--fill) }
.row b { display:block; font-size:14px }
.row small { color:var(--muted); font-size:12px }
.thread { overflow-y:auto; padding:24px }
.thread h1 { font-size:19px; margin:0 0 4px }
.meta { color:var(--muted); font-size:13px; margin:0 0 20px }
.msg { border:1.5px solid var(--line); border-radius:12px; background:var(--card); padding:14px 16px; margin:0 0 14px; max-width:760px }
.msg.out { border-color:var(--accent) }
.msg .from { font-size:12.5px; color:var(--muted); margin:0 0 8px }
.msg .from b { color:var(--ink) }
.msg pre { margin:0; white-space:pre-wrap; font:inherit; word-break:break-word }
.note { background:var(--fill); border-style:dashed; font-size:14px }
.att a { display:inline-block; margin:8px 8px 0 0; font-size:12.5px; color:var(--accent) }
.empty { color:var(--muted); padding:60px 24px; text-align:center }
@media (max-width:720px){ .app{grid-template-columns:1fr} .thread{display:none} .thread.open{display:block; position:fixed; inset:0; background:var(--paper); z-index:2} .back{display:inline-block; margin:0 0 14px; color:var(--accent); cursor:pointer} }
.back { display:none }
@media (max-width:720px){ .back{display:inline-block} }
</style>
</head>
<body>
<div class="app">
  <div class="list">
    <div class="head"><b id="addr"></b><small id="stats"></small><input class="search" id="q" placeholder="Search subject, sender, text…"></div>
    <div id="rows"></div>
  </div>
  <div class="thread" id="thread"><div class="empty">Select a conversation.</div></div>
</div>
<script src="data/bundle.js"></script>
<script>
const A = window.ARCHIVE
const fmt = (ts) => ts ? new Date(ts * 1000).toLocaleString() : ''
const members = new Map(A.members.map(m => [m.id, m]))
const who = (id) => { const m = members.get(id); return m ? (m.name || m.email) : 'someone' }
const msgsBy = new Map(), notesBy = new Map(), attsBy = new Map()
for (const m of A.messages) { (msgsBy.get(m.thread_id) || msgsBy.set(m.thread_id, []).get(m.thread_id)).push(m) }
for (const n of A.notes) { (notesBy.get(n.thread_id) || notesBy.set(n.thread_id, []).get(n.thread_id)).push(n) }
for (const a of A.attachments) { (attsBy.get(a.message_id) || attsBy.set(a.message_id, []).get(a.message_id)).push(a) }
const threads = [...A.threads].sort((x, y) => (y.last_message_at || 0) - (x.last_message_at || 0))
document.getElementById('addr').textContent = A.collective.address
document.getElementById('stats').textContent = threads.length + ' conversations · ' + A.messages.length + ' messages · exported ' + new Date(A.exported_at).toLocaleDateString()
const rowsEl = document.getElementById('rows'), threadEl = document.getElementById('thread')
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
function render(filter) {
  rowsEl.innerHTML = ''
  const q = (filter || '').toLowerCase()
  for (const t of threads) {
    if (q) {
      const inMsgs = (msgsBy.get(t.id) || []).some(m => (m.body_text || '').toLowerCase().includes(q))
      if (!(String(t.subject).toLowerCase().includes(q) || String(t.counterpart_email || '').toLowerCase().includes(q) || String(t.counterpart_name || '').toLowerCase().includes(q) || inMsgs)) continue
    }
    const b = document.createElement('button')
    b.className = 'row'; b.dataset.id = t.id
    b.innerHTML = '<b>' + esc(t.subject || '(no subject)') + '</b><small>' + esc(t.counterpart_name || t.counterpart_email || '') + ' · ' + fmt(t.last_message_at) + ' · ' + esc(t.status) + '</small>'
    b.onclick = () => open(t, b)
    rowsEl.appendChild(b)
  }
  if (!rowsEl.children.length) rowsEl.innerHTML = '<div class="empty">Nothing matches.</div>'
}
function open(t, btn) {
  document.querySelectorAll('.row.on').forEach(r => r.classList.remove('on'))
  if (btn) btn.classList.add('on')
  const items = [
    ...(msgsBy.get(t.id) || []).map(m => ({ ts: m.sent_at || m.created_at, m })),
    ...(notesBy.get(t.id) || []).map(n => ({ ts: n.created_at, n })),
  ].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  let html = '<span class="back" onclick="this.parentElement.classList.remove(\\'open\\')">← Back</span>'
  html += '<h1>' + esc(t.subject || '(no subject)') + '</h1><p class="meta">' + esc(t.counterpart_name || '') + ' &lt;' + esc(t.counterpart_email || '') + '&gt; · started ' + fmt(t.first_message_at) + '</p>'
  for (const it of items) {
    if (it.m) {
      const m = it.m
      const atts = (attsBy.get(m.id) || []).filter(a => a.archive_path)
      html += '<div class="msg ' + (m.direction === 'outbound' ? 'out' : '') + '"><p class="from">' +
        (m.direction === 'outbound' ? '<b>' + esc(m.sent_by_member_id ? who(m.sent_by_member_id) : A.collective.address) + '</b> (outbound)' : '<b>' + esc(m.from_name || m.from_email || '') + '</b>') +
        ' · ' + fmt(m.sent_at || m.created_at) + '</p><pre>' + esc(m.body_text || '') + '</pre>' +
        (atts.length ? '<p class="att">' + atts.map(a => '<a href="' + esc(a.archive_path) + '" download>📎 ' + esc(a.filename) + '</a>').join('') + '</p>' : '') + '</div>'
    } else {
      const n = it.n
      html += '<div class="msg note"><p class="from">⌁ internal note — <b>' + esc(who(n.member_id)) + '</b> · ' + fmt(n.created_at) + '</p><pre>' + esc(n.body) + '</pre></div>'
    }
  }
  threadEl.innerHTML = html
  threadEl.classList.add('open')
}
document.getElementById('q').addEventListener('input', (e) => render(e.target.value))
render('')
</script>
</body>
</html>
`
