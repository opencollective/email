import { all, allCollectives, get, run, type Collective } from './db.js'
import { deleteBlob } from './storage.js'
import { now } from './util.js'

/** Closing an inbox is two separate things.
 *
 *  Archiving is immediate and reversible: the address stops receiving that
 *  second (mail to it bounces, which is the honest signal to anyone still
 *  writing), but everything is still here and an admin can undo it.
 *
 *  Deletion is permanent and happens 30 days later, from the cron. The gap
 *  exists because "we closed the wrong inbox" is a thing that happens, and
 *  because a bounce reaches the people who were still writing to you long
 *  before the data is gone. */
export const PURGE_AFTER = 30 * 86400

export const purgeDueAt = (c: Collective): number => (c.archived_at ?? now()) + PURGE_AFTER

export async function archiveCollective(collective: Collective): Promise<void> {
  await run("UPDATE collectives SET status = 'archived', archived_at = ? WHERE id = ?", [now(), collective.id])
}

export async function restoreCollective(collective: Collective): Promise<void> {
  await run("UPDATE collectives SET status = 'active', archived_at = NULL WHERE id = ?", [collective.id])
}

/** Everything that belongs to one collective, in an order that leaves nothing
 *  orphaned if it stops halfway. */
export async function deleteCollectiveForever(collective: Collective): Promise<void> {
  const id = collective.id

  // attachments live outside the database, so they go first — a row we can no
  // longer find is a blob nobody will ever collect
  const blobs = await all<{ path: string }>(`
    SELECT a.path FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE t.collective_id = ? AND a.path IS NOT NULL`, [id])
  for (const b of blobs) await deleteBlob(b.path)

  const threadScoped = [
    'DELETE FROM attachments WHERE message_id IN (SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ?)',
    'DELETE FROM note_mentions WHERE note_id IN (SELECT n.id FROM notes n JOIN threads t ON t.id = n.thread_id WHERE t.collective_id = ?)',
    'DELETE FROM notes WHERE thread_id IN (SELECT id FROM threads WHERE collective_id = ?)',
    'DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE collective_id = ?)',
    'DELETE FROM events WHERE thread_id IN (SELECT id FROM threads WHERE collective_id = ?)',
    'DELETE FROM thread_tags WHERE thread_id IN (SELECT id FROM threads WHERE collective_id = ?)',
    'DELETE FROM reply_tokens WHERE thread_id IN (SELECT id FROM threads WHERE collective_id = ?)',
    'DELETE FROM threads WHERE collective_id = ?',
  ]
  const collectiveScoped = [
    'DELETE FROM tags WHERE collective_id = ?',
    'DELETE FROM rules WHERE collective_id = ?',
    'DELETE FROM invites WHERE collective_id = ?',
    'DELETE FROM member_mutes WHERE collective_id = ?',
    'DELETE FROM member_aliases WHERE collective_id = ?',
    'DELETE FROM credits_ledger WHERE collective_id = ?',
    'DELETE FROM members WHERE collective_id = ?',
    'DELETE FROM collectives WHERE id = ?',
  ]
  for (const sql of [...threadScoped, ...collectiveScoped]) await run(sql, [id])
  // per-collective scratch state (trial reminders, credit one-shots)
  await run("DELETE FROM kv WHERE k LIKE ?", [`trialmail:${id}:%`]).catch(() => undefined)

  console.log(`[archive] purged collective ${collective.slug} (#${id}) and ${blobs.length} attachment(s)`)
}

/** Hourly: delete what has been archived long enough. */
export async function purgeArchivedTick(): Promise<void> {
  const cutoff = now() - PURGE_AFTER
  for (const collective of await allCollectives()) {
    if (collective.status !== 'archived') continue
    if ((collective.archived_at ?? now()) > cutoff) continue
    try {
      await deleteCollectiveForever(collective)
    } catch (err) {
      console.error(`[archive] purge failed for ${collective.slug}:`, err)
    }
  }
}

/** Does this inbox still hold anything worth downloading before it goes? */
export const messageCount = async (collectiveId: number): Promise<number> => Number((await get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ?',
  [collectiveId]))?.n ?? 0)
