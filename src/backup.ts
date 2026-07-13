import { all, kvGet, kvSet } from './db.js'
import { saveBlob } from './storage.js'
import { cfg } from './config.js'

const TABLES = [
  'collectives', 'members', 'threads', 'messages', 'notes', 'events',
  'tags', 'thread_tags', 'invites', 'waitlist', 'kv',
]

/** Nightly full-database dump to the private Blob store (backups/YYYY-MM-DD.json).
 *  Belt-and-braces on top of Turso's own durability; restore = re-INSERT the JSON. */
export async function backupTick() {
  if (!cfg.blobToken || cfg.dbUrl.startsWith('file:')) return
  const date = new Date().toISOString().slice(0, 10)
  const key = `backup:${date}`
  if (await kvGet(key)) return
  await kvSet(key, String(Math.floor(Date.now() / 1000))) // claim before the slow part (avoids double runs)
  try {
    const dump: Record<string, unknown[]> = {}
    for (const t of TABLES) dump[t] = await all(`SELECT * FROM ${t}`)
    const body = Buffer.from(JSON.stringify({ created_at: new Date().toISOString(), tables: dump }))
    await saveBlob(`backups/${date}.json`, body, 'application/json')
    console.log(`[backup] ${date} written (${Math.ceil(body.length / 1024)} KB)`)
  } catch (err) {
    console.error('[backup] failed:', err)
  }
}
