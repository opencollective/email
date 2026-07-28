/** Dev-only: seed a plain (no-rule) thread to demo the rule-reveal sidebar. */
import { simpleParser } from 'mailparser'
import { get } from '../src/db.js'
import { ingestInbound } from '../src/ingest.js'
const col = await get<any>("SELECT * FROM collectives WHERE slug = 'newsdemo'")
await ingestInbound(col, await simpleParser([
  'From: Luma <noreply@luma.test>',
  'To: newsdemo@collective.email',
  'Subject: Re: Event Submitted to the Calendar',
  `Message-ID: <luma-${Date.now()}@luma.test>`,
  '', 'A new event was submitted to your calendar.',
].join('\r\n')))
const t = await get<any>('SELECT id FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [col.id])
console.log(t.id)
process.exit(0)
