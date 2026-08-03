import type { AddressObject, ParsedMail } from 'mailparser'
import { cfg } from './config.js'
import {
  activeMembers, addEvent, addTag, all, get, getCollective, getMember, getMemberIn, getThread, run, setAssignee, setStatus, storeAttachment,
  suggestedAssigneeFor, type Collective, type Member, type Message, type Thread,
} from './db.js'
import { htmlToText, normalizeSubject, now, stripQuotedReply } from './util.js'
import { matchingRule, type Rule } from './rules.js'
import { sanitizeEmailHtml } from './sanitize.js'
import { notifyInbound, sendCollisionNotice, sendReplyConfirmation, sendReplyFailure } from './notify.js'
import { sendCollectiveReply } from './outbound.js'
import { kvGet, kvSet } from './db.js'

/** Best-effort plain text from a parsed email; HTML-only mail (e.g. Apple Mail
 *  with inline images) has no text part at all. `dropQuotes` also removes the
 *  quoted history (blockquotes + "On … wrote:" tails) for member replies. */
export function plainText(parsed: ParsedMail, dropQuotes = false): string {
  if (parsed.text?.trim()) return dropQuotes ? stripQuotedReply(parsed.text) : parsed.text
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  if (!html) return ''
  const cleaned = dropQuotes ? html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '') : html
  const text = htmlToText(cleaned)
  return dropQuotes ? stripQuotedReply(text) : text
}

export const addrList = (a?: AddressObject | AddressObject[]): { address: string; name: string }[] => {
  const arr = Array.isArray(a) ? a : a ? [a] : []
  return arr.flatMap((x) => x.value).map((v) => ({ address: (v.address || '').toLowerCase(), name: v.name || '' }))
}

/** The collective's own receiving addresses. */
const ownAddressesOf = (collective: Collective): string[] => [
  `${collective.slug}@${cfg.emailDomain}`,
  collective.custom_domain && collective.custom_local ? `${collective.custom_local}@${collective.custom_domain}`.toLowerCase() : '',
].filter(Boolean)

/** Resolve a sender to the team. Exact member email first; otherwise anyone
 *  on the collective's own custom domain writes as the team (people use
 *  aliases like inge@domain while their member record says another address) —
 *  matched to a member by local part when possible. The collective's own
 *  receiving address is NOT a team sender (website tools send as it). */
export async function teamSender(collective: Collective, address: string): Promise<{ team: boolean; member?: Member }> {
  if (!address || ownAddressesOf(collective).includes(address)) return { team: false }
  const exact = await getMemberIn(collective.id, address)
  if (exact && !exact.removed_at) return { team: true, member: exact }
  // an address an admin explicitly linked to a member (personal gmail etc.)
  const alias = await get<{ member_id: number }>('SELECT member_id FROM member_aliases WHERE collective_id = ? AND email = ?', [collective.id, address])
  if (alias) {
    const m = await getMember(alias.member_id)
    if (m && !m.removed_at) return { team: true, member: m }
  }
  const domain = collective.custom_domain?.toLowerCase()
  if (domain && address.endsWith(`@${domain}`)) {
    const local = address.split('@')[0]
    const members = await all<Member>('SELECT * FROM members WHERE collective_id = ? AND removed_at IS NULL', [collective.id])
    return { team: true, member: members.find((m) => m.email.split('@')[0].toLowerCase() === local) }
  }
  return { team: false }
}

/** First recipient who is neither the collective nor the team — who a team
 *  member was actually writing to when they looped the collective in. */
export async function externalRecipient(
  collective: Collective,
  addrs: { address: string; name: string }[],
): Promise<{ address: string; name: string } | undefined> {
  const own = new Set(ownAddressesOf(collective))
  const domain = collective.custom_domain?.toLowerCase()
  const memberEmails = new Set([
    ...(await all<{ email: string }>('SELECT email FROM members WHERE collective_id = ? AND removed_at IS NULL', [collective.id])).map((r) => r.email),
    ...(await all<{ email: string }>('SELECT email FROM member_aliases WHERE collective_id = ?', [collective.id])).map((r) => r.email),
  ])
  return addrs.find((a) =>
    a.address && !a.address.endsWith(`@${cfg.emailDomain}`) && !own.has(a.address)
    && !memberEmails.has(a.address) && !(domain && a.address.endsWith(`@${domain}`)))
}

/** Who the email is really from. Mail relayed through a group or list (e.g. a
 *  Google Group forwarding hello@domain to us) often rewrites From to the
 *  group's own address to satisfy DMARC — the original author survives in
 *  X-Original-From / X-Original-Sender / Reply-To. Threading, auto-assignment
 *  and replies must track the author, not the relay. */
