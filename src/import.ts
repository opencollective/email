import { unzipSync, strFromU8 } from 'fflate'
import { all, createCollective, get, run, type Collective } from './db.js'
import { saveBlob } from './storage.js'
import { cfg } from './config.js'

/** The other half of /export: load a collective's archive zip into this
 *  instance. This is what makes "you can leave any time" true — take the zip
 *  from collective.email, run this on your own server, and the inbox is back
 *  with every thread, note, tag, assignment and attachment.
 *
 *  Rows get new ids here, so every reference is remapped (member → thread →
 *  message → attachment). Columns the target schema doesn't know are dropped,
 *  so an archive from an older or newer version still imports. */

type Row = Record<string, unknown>

export interface ImportOptions {
  /** import under another address (default: the archive's slug) */
  slug?: string
  name?: string
}

export interface ImportSummary {
  collective: Collective
  members: number
  threads: number
  messages: number
  notes: number
  attachments: number
  skippedAgents: number
}

const columnsCache = new Map<string, Set<string>>()
async function columns(table: string): Promise<Set<string>> {
  if (!columnsCache.has(table)) {
    const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`)
    columnsCache.set(table, new Set(rows.map((r) => r.name)))
  }
  return columnsCache.get(table)!
}

/** INSERT the row's known columns (never its old id); returns the new id. */
async function insert(table: string, row: Row): Promise<number> {
  const cols = await columns(table)
  const keys = Object.keys(row).filter((k) => k !== 'id' && cols.has(k) && row[k] !== undefined)
  const r = await run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] as never))
  return Number(r.lastId)
}

/** Read the archive: the zip from Settings → Data, unchanged. */
export function readArchive(zip: Uint8Array): { data: Record<string, unknown>; files: Map<string, Uint8Array> } {
  const entries = unzipSync(zip)
  const dataKey = Object.keys(entries).find((k) => /(^|\/)data\/collective\.json$/.test(k))
  if (!dataKey) throw new Error('Not a collective.email archive: data/collective.json is missing.')
  const root = dataKey.slice(0, -'data/collective.json'.length)
  const data: Record<string, unknown> = {}
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(entries)) {
    if (!k.startsWith(root)) continue
    const rel = k.slice(root.length)
    const m = /^data\/([a-z_]+)\.json$/.exec(rel)
    if (m) data[m[1]] = JSON.parse(strFromU8(v))
    else files.set(rel, v)
  }
  return { data, files }
}

export async function importArchive(zip: Uint8Array, opts: ImportOptions = {}): Promise<ImportSummary> {
  const { data, files } = readArchive(zip)
  const meta = data.collective as { slug: string; name: string; plan?: string; created_at?: number }
  const list = (k: string) => (Array.isArray(data[k]) ? data[k] : []) as Row[]

  const collective = await createCollective(opts.slug || meta.slug, opts.name || meta.name, meta.plan || 'collective')
  // an imported inbox is an existing one, not a new trial; keep its history's start
  await run('UPDATE collectives SET created_at = ?, comped = ? WHERE id = ?',
    [meta.created_at || collective.created_at, cfg.billingOff ? 1 : (collective.comped ?? 0), collective.id])

  // members: agents can't come along — their API tokens belong to the old instance
  const memberMap = new Map<number, number>()
  let skippedAgents = 0
  for (const m of list('members')) {
    if (m.kind === 'agent') { skippedAgents++; continue }
    memberMap.set(Number(m.id), await insert('members', { ...m, collective_id: collective.id }))
  }
  const mem = (id: unknown) => (id == null ? null : memberMap.get(Number(id)) ?? null)

  const threadMap = new Map<number, number>()
  for (const t of list('threads')) {
    threadMap.set(Number(t.id), await insert('threads', { ...t, collective_id: collective.id, assignee_member_id: mem(t.assignee_member_id) }))
  }

  // Message-IDs are unique across the instance; importing the same archive
  // twice (or next to the original) keeps the row and drops the duplicate id
  const messageMap = new Map<number, number>()
  for (const m of list('messages')) {
    const thread = threadMap.get(Number(m.thread_id))
    if (!thread) continue
    const mid = m.rfc822_message_id && !(await get('SELECT 1 FROM messages WHERE rfc822_message_id = ?', [m.rfc822_message_id as string]))
      ? m.rfc822_message_id : null
    messageMap.set(Number(m.id), await insert('messages', {
      ...m, thread_id: thread, rfc822_message_id: mid,
      sent_by_member_id: mem(m.sent_by_member_id), draft_editor_member_id: mem(m.draft_editor_member_id),
    }))
  }

  let notes = 0
  for (const n of list('notes')) {
    const thread = threadMap.get(Number(n.thread_id))
    const author = mem(n.member_id)
    if (!thread || !author) continue
    await insert('notes', { ...n, thread_id: thread, member_id: author })
    notes++
  }

  for (const e of list('events')) {
    const thread = threadMap.get(Number(e.thread_id))
    if (!thread) continue
    // assignment events name members inside their JSON too
    let json = e.data_json as string | null
    if (json && (e.type === 'assigned' || e.type === 'unassigned')) {
      try {
        const d = JSON.parse(json)
        for (const k of ['to', 'from']) if (typeof d[k] === 'number') d[k] = mem(d[k])
        json = JSON.stringify(d)
      } catch { /* keep as is */ }
    }
    await insert('events', { ...e, thread_id: thread, actor_member_id: mem(e.actor_member_id), data_json: json })
  }

  const tagMap = new Map<number, number>()
  for (const t of list('tags')) tagMap.set(Number(t.id), await insert('tags', { name: t.name, collective_id: collective.id }))
  for (const tt of list('thread_tags')) {
    const thread = threadMap.get(Number(tt.thread_id)), tag = tagMap.get(Number(tt.tag_id))
    if (thread && tag) await run('INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [thread, tag])
  }

  let attachments = 0
  for (const a of list('attachments')) {
    const message = messageMap.get(Number(a.message_id))
    const content = a.archive_path ? files.get(String(a.archive_path)) : undefined
    if (!message || !content) continue
    const name = String(a.filename || 'attachment').replace(/[^\w.\-() ]+/g, '_').slice(0, 120)
    const type = String(a.content_type || 'application/octet-stream')
    const locator = await saveBlob(`${message}/${name}`, Buffer.from(content), type)
    await run('INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, ?, ?, ?, ?)',
      [message, name, type, content.length, locator])
    attachments++
  }

  return {
    collective: (await get<Collective>('SELECT * FROM collectives WHERE id = ?', [collective.id]))!,
    members: memberMap.size, threads: threadMap.size, messages: messageMap.size, notes, attachments, skippedAgents,
  }
}
