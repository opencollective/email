/** Dev-only: seed a rule + an HTML newsletter thread, print a session id. */
import { simpleParser } from 'mailparser'
import { createCollective, get, run } from '../src/db.js'
import { createSession } from '../src/auth.js'
import { createRule } from '../src/rules.js'
import { ingestInbound } from '../src/ingest.js'
import { now } from '../src/util.js'

const col = (await get<any>("SELECT * FROM collectives WHERE slug = 'newsdemo'")) ||
  await createCollective('newsdemo', 'News Demo')
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) SELECT ?, 'nd@test.local', 'Demo', 'admin', 'every', ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE collective_id = ? AND email = 'nd@test.local')", [col.id, now(), col.id])
await createRule(col, 'update@nws.eventplanner.test', 'newsletter', null)
await ingestInbound(col, await simpleParser([
  'From: eventplanner.be <update@nws.eventplanner.test>',
  'To: newsdemo@collective.email',
  'Subject: TV - Waarom communicatie stroef loopt',
  `Message-ID: <demo-${Date.now()}@nws.test>`,
  'Content-Type: text/html; charset=utf-8',
  '',
  `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px"><tr><td align="center">
   <table width="560" style="background-color:#ffffff;border-radius:8px"><tr><td style="padding:24px">
   <h1 style="color:#e8500f;font-size:22px;margin:0 0 12px">eventplanner.be weekly</h1>
   <img src="https://picsum.photos/520/200" width="520" alt="header">
   <h2 style="font-size:17px">Waarom communicatie stroef loopt en hoe dit op te lossen</h2>
   <p style="line-height:1.5;color:#333">Ontdek in deze aflevering hoe je miscommunicatie vermijdt op je volgende event.</p>
   <a href="https://www.eventplanner.be/tv" style="display:inline-block;background-color:#e8500f;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none">Bekijk de video</a>
   <script>alert('xss')</script>
   </td></tr></table></td></tr></table>`,
].join('\r\n')))
const t = await get<any>('SELECT id FROM threads WHERE collective_id = ? ORDER BY id DESC LIMIT 1', [col.id])
console.log('THREAD=' + t.id)
console.log('SID=' + await createSession('nd@test.local'))
process.exit(0)
