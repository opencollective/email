import { activeMembers, run, type Collective, type Member, type Thread, feedAgents, grantThreadAccess } from './db.js'
import { mentionedMembers } from './mentions.js'
import { notifyMention } from './notify.js'
import { now } from './util.js'

/** The one path a note takes, wherever it was written — the web composer or a
 *  reply to a mention notification. Both resolve mentions the same way, so
 *  answering "@Leen can you check?" by email notifies Leen exactly as it would
 *  have from the browser, and the conversation can keep bouncing. */
export async function addNote(
  collective: Collective,
  thread: Thread,
  author: Member,
  text: string,
): Promise<{ id: number; mentioned: Member[]; notified: boolean }> {
  const body = text.trim().slice(0, 10000)
  const roster = await activeMembers(collective.id)
  // mentioning yourself is a no-op: you already know
  const mentioned = mentionedMembers(body, roster).filter((m) => m.id !== author.id)

  const { lastId } = await run(
    'INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)',
    [thread.id, author.id, body, now()])
  for (const m of mentioned) {
    await run('INSERT OR IGNORE INTO note_mentions (note_id, member_id, created_at) VALUES (?, ?, ?)',
      [lastId, m.id, now()])
    // mentioning a guest IS sharing the thread with them — otherwise the
    // mention would point at a conversation they cannot open
    if (m.role === 'guest') await grantThreadAccess(m.id, thread.id)
  }
  // fed AFTER the mentions exist, so a poll can never see the note without them
  await feedAgents(collective.id, 'note.new', thread.id, lastId)

  let notified = true
  if (mentioned.length) {
    // the note is already saved — a mail failure must not cost the writing
    try {
      await notifyMention(collective, thread, author, mentioned, body)
    } catch (err) {
      console.error('[notes] mention notification failed:', err)
      notified = false
    }
  }
  return { id: lastId, mentioned, notified }
}
