/** One-off prod setup: newsletter rules for commonshub (retro-applies), then
 *  backfill body_html from Resend raw MIME for rule-matched messages so old
 *  newsletters render in HTML too. Pass --write to apply; dry run by default. */
import { simpleParser } from 'mailparser'
import { all, get, run } from '../src/db.js'
import { createRule, listRules, ruleFor } from '../src/rules.js'
import { sanitizeEmailHtml } from '../src/sanitize.js'

const write = process.argv.includes('--write')
const key = process.env.RESEND_API_KEY
const col = (await get<any>("SELECT * FROM collectives WHERE slug = 'commonshub'"))!

const RULES: [string, string][] = [
  ['update@nws.eventplanner.net', 'newsletter'], // the example from Xavier
  ['@news.koro.com', 'newsletter'],
  ['@mail.beehiiv.com', 'newsletter'],
]
for (const [from, tag] of RULES) {
  if (write) {
    const { applied } = await createRule(col, from, tag, null)
    console.log(`rule ${from} → #${tag} (${applied} existing threads filed)`)
  } else {
    console.log(`would create rule ${from} → #${tag}`)
  }
}

// backfill HTML for inbound messages now covered by a rule
const msgs = await all<any>(`
  SELECT m.id, m.from_email, m.resend_email_id FROM messages m
  JOIN threads t ON t.id = m.thread_id
  WHERE t.collective_id = ? AND m.direction = 'inbound' AND m.body_html IS NULL AND m.resend_email_id IS NOT NULL`, [col.id])
let filled = 0
for (const m of msgs) {
  if (!(await ruleFor(col.id, m.from_email))) continue
  if (!key) { console.log(`msg ${m.id} (${m.from_email}): RESEND_API_KEY needed for backfill`); continue }
  const res = await fetch(`https://api.resend.com/emails/receiving/${m.resend_email_id}`, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) { console.log(`msg ${m.id}: fetch failed ${res.status}`); continue }
  const data = await res.json() as any
  let html = typeof data.html === 'string' ? data.html : ''
  if (!html && data.raw?.download_url) {
    const rawRes = await fetch(data.raw.download_url)
    if (rawRes.ok) {
      const parsed = await simpleParser(Buffer.from(await rawRes.arrayBuffer()))
      html = typeof parsed.html === 'string' ? parsed.html : ''
    }
  }
  if (!html) { console.log(`msg ${m.id} (${m.from_email}): no HTML part`); continue }
  const clean = sanitizeEmailHtml(html).slice(0, 400_000)
  console.log(`msg ${m.id} (${m.from_email}): html ${html.length} → sanitized ${clean.length}`)
  if (write) { await run('UPDATE messages SET body_html = ? WHERE id = ?', [clean, m.id]); filled++ }
}
console.log(write ? `done — rules: ${(await listRules(col.id)).length}, backfilled: ${filled}` : 'dry run — add --write')
process.exit(0)
