/** Dev-only: replay a Resend received email through ingestion (post-fix). */
import { simpleParser } from 'mailparser'
import { cfg } from '../src/config.js'
import { getCollectiveBySlug } from '../src/db.js'
import { ingestInbound } from '../src/ingest.js'

const emailId = process.argv[2]
const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
  headers: { Authorization: `Bearer ${cfg.resendKey}` },
})
if (!res.ok) throw new Error(`fetch failed ${res.status}`)
const email = await res.json() as { raw?: { download_url?: string } }
if (!email.raw?.download_url) throw new Error('no raw download url')
const raw = Buffer.from(await (await fetch(email.raw.download_url)).arrayBuffer())
const parsed = await simpleParser(raw)
console.log('subject:', parsed.subject, '| from:', parsed.from?.text)
const collective = (await getCollectiveBySlug('commonshub'))!
await ingestInbound(collective, parsed, emailId)
console.log('replayed into', collective.slug)
process.exit(0)
