/** Import a collective's archive zip (Settings → Data → Download) into this instance.
 *
 *    npm run import -- path/to/archive.zip [--slug newaddress] [--name "New name"]
 *    node dist/cli-import.js /data/archive.zip          (inside the Docker image)
 *
 *  Uses the same env as the server (DATA_DIR or TURSO_*, BLOB_READ_WRITE_TOKEN). */
import fs from 'node:fs'
import { importArchive } from './import.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const slug = flag('slug'), name = flag('name')
const file = args[0]
if (!file) {
  console.error('usage: npm run import -- <archive.zip> [--slug address] [--name "Name"]')
  process.exit(1)
}
let s: Awaited<ReturnType<typeof importArchive>>
try {
  s = await importArchive(new Uint8Array(fs.readFileSync(file)), { slug, name })
} catch (err) {
  console.error(`Import failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
console.log(`Imported ${s.collective.slug} (${s.collective.name}): ${s.members} members, ${s.threads} threads, ${s.messages} messages, ${s.notes} notes, ${s.attachments} attachments.`)
if (s.skippedAgents) console.log(`${s.skippedAgents} agent(s) not imported: invite them again from the Collective page.`)
console.log('Members sign in with their usual email address; no invitations needed.')
process.exit(0)
