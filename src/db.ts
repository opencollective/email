import { createClient, type Client } from '@libsql/client'
import { cfg } from './config.js'
import { now } from './util.js'
import { saveBlob } from './storage.js'

export const db: Client = createClient({ url: cfg.dbUrl, authToken: cfg.dbAuthToken })

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS collectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    plan TEXT NOT NULL DEFAULT 'collective',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collective_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    notify_level TEXT NOT NULL DEFAULT 'every',
    avatar_path TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    removed_at INTEGER,
    UNIQUE (collective_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_email ON members(email)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    invite_token TEXT,
    join_name TEXT,
    join_level TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collective_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collective_id INTEGER NOT NULL,
    subject TEXT NOT NULL DEFAULT '(no subject)',
    status TEXT NOT NULL DEFAULT 'needs_reply',
    assignee_member_id INTEGER,
    counterpart_email TEXT,
    counterpart_name TEXT,
    first_message_at INTEGER,
    last_message_at INTEGER,
    last_direction TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(collective_id, status, last_message_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    rfc822_message_id TEXT UNIQUE,
    in_reply_to TEXT,
    direction TEXT NOT NULL,
    from_email TEXT, from_name TEXT,
    to_json TEXT, cc_json TEXT,
    body_text TEXT,
    sent_by_member_id INTEGER,
    resend_email_id TEXT,
    sent_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    filename TEXT, content_type TEXT, size INTEGER, path TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    actor_member_id INTEGER,
    type TEXT NOT NULL,
    data_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collective_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (collective_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS thread_tags (
    thread_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (thread_id, tag_id)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    collective_name TEXT,
    plan TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (email, plan)
  )`,
]

let ready: Promise<void> | null = null
/** Idempotent schema init; awaited by every query helper (memoized). */
function init(): Promise<void> {
  if (!ready) {
    ready = db.batch(SCHEMA, 'write')
      // additive migrations for pre-existing tables; ignore "duplicate column"
      .then(() => db.execute('ALTER TABLE members ADD COLUMN avatar_path TEXT').catch(() => undefined))
      .then(() => undefined)
  }
  return ready
}

type Arg = string | number | null

export async function all<T>(sql: string, args: Arg[] = []): Promise<T[]> {
  await init()
  const rs = await db.execute({ sql, args })
  return rs.rows as unknown as T[]
}

export async function get<T>(sql: string, args: Arg[] = []): Promise<T | undefined> {
  return (await all<T>(sql, args))[0]
}

export async function run(sql: string, args: Arg[] = []): Promise<{ lastId: number; changes: number }> {
  await init()
  const rs = await db.execute({ sql, args })
  return { lastId: Number(rs.lastInsertRowid ?? 0), changes: rs.rowsAffected }
}

// ---------- types ----------

export interface Collective {
  id: number
  slug: string
  name: string
  status: 'active' | 'suspended'
  plan: string
  created_at: number
}

export interface Member {
  id: number
  collective_id: number
  email: string
  name: string
  role: 'admin' | 'member'
  notify_level: 'every' | 'daily' | 'weekly'
  avatar_path: string | null
  created_at: number
  last_seen_at: number | null
  removed_at: number | null
}

export interface Thread {
  id: number
  collective_id: number
  subject: string
  status: 'needs_reply' | 'answered' | 'closed' | 'spam'
  assignee_member_id: number | null
  counterpart_email: string | null
  counterpart_name: string | null
  first_message_at: number | null
  last_message_at: number | null
  last_direction: string | null
  created_at: number
  updated_at: number
}

export interface Message {
  id: number
  thread_id: number
  rfc822_message_id: string | null
  in_reply_to: string | null
  direction: 'inbound' | 'outbound'
  from_email: string | null
  from_name: string | null
  to_json: string | null
  cc_json: string | null
  body_text: string | null
  sent_by_member_id: number | null
  resend_email_id: string | null
  sent_at: number | null
  created_at: number
}

export interface Invite {
  id: number
  collective_id: number
  token: string
  created_by: number | null
  created_at: number
  expires_at: number
  revoked_at: number | null
}

export interface Attachment {
  id: number
  message_id: number
  filename: string
  content_type: string
  size: number
  path: string
}

/** All members of a collective (including removed — needed to render history). */
export async function memberMap(collectiveId: number): Promise<Map<number, Member>> {
  const rows = await all<Member>('SELECT * FROM members WHERE collective_id = ?', [collectiveId])
  return new Map(rows.map((m) => [m.id, m]))
}

// ---------- kv ----------

export const kvGet = async (k: string): Promise<string | null> =>
  (await get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]))?.v ?? null

export const kvSet = (k: string, v: string) =>
  run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v])

// ---------- collectives ----------

export const getCollective = (id: number) =>
  get<Collective>('SELECT * FROM collectives WHERE id = ?', [id])

export const getCollectiveBySlug = (slug: string) =>
  get<Collective>('SELECT * FROM collectives WHERE slug = ?', [slug.toLowerCase().trim()])

export const allCollectives = () =>
  all<Collective>('SELECT * FROM collectives ORDER BY created_at DESC')

const RESERVED_SLUGS = new Set([
  'notifications', 'admin', 'www', 'mail', 'email', 'hello', 'info', 'support', 'help',
  'abuse', 'postmaster', 'noreply', 'no-reply', 'root', 'team', 'billing', 'security', 'api',
])

export async function createCollective(slug: string, name: string, plan = 'collective'): Promise<Collective> {
  const clean = slug.toLowerCase().trim()
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(clean)) throw new Error('Address must be 2–40 chars: letters, numbers, dashes.')
  if (RESERVED_SLUGS.has(clean)) throw new Error(`"${clean}" is reserved.`)
  if (await getCollectiveBySlug(clean)) throw new Error(`${clean}@${cfg.emailDomain} is already taken.`)
  const r = await run('INSERT INTO collectives (slug, name, status, plan, created_at) VALUES (?, ?, ?, ?, ?)',
    [clean, name.trim() || clean, 'active', plan, now()])
  return (await getCollective(r.lastId))!
}

// ---------- members ----------

export const getMember = (id: number) =>
  get<Member>('SELECT * FROM members WHERE id = ?', [id])

export const getMemberIn = (collectiveId: number, email: string) =>
  get<Member>('SELECT * FROM members WHERE collective_id = ? AND email = ?', [collectiveId, email.toLowerCase().trim()])

export const activeMembers = (collectiveId: number) =>
  all<Member>('SELECT * FROM members WHERE collective_id = ? AND removed_at IS NULL ORDER BY name, email', [collectiveId])

/** All active memberships for a verified email, joined with their collective. */
export const membershipsByEmail = (email: string) =>
  all<Member & { collective_slug: string; collective_name: string }>(`
    SELECT m.*, c.slug AS collective_slug, c.name AS collective_name FROM members m
    JOIN collectives c ON c.id = m.collective_id AND c.status = 'active'
    WHERE m.email = ? AND m.removed_at IS NULL
    ORDER BY c.name
  `, [email.toLowerCase().trim()])

// ---------- attachments ----------

/** Persist an attachment blob (Vercel Blob or local disk) and record it against a message. */
export async function storeAttachment(messageDbId: number, filename: string | undefined, contentType: string | undefined, content: Buffer, index = 0) {
  const safe = (filename || `attachment-${index + 1}`).replace(/[^\w.\-() ]+/g, '_').slice(0, 120)
  const locator = await saveBlob(`${messageDbId}/${safe}`, content, contentType || 'application/octet-stream')
  await run('INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, ?, ?, ?, ?)',
    [messageDbId, safe, contentType || 'application/octet-stream', content.length, locator])
}

export const messageAttachments = (messageId: number) =>
  all<Attachment>('SELECT * FROM attachments WHERE message_id = ?', [messageId])

export async function attachmentsByMessage(messageIds: number[]): Promise<Map<number, Attachment[]>> {
  if (messageIds.length === 0) return new Map()
  const rows = await all<Attachment>(
    `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')})`, messageIds)
  const map = new Map<number, Attachment[]>()
  for (const a of rows) {
    if (!map.has(a.message_id)) map.set(a.message_id, [])
    map.get(a.message_id)!.push(a)
  }
  return map
}

// ---------- events ----------

export function addEvent(threadId: number, actorMemberId: number | null, type: string, data: Record<string, unknown> = {}) {
  return run('INSERT INTO events (thread_id, actor_member_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [threadId, actorMemberId, type, JSON.stringify(data), now()])
}

// ---------- threads ----------

export const getThread = (id: number) =>
  get<Thread>('SELECT * FROM threads WHERE id = ?', [id])

export const threadMessages = (threadId: number) =>
  all<Message>('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at, id', [threadId])

export const lastInboundMessage = (threadId: number) =>
  get<Message>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'inbound' ORDER BY sent_at DESC, id DESC LIMIT 1", [threadId])

export const threadTags = (threadId: number) =>
  all<{ id: number; name: string }>(
    'SELECT t.id, t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ? ORDER BY t.name', [threadId])

export async function tagsByThread(threadIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
  if (threadIds.length === 0) return new Map()
  const rows = await all<{ thread_id: number; id: number; name: string }>(
    `SELECT tt.thread_id, t.id, t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id
     WHERE tt.thread_id IN (${threadIds.map(() => '?').join(',')}) ORDER BY t.name`, threadIds)
  const map = new Map<number, { id: number; name: string }[]>()
  for (const r of rows) {
    if (!map.has(r.thread_id)) map.set(r.thread_id, [])
    map.get(r.thread_id)!.push({ id: r.id, name: r.name })
  }
  return map
}

export async function lastMessageByThread(threadIds: number[]): Promise<Map<number, Message>> {
  if (threadIds.length === 0) return new Map()
  const rows = await all<Message>(
    `SELECT * FROM messages WHERE id IN (
       SELECT MAX(id) FROM messages WHERE thread_id IN (${threadIds.map(() => '?').join(',')}) GROUP BY thread_id
     )`, threadIds)
  return new Map(rows.map((m) => [m.thread_id, m]))
}

export async function setAssignee(
  thread: Thread,
  targetMemberId: number | null,
  actorMemberId: number | null,
  reason: 'manual' | 'claim' | 'auto_sender' | 'email_reply' | 'one_click',
) {
  if (thread.assignee_member_id === targetMemberId) return
  await run('UPDATE threads SET assignee_member_id = ?, updated_at = ? WHERE id = ?', [targetMemberId, now(), thread.id])
  if (targetMemberId === null) {
    await addEvent(thread.id, actorMemberId, 'unassigned', { from: thread.assignee_member_id })
  } else {
    await addEvent(thread.id, actorMemberId, 'assigned', { to: targetMemberId, reason })
  }
}

export async function setStatus(threadId: number, status: Thread['status'], actorMemberId: number | null, auto = false) {
  const t = await getThread(threadId)
  if (!t || t.status === status) return
  await run('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?', [status, now(), threadId])
  await addEvent(threadId, actorMemberId, 'status', { from: t.status, to: status, auto })
}

export async function addTag(collectiveId: number, threadId: number, name: string, actorMemberId: number | null, auto = false) {
  const clean = name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40)
  if (!clean) return
  await run('INSERT INTO tags (collective_id, name) VALUES (?, ?) ON CONFLICT(collective_id, name) DO NOTHING', [collectiveId, clean])
  const tag = await get<{ id: number }>('SELECT id FROM tags WHERE collective_id = ? AND name = ?', [collectiveId, clean])
  const r = await run('INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [threadId, tag!.id])
  if (r.changes > 0) await addEvent(threadId, actorMemberId, 'tag_added', { tag: clean, auto })
}

export async function removeTag(threadId: number, tagId: number, actorMemberId: number | null) {
  const tag = await get<{ name: string }>('SELECT name FROM tags WHERE id = ?', [tagId])
  const r = await run('DELETE FROM thread_tags WHERE thread_id = ? AND tag_id = ?', [threadId, tagId])
  if (r.changes > 0 && tag) await addEvent(threadId, actorMemberId, 'tag_removed', { tag: tag.name })
}

/** Latest assignee a past thread from this sender had — used for auto-assignment. */
export async function suggestedAssigneeFor(collectiveId: number, senderEmail: string, excludeThreadId: number): Promise<number | null> {
  const row = await get<{ mid: number }>(`
    SELECT t.assignee_member_id AS mid FROM threads t
    JOIN members m ON m.id = t.assignee_member_id AND m.removed_at IS NULL
    WHERE t.collective_id = ? AND t.counterpart_email = ? AND t.id != ? AND t.assignee_member_id IS NOT NULL
    ORDER BY t.last_message_at DESC LIMIT 1
  `, [collectiveId, senderEmail.toLowerCase(), excludeThreadId])
  return row?.mid ?? null
}
