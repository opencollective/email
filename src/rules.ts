import { addTag, all, get, run, setAssignee, getThread, type Collective } from './db.js'
import { now } from './util.js'

/** Sender rules: "mail from X is a <tag> — no reply needed". Matching mail is
 *  tagged, filed as closed (it never screams needs-reply), and never
 *  auto-assigned. Members can still add notes and @-mention teammates. */

export interface Rule {
  id: number
  collective_id: number
  match_from: string // full address, or a domain written as "@domain.tld"
  tag: string
  created_by: number | null
  created_at: number
}

export const listRules = (collectiveId: number) =>
  all<Rule>('SELECT * FROM rules WHERE collective_id = ? ORDER BY id', [collectiveId])

/** The rule matching a sender address, if any. */
export async function ruleFor(collectiveId: number, address: string | null | undefined): Promise<Rule | undefined> {
  const a = (address || '').toLowerCase().trim()
  if (!a) return undefined
  const domain = '@' + (a.split('@')[1] || '')
  const r = await get<Rule>('SELECT * FROM rules WHERE collective_id = ? AND match_from IN (?, ?) LIMIT 1', [collectiveId, a, domain])
  return r ?? undefined
}

export const cleanTag = (name: string) =>
  name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40)

/** Create (or update) a rule and apply it to everything already in the inbox
 *  from that sender: tag, close if still needs_reply, drop the assignee. */
export async function createRule(collective: Collective, matchFrom: string, tag: string, byMemberId: number | null): Promise<{ rule: Rule; applied: number }> {
  const match = matchFrom.toLowerCase().trim()
  const clean = cleanTag(tag)
  if (!clean) throw new Error('The rule needs a tag (e.g. newsletter).')
  if (!/^@?[^@\s]+(@[^@\s]+)?$/.test(match) || !match.includes('@')) throw new Error('Match must be an email address or a domain like @news.example.com.')
  await run(`INSERT INTO rules (collective_id, match_from, tag, created_by, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(collective_id, match_from) DO UPDATE SET tag = excluded.tag`, [collective.id, match, clean, byMemberId, now()])
  const rule = (await get<Rule>('SELECT * FROM rules WHERE collective_id = ? AND match_from = ?', [collective.id, match]))!

  // retro-apply to existing threads from this sender
  const where = match.startsWith('@') ? "t.counterpart_email LIKE '%' || ?" : 't.counterpart_email = ?'
  const threads = await all<{ id: number; status: string; assignee_member_id: number | null }>(
    `SELECT id, status, assignee_member_id FROM threads t WHERE t.collective_id = ? AND ${where}`, [collective.id, match])
  for (const t of threads) {
    await addTag(collective.id, t.id, rule.tag, byMemberId, true)
    if (t.status === 'needs_reply') await run("UPDATE threads SET status = 'closed', updated_at = ? WHERE id = ?", [now(), t.id])
    if (t.assignee_member_id) await setAssignee((await getThread(t.id))!, null, byMemberId, 'manual')
  }
  return { rule, applied: threads.length }
}

export const deleteRule = (collectiveId: number, ruleId: number) =>
  run('DELETE FROM rules WHERE id = ? AND collective_id = ?', [ruleId, collectiveId])