export function effectiveSender(parsed: ParsedMail, collective: Collective): { address: string; name: string } {
  const from = addrList(parsed.from)[0] || { address: '', name: '' }
  const ownAddrs = ownAddressesOf(collective)
  const own = (a: string) => !a || a.endsWith(`@${cfg.emailDomain}`) || ownAddrs.includes(a)
  const headerAddr = (h: string): { address: string; name: string } | null => {
    const raw = String(parsed.headers?.get(h) ?? '').trim()
    if (!raw) return null
    const m = raw.match(/<([^<>\s]+@[^<>\s]+)>/)
    const address = (m ? m[1] : raw).toLowerCase().trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null
    return { address, name: m ? raw.slice(0, raw.indexOf('<')).replace(/["']/g, '').trim() : '' }
  }
  // Only distrust From when a relay clearly rewrote it: it's one of our own
  // receiving addresses, or the relay left its X-Original-* marker behind.
  const rewritten = own(from.address) || headerAddr('x-original-sender') || headerAddr('x-original-from')
  if (!rewritten) return from
  const candidates = [headerAddr('x-original-from'), headerAddr('x-original-sender'), ...addrList(parsed.replyTo)]
  const real = candidates.find((c): c is { address: string; name: string } => !!c && !own(c.address))
  if (!real) return from
  // Google keeps the author's name in From as "'Their Name' via Group Name"
  return { address: real.address, name: real.name || from.name.replace(/\s+via\s+.+$/i, '').replace(/^'(.*)'$/, '$1').trim() }
}

export function isAutoSubmitted(parsed: ParsedMail): boolean {
  const h = (name: string) => String(parsed.headers?.get(name) ?? '')
  if (/^auto-(replied|generated)/i.test(h('auto-submitted'))) return true
  if (/^(bulk|junk|auto_reply)/i.test(h('precedence'))) return true
  if (h('x-autoreply') || h('x-autorespond')) return true
  if (/^(auto:|automatic reply|out of office|abwesenheit)/i.test(parsed.subject || '')) return true
  return false
}

// ---------- threading ----------

async function findThread(collective: Collective, parsed: ParsedMail, counterpart?: string): Promise<Thread | undefined> {
  const refs = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []),
  ]
  for (const ref of refs) {
    const m = await get<{ thread_id: number }>(`
      SELECT m.thread_id FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.rfc822_message_id = ? AND t.collective_id = ?
    `, [ref, collective.id])
    if (m) return getThread(m.thread_id)
  }
  // last resort: same normalized subject + same counterpart within 60 days
  const subj = normalizeSubject(parsed.subject || '')
  if (subj && counterpart) {
    const rows = await all<Thread>(`
      SELECT * FROM threads WHERE collective_id = ? AND counterpart_email = ? AND last_message_at > ?
      ORDER BY last_message_at DESC
    `, [collective.id, counterpart, now() - 60 * 86400])
    return rows.find((x) => normalizeSubject(x.subject) === subj)
  }
  return undefined
}

// ---------- inbound customer email ----------

/** Ingest a parsed inbound email for a collective: thread it, store it,
 *  auto-assign, and notify members. Deduped by Message-ID. */
export async function ingestInbound(
  collective: Collective,
  parsed: ParsedMail,
  resendEmailId?: string,
  extraActions?: { label: string; url: string }[],
) {
  const msgId = parsed.messageId || `<synthetic-${resendEmailId || now()}@${cfg.emailDomain}>`
  if (await get('SELECT id FROM messages WHERE rfc822_message_id = ?', [msgId])) return

  const rawFrom = addrList(parsed.from)[0] || { address: '', name: '' }
  const tos = addrList(parsed.to)
  const ccs = addrList(parsed.cc)
  // Loop guard: never ingest mail sent from our own domain (our notifications,
  // our replies) — EXCEPT the forwarding test, whose whole point is to come
  // back around and prove the custom-domain forward works.
  const isForwardTest = /^Forwarding test for /.test(parsed.subject || '')
  if (rawFrom.address.endsWith(`@${cfg.emailDomain}`) && !isForwardTest) return
  const from = effectiveSender(parsed, collective)

  const sentAt = parsed.date ? Math.floor(parsed.date.getTime() / 1000) : now()
  const refs = Array.isArray(parsed.references) ? parsed.references[0] : parsed.references
  const isReply = !!(parsed.inReplyTo || refs)

  const { team, member } = isForwardTest ? { team: false, member: undefined } : await teamSender(collective, from.address)

  // Who this message is really "with": for a teammate's own mail that's the
  // outsider they wrote to, never the teammate. Threading has to use that,
  // otherwise a reply whose References we never saw (they answered from their
  // mailbox, quoting a copy that never passed through us) opens a duplicate
  // thread beside the customer's original.
  const ext = team ? await externalRecipient(collective, [...tos, ...ccs]) : undefined
  let thread = await findThread(collective, parsed, (team ? ext?.address : from.address) || from.address)

  // A teammate writing from their own mailbox (the copy reaches us through the
  // group/forward) is the team side of the conversation, not a new customer:
  // - on a thread we know → it's the answer
  // - a reply referencing mail we never received → they're looping the
  //   collective into an external conversation; the thread is WITH whoever
  //   they were writing to, already answered by them
  // - genuinely new mail to the collective (or an internal note to teammates)
  //   → ordinary inbound, but claimed by that member so it never sits
  //   "unclaimed" in the inbox
  let counterpart = from
  let teamAnswer = team && !!thread
  if (!thread && team && isReply && ext) { counterpart = ext; teamAnswer = true }

  // Sender rules: newsletters & co. get tagged and filed — closed, never
  // assigned — but still forwarded to members (in HTML) so they can read them.
  const rule: Rule | undefined = !isForwardTest && !team ? await matchingRule(collective.id, from.address, parsed.subject) : undefined

  // An answer from an address we don't know, written TO the thread's
  // counterpart (a customer never writes to themselves): someone on the team
  // answered from an unlinked mailbox. File it as the answer so the thread
  // doesn't scream needs-reply, but leave it unattributed — the thread view
  // asks an admin to link the address to a member or mark it external.
  let unknownAnswer = false
  if (!team && !rule && !teamAnswer && thread && thread.counterpart_email && from.address
    && from.address !== thread.counterpart_email && !isAutoSubmitted(parsed)) {
    const rcpts = [...tos, ...ccs].map((a) => a.address)
    if (rcpts.includes(thread.counterpart_email) && !(await kvGet(`notteam:${collective.id}:${from.address}`))) {
      unknownAnswer = true
    }
  }
  const answer = teamAnswer || unknownAnswer

  let isNewThread = false
  if (!thread) {
    isNewThread = true
    const r = await run(`
      INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', ?, ?, ?, ?, 'inbound', ?, ?)
    `, [collective.id, parsed.subject?.trim() || '(no subject)', counterpart.address || null, counterpart.name || null, sentAt, sentAt, now(), now()])
    thread = (await getThread(r.lastId))!
  }

  const rawHtml = typeof parsed.html === 'string' ? parsed.html : ''
  const bodyHtml = rawHtml ? sanitizeEmailHtml(rawHtml).slice(0, 400_000) : null
  const r = await run(`
    INSERT INTO messages (thread_id, rfc822_message_id, in_reply_to, direction, from_email, from_name, to_json, cc_json, body_text, body_html, sent_by_member_id, resend_email_id, sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    thread.id, msgId, parsed.inReplyTo || refs || null, answer ? 'outbound' : 'inbound',
    from.address, from.name,
    JSON.stringify(tos.map((t) => t.address)), JSON.stringify(ccs.map((c) => c.address)),
    plainText(parsed).slice(0, 100_000), bodyHtml, teamAnswer ? member?.id ?? null : null,
    resendEmailId ?? null, sentAt, now(),
  ])
  const messageDbId = r.lastId
  for (const [i, att] of (parsed.attachments || []).entries()) {
    try {
      await storeAttachment(messageDbId, att.filename, att.contentType, att.content, i)
    } catch (err) {
      console.error('[ingest] failed to save attachment:', err)
    }
  }

  if (sentAt >= (thread.last_message_at ?? 0)) {
    await run('UPDATE threads SET last_message_at = ?, last_direction = ?, updated_at = ? WHERE id = ?',
      [sentAt, answer ? 'outbound' : 'inbound', now(), thread.id])
  }
  if (thread.status !== 'spam') {
    await setStatus(thread.id, isForwardTest || answer ? 'answered' : rule?.close ? 'closed' : 'needs_reply', member?.id ?? null, true)
  }
  if (rule?.tag) await addTag(collective.id, thread.id, rule.tag, null, true)
  if (rule?.assign_member_id && !thread.assignee_member_id) {
    await setAssignee(thread, rule.assign_member_id, null, 'auto_sender')
  }

  // The answer's author claims the thread. A member's genuine question or
  // internal note does NOT self-claim: it needs a teammate to pick it up.
  if (teamAnswer && member && !thread.assignee_member_id) {
    await setAssignee(thread, member.id, member.id, 'email_reply')
  }

  // Auto-assign new threads based on who handled this sender before
  if (isNewThread && from.address && !team && !rule) {
    const suggested = await suggestedAssigneeFor(collective.id, from.address, thread.id)
    if (suggested) await setAssignee((await getThread(thread.id))!, suggested, null, 'auto_sender')
  }

  // One-member collectives: every thread is theirs, no claiming ceremony
  if (isNewThread && !team && !rule?.close && !answer) {
    const fresh = (await getThread(thread.id))!
    if (!fresh.assignee_member_id) {
      const active = await activeMembers(collective.id)
      if (active.length === 1) await setAssignee(fresh, active[0].id, null, 'solo')
    }
  }

  if (!isAutoSubmitted(parsed) && !isForwardTest && !answer) {
    const message = (await get<Message>('SELECT * FROM messages WHERE id = ?', [messageDbId]))!
    // awaited: on serverless, work after the response is returned may be killed
    // rule-closed mail gets the light "filed" notification; a rule that only
    // tags/assigns leaves the normal reply flow intact
    await notifyInbound(collective, (await getThread(thread.id))!, message, extraActions, rule?.close ? rule : undefined).catch((err) => console.error('[notify] failed:', err))
  }

  console.log(`[ingest] ${collective.slug}: "${parsed.subject}" → thread ${thread.id}${isNewThread ? ' (new)' : ''}${answer ? ` (answer by ${from.address}${unknownAnswer ? ', unlinked' : ''})` : ''}${rule ? ` (rule ${rule.id}${rule.tag ? `: #${rule.tag}` : ''})` : ''}`)
}

// ---------- member reply-by-email (notification Reply-To) ----------

export async function handleEmailReply(
  parsed: ParsedMail,
  ref: { slug: string; threadId: number; memberId: number; msgId: number },
) {
  const member = await getMember(ref.memberId)
  const thread = await getThread(ref.threadId)
  if (!member || member.removed_at || !thread || thread.id !== ref.threadId) return
  const collective = await getCollective(thread.collective_id)
  if (!collective || collective.slug !== ref.slug) return
  // Never let vacation autoresponders or mail-loop artifacts reach the sender
  if (isAutoSubmitted(parsed)) return
  if (member.role === 'reader' || member.role === 'commenter') {
    await sendReplyFailure(collective, member, thread,
      member.role === 'reader'
        ? 'You have read access to this collective. Ask an admin to let you comment or send.'
        : 'Your role can comment in the web inbox but not send email to the outside. Ask an admin for sending rights.',
      plainText(parsed, true))
    return
  }

  // Dedupe: webhook deliveries can retry — never send the same reply twice
  if (parsed.messageId) {
    const dedupeKey = `handled:${parsed.messageId}`
    if (await kvGet(dedupeKey)) return
    await kvSet(dedupeKey, String(now()))
  }

  const draft = plainText(parsed, true)
  const attachments = (parsed.attachments || []).map((a, i) => ({
    filename: a.filename || `attachment-${i + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    content: a.content,
  }))

  if (!draft && attachments.length === 0) {
    // nothing sendable — tell the member instead of dropping it on the floor
    await sendReplyFailure(collective, member, thread, 'Your email seemed to be empty (no text we could extract, no attachments).', '')
    return
  }

  // Collision: has anyone answered since the message this notification was about?
  const orig = await get<Message>('SELECT * FROM messages WHERE id = ?', [ref.msgId])
  const newer = await get<Message>(`
    SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' AND sent_at > ?
    ORDER BY sent_at DESC LIMIT 1
  `, [ref.threadId, orig?.sent_at ?? 0])

  if (newer) {
    const by = newer.sent_by_member_id ? await getMember(newer.sent_by_member_id) : undefined
    await addEvent(thread.id, member.id, 'reply_blocked', { answered_by: newer.sent_by_member_id, via: 'email' })
    await sendCollisionNotice(collective, member, thread, by, newer.sent_at, draft)
    console.log(`[ingest] blocked duplicate email reply from ${member.email} on thread ${thread.id}`)
    return
  }

  try {
    await sendCollectiveReply(collective, thread.id, draft, member, 'email', attachments)
    const fresh = (await getThread(thread.id))!
    if (!fresh.assignee_member_id) await setAssignee(fresh, member.id, member.id, 'email_reply')
    await sendReplyConfirmation(collective, member, thread, thread.counterpart_email || 'the sender')
    console.log(`[ingest] ${member.email} replied via email on thread ${thread.id}`)
  } catch (err) {
    console.error('[ingest] email reply failed to send:', err)
    await sendReplyFailure(collective, member, thread,
      err instanceof Error ? err.message : 'Unknown error while sending.', draft).catch(() => {})
  }
}
