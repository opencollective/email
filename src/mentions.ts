import type { Member } from './db.js'

/** @mentions in internal notes.
 *
 *  Notes are stored as plain text — exactly what the author typed — and the
 *  mentions are resolved from that text against the collective's members. No
 *  markup, no ids embedded in the body: the note stays readable in the export,
 *  in the digest, and in the database, and a note written before someone joined
 *  starts resolving the day they do.
 *
 *  The trade is that a member who changes their name loses the highlight on old
 *  notes. That is the right way round: the text keeps saying what was written. */

/** Letters and digits — the characters that make a mention run on. Unicode
 *  aware, so "@José" and "@Zoë" match to their end and not before the accent. */
const WORD = /[\p{L}\p{N}]/u

export interface Mention {
  /** index of the '@' in the body */
  start: number
  /** index just past the matched label */
  end: number
  member: Member
}

/** Every string that may follow an '@', longest first so "@Marie Dupont" wins
 *  over "@Marie" when both resolve. */
export function mentionLabels(members: Member[]): { label: string; member: Member }[] {
  // a bare first name is only offered when it points at exactly one person —
  // two Maries in a collective means you have to type the surname
  const firstNames = new Map<string, number>()
  const firstOf = (m: Member) => (m.name || '').trim().split(/\s+/)[0].toLowerCase()
  for (const m of members) {
    const f = firstOf(m)
    if (f) firstNames.set(f, (firstNames.get(f) || 0) + 1)
  }

  const out: { label: string; member: Member }[] = []
  for (const m of members) {
    const labels = new Set<string>()
    if (m.name?.trim()) labels.add(m.name.trim().toLowerCase())
    labels.add(m.email.toLowerCase())
    labels.add(m.email.split('@')[0].toLowerCase())
    const f = firstOf(m)
    if (f && firstNames.get(f) === 1) labels.add(f)
    for (const label of labels) if (label) out.push({ label, member: m })
  }
  // stable sort → ties (one person's login name equal to another's first name)
  // resolve to whoever comes first in the member list, deterministically
  return out.sort((a, b) => b.label.length - a.label.length)
}

/** Locate every mention in a note body, in order of appearance. */
export function findMentions(body: string, members: Member[]): Mention[] {
  const labels = mentionLabels(members)
  const lower = body.toLowerCase()
  const found: Mention[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue
    // an '@' glued to the previous word is an email address, not a mention
    if (i > 0 && WORD.test(body[i - 1])) continue
    const rest = lower.slice(i + 1)
    const hit = labels.find(
      (c) => rest.startsWith(c.label) && !WORD.test(rest[c.label.length] ?? ' '),
    )
    if (!hit) continue
    const end = i + 1 + hit.label.length
    found.push({ start: i, end, member: hit.member })
    i = end - 1
  }
  return found
}

/** The distinct members a note mentions, in order of first appearance. */
export function mentionedMembers(body: string, members: Member[]): Member[] {
  const seen = new Set<number>()
  const out: Member[] = []
  for (const m of findMentions(body, members)) {
    if (seen.has(m.member.id)) continue
    seen.add(m.member.id)
    out.push(m.member)
  }
  return out
}

export type NotePart =
  | { text: string }
  | { mention: string; member: Member }

/** A note body cut into plain runs and mention runs, for rendering. */
export function noteParts(body: string, members: Member[]): NotePart[] {
  const parts: NotePart[] = []
  let cursor = 0
  for (const m of findMentions(body, members)) {
    if (m.start > cursor) parts.push({ text: body.slice(cursor, m.start) })
    parts.push({ mention: body.slice(m.start, m.end), member: m.member })
    cursor = m.end
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) })
  return parts
}
