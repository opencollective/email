import { all, get, run } from './db.js'
import { deleteBlob, readBlob, saveBlob } from './storage.js'
import { now } from './util.js'

/** A proposed reply: written by an agent, a commenter or a guest, sent (or
 *  not) by someone who can send. It can carry files, which travel with it
 *  into the reply when a sender uses it. */
export interface DraftAttachment {
  id: number
  draft_id: number
  filename: string
  content_type: string
  size: number
  path: string
}

/** The same ceiling as a reply's attachments: what a draft carries must fit
 *  in the email it becomes. */
export const MAX_DRAFT_BYTES = 15 * 1024 * 1024

export const memberDraft = (threadId: number, memberId: number) =>
  get<{ id: number; body: string; created_at: number }>(
    'SELECT id, body, created_at FROM thread_drafts WHERE thread_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1', [threadId, memberId])

/** One live draft per member per thread: a newer proposal replaces the text,
 *  and the files already attached stay with it. */
export async function proposeDraft(threadId: number, memberId: number, body: string): Promise<number> {
  const old = await all<{ id: number }>('SELECT id FROM thread_drafts WHERE thread_id = ? AND member_id = ?', [threadId, memberId])
  const r = await run('INSERT INTO thread_drafts (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [threadId, memberId, body, now()])
  for (const o of old) {
    await run('UPDATE draft_attachments SET draft_id = ? WHERE draft_id = ?', [r.lastId, o.id])
    await run('DELETE FROM thread_drafts WHERE id = ?', [o.id])
  }
  return r.lastId
}

export async function draftAttachments(draftIds: number[]): Promise<Map<number, DraftAttachment[]>> {
  const map = new Map<number, DraftAttachment[]>()
  if (draftIds.length === 0) return map
  const rows = await all<DraftAttachment>(
    `SELECT * FROM draft_attachments WHERE draft_id IN (${draftIds.map(() => '?').join(',')}) ORDER BY id`, draftIds)
  for (const a of rows) {
    if (!map.has(a.draft_id)) map.set(a.draft_id, [])
    map.get(a.draft_id)!.push(a)
  }
  return map
}

/** Attach a file to a draft. Throws when the draft would outgrow an email. */
export async function addDraftAttachment(draftId: number, filename: string | undefined, contentType: string | undefined, content: Buffer): Promise<DraftAttachment> {
  const have = (await get<{ n: number; s: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM draft_attachments WHERE draft_id = ?', [draftId]))!
  if (have.s + content.length > MAX_DRAFT_BYTES) throw new Error('Attachments too large — a draft carries at most 15 MB in total.')
  const safe = (filename || `attachment-${have.n + 1}`).replace(/[^\w.\-() ]+/g, '_').slice(0, 120)
  const type = contentType || 'application/octet-stream'
  const locator = await saveBlob(`drafts/${draftId}/${safe}`, content, type)
  const r = await run('INSERT INTO draft_attachments (draft_id, filename, content_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [draftId, safe, type, content.length, locator, now()])
  return { id: r.lastId, draft_id: draftId, filename: safe, content_type: type, size: content.length, path: locator }
}

export async function removeDraftAttachment(att: DraftAttachment): Promise<void> {
  await run('DELETE FROM draft_attachments WHERE id = ?', [att.id])
  await deleteBlob(att.path)
}

/** Drop drafts and the files they carry — when a real reply settles them,
 *  when one is dismissed, when the thread is purged. */
export async function deleteDrafts(where: { threadId: number } | { draftId: number }): Promise<void> {
  const ids = 'draftId' in where ? [where.draftId]
    : (await all<{ id: number }>('SELECT id FROM thread_drafts WHERE thread_id = ?', [where.threadId])).map((d) => d.id)
  if (ids.length === 0) return
  const ph = ids.map(() => '?').join(',')
  for (const a of await all<{ path: string }>(`SELECT path FROM draft_attachments WHERE draft_id IN (${ph})`, ids)) await deleteBlob(a.path)
  await run(`DELETE FROM draft_attachments WHERE draft_id IN (${ph})`, ids)
  await run(`DELETE FROM thread_drafts WHERE id IN (${ph})`, ids)
}

/** The files of the drafts on a thread, loaded for sending: only attachments
 *  that really belong to a draft on that thread are returned. */
export async function loadDraftFiles(threadId: number, attachmentIds: number[]) {
  if (attachmentIds.length === 0) return []
  const rows = await all<DraftAttachment>(
    `SELECT da.* FROM draft_attachments da JOIN thread_drafts d ON d.id = da.draft_id
     WHERE d.thread_id = ? AND da.id IN (${attachmentIds.map(() => '?').join(',')}) ORDER BY da.id`, [threadId, ...attachmentIds])
  const out: { filename: string; contentType: string; content: Buffer }[] = []
  for (const a of rows) {
    const content = await readBlob(a.path)
    if (!content) throw new Error(`Could not read the draft's attachment ${a.filename} — attach it again.`)
    out.push({ filename: a.filename, contentType: a.content_type, content })
  }
  return out
}
