import { addTag, all, get, run, setAssignee, getThread, type Collective } from './db.js'
import { now } from './util.js'

/** Rules: "WHEN a message matches (sender and/or subject) THEN tag it,
 *  assign it (to somebody, or explicitly nobody), and optionally close it
 *  (no reply needed)". Closed-by-rule mail is still forwarded to members and
 *  open for internal notes and mentions. */

export interface Rule {
  id: number
  collective_id: number
  match_from: string | null // full address, or a domain written as "@domain.tld"
  match_subject: string | null // case-insensitive "subject contains"
  tag: string | null
  assign_member_id: number | null // null = leave unassigned
  close: number // 1 = mark closed (no reply needed)
  created_by: number | null
  created_at: number
}

export const listRules = (collectiveId: number) =>
  all<Rule>('SELECT * FROM rules WHERE collective_id = ? ORDER BY id', [collectiveId])

const fromMatches = (rule: Rule, address: string) =>
  !rule.match_from || (rule.match_from.startsWith('@') ? address.endsWith(rule.match_from) : address === rule.match_from)

const subjectMatches = (rule: Rule, subject: string) =>
  !rule.match_subject || subject.toLowerCase().includes(rule.match_subject.toLowerCase())

/** First rule matching this sender + subject, if any. */
export async function matchingRule(collectiveId: number, address: string | null | undefined, subject: string | null | undefined): Promise<Rule | undefined> {
  const a = (address || '').toLowerCase().trim()
  const s = subject || ''
  const rules = await listRules(collectiveId)
  return rules.find((r) => (r.match_from || r.match_subject) && fromMatches(r, a) && subjectMatches(r, s))
}

export const cleanTag = (name: string) =>
  name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40)

export interface RuleSpec {
  from?: string
  subject?: string
  tag?: string
  assignMemberId?: number | null
  close?: boolean
}

/** Create (or update, when the same criteria already exist) a rule, then
 *  apply it to everything already in the inbox that matches. */
export async function createRule(collective: Collective, spec: RuleSpec, byMemberId: number | null): Promise<{ rule: Rule; applied: number }> {
  const from = (spec.from || '').toLowerCase().trim() || null
  const subject = (spec.subject || '').trim().slice(0, 200) || null
  const tag = spec.tag ? cleanTag(spec.tag) : null
  const assign = spec.assignMemberId ?? null
  const close = spec.close !== false

  if (!from && !subject) throw new Error('Match on a sender, a subject, or both.')
  if (from && (!/^@?[^@\s]+(@[^@\s]+)?$/.test(from) || !from.includes('@'))) {
    throw new Error('Sender must be an email address or a domain like @news.example.com.')
  }
  if (!tag && !assign && !close) throw new Error("This rule wouldn't do anything — add a tag, an assignee, or close matching threads.")

  const existing = await get<Rule>(
    'SELECT * FROM rules WHERE collective_id = ? AND match_from IS ? AND match_subject IS ?',
    [collective.id, from, subject])
  if (existing) {
    await run('UPDATE rules SET tag = ?, assign_member_id = ?, close = ? WHERE id = ?', [tag, assign, close ? 1 : 0, existing.id])
  } else {
    await run('INSERT INTO rules (collective_id, match_from, match_subject, tag, assign_member_id, close, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [collective.id, from, subject, tag, assign, close ? 1 : 0, byMemberId, now()])
  }
  const rule = (await get<Rule>('SELECT * FROM rules WHERE collective_id = ? AND match_from IS ? AND match_subject IS ?', [collective.id, from, subject]))!

  // retro-apply to matching threads already in the inbox
  const conds: string[] = []
  const args: (string | number)[] = [collective.id]
  if (from) {
    conds.push(from.startsWith('@') ? "t.counterpart_email LIKE '%' || ?" : 't.counterpart_email = ?')
    args.push(from)
  }
  if (subject) {
    conds.push("LOWER(t.subject) LIKE '%' || ? || '%'")
    args.push(subject.toLowerCase())
  }
  const threads = await all<{ id: number; status: string; assignee_member_id: number | null }>(
    `SELECT id, status, assignee_member_id FROM threads t WHERE t.collective_id = ? AND ${conds.join(' AND ')}`, args)
  for (const t of threads) {
    if (rule.tag) await addTag(collective.id, t.id, rule.tag, byMemberId, true)
    if (rule.close && t.status === 'needs_reply') await run("UPDATE threads SET status = 'closed', updated_at = ? WHERE id = ?", [now(), t.id])
    if (rule.assign_member_id && !t.assignee_member_id) {
      await setAssignee((await getThread(t.id))!, rule.assign_member_id, byMemberId, 'manual')
    } else if (!rule.assign_member_id && rule.close && t.assignee_member_id) {
      await setAssignee((await getThread(t.id))!, null, byMemberId, 'manual')
    }
  }
  return { rule, applied: threads.length }
}

/** Human sentences for a rule row: what it matches, what it does. */
export function describeRule(rule: Rule, memberName?: string): { when: string; then: string } {
  const when = [
    rule.match_from ? `from ${rule.match_from}` : '',
    rule.match_subject ? `subject contains “${rule.match_subject}”` : '',
  ].filter(Boolean).join(' and ')
  const then = [
    rule.tag ? `#${rule.tag}` : '',
    rule.assign_member_id ? `assign to ${memberName || 'a member'}` : 'unassigned',
    rule.close ? 'closed — no reply needed' : '',
  ].filter(Boolean).join(' · ')
  return { when, then }
}

export const deleteRule = (collectiveId: number, ruleId: number) =>
  run('DELETE FROM rules WHERE id = ? AND collective_id = ?', [ruleId, collectiveId])
