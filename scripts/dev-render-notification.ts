/** Dev-only: render a thread notification email to a file for visual review. */
import fs from 'node:fs'
import { simpleParser } from 'mailparser'
import { createCollective, get, run, all } from '../src/db.js'
import { ingestInbound } from '../src/ingest.js'
import { now } from '../src/util.js'

const slug = `notifdemo${Date.now() % 1000}`
const col = await createCollective(slug, 'Commons Hub Brussels')
await run("UPDATE collectives SET plan='pro', custom_domain='commonshub.brussels', custom_local='hello', domain_status='verified' WHERE id = ?", [col.id])
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'leen@t.test', 'Leen', 'member', 'every', ?)", [col.id, now()])
await run("INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, 'cedric@t.test', 'Cédric', 'member', 'every', ?)", [col.id, now()])
const pro = (await get<any>('SELECT * FROM collectives WHERE id = ?', [col.id]))!
await ingestInbound(pro, await simpleParser([
  'From: Solutions RN <info@solutionsrn.test>',
  'To: hello@commonshub.brussels',
  "Subject: Une question concernant l'entretien de votre établissement à Bruxelles",
  `Message-ID: <n-${Date.now()}@solutionsrn.test>`,
  '',
  `Bonjour,

En découvrant *Commons Hub Brussels* et votre espace communautaire et événementiel au cœur de Bruxelles, je souhaitais vous présenter une solution qui pourrait simplifier l'entretien quotidien de vos espaces.

Nous accompagnons déjà plusieurs lieux hybrides à Bruxelles avec des équipes formées et un suivi qualité mensuel.

Seriez-vous disponible pour un court échange la semaine prochaine ?

Bien à vous,
Rachid`,
].join('\r\n')))
const html = fs.readFileSync('data/last-email.html', 'utf8')
fs.writeFileSync(process.argv[2] || 'notif.html', html)
console.log('written; members:', (await all('SELECT email FROM members WHERE collective_id = ?', [col.id])).length)
process.exit(0)
