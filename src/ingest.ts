import type { AddressObject, ParsedMail } from 'mailparser'
import { cfg } from './config.js'
import {
  addEvent, all, get, getCollective, getMember, getThread, run, setAssignee, setStatus, storeAttachment,
  suggestedAssigneeFor, type Collective, type Message, type Thread,
} from './db.js'
import { htmlToText, normalizeSubject, now, stripQuotedReply } from './util.js'
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

  const from = addrList(parsed.from)[0] || { address: '', name: '' }
  const tos = addrList(parsed.to)
  const ccs = addrList(parsed.cc)
  // Loop guard: never ingest mail sent from our own domain (our notifications,
  // our replies) — EXCEPT the forwarding test, whose whole point is to come
  // back around and prove the custom-domain forward works.
  const isForwardTest = /^Forwarding test for /.test(parsed.subject || '')
  if (from.address.endsWith(`@${cfg.emailDomain}`) && !isForwardTest) return

  const sentAt = parsed.date ? Math.floor(parsed.date.getTime() / 1000) : now()
  let thread = await findThread(collective, parsed, from.address)
  let isNewThread = false
  if (!thread) {
    isNewThread = true
    const r = await run(`
      INSERT INTO threads (collective_id, subject, status, counterpart_email, counterpart_name, first_message_at, last_message_at, last_direction, created_at, updated_at)
      VALUES (?, ?, 'needs_reply', ?, ?, ?, ?, 'inbound', ?, ?)
    `, [collective.id, parsed.subject?.trim() || '(no subject)', from.address || null, from.name || null, sentAt, sentAt, now(), now()])
    thread = (await getThread(r.lastId))!
  }

  const refs = Array.isArray(parsed.references) ? parsed.references[0] : parsed.references
  const r = await run(`
    INSERT INTO messages (thread_id, rfc822_message_id, in_reply_to, direction, from_email, from_name, to_json, cc_json, body_text, resend_email_id, sent_at, created_at)
    VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    thread.id, msgId, parsed.inReplyTo || refs || null,
    from.address, from.name,
    JSON.stringify(tos.map((t) => t.address)), JSON.stringify(ccs.map((c) => c.address)),
    plainText(parsed).slice(0, 100_000),
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
    await run("UPDATE threads SET last_message_at = ?, last_direction = 'inbound', updated_at = ? WHERE id = ?", [sentAt, now(), thread.id])
  }
  if (thread.status !== 'spam') await setStatus(thread.id, isForwardTest ? 'answered' : 'needs_reply', null, true)

  // Auto-assign new threads based on who handled this sender before
  if (isNewThread && from.address) {
    const suggested = await suggestedAssigneeFor(collective.id, from.address, thread.id)
    if (suggested) await setAssignee((await getThread(thread.id))!, suggested, null, 'auto_sender')
  }

  if (!isAutoSubmitted(parsed) && !isForwardTest) {
    const message = (await get<Message>('SELECT * FROM messages WHERE id = ?', [messageDbId]))!
    // awaited: on serverless, work after the response is returned may be killed
    await notifyInbound(collective, (await getThread(thread.id))!, message, extraActions).catch((err) => console.error('[notify] failed:', err))
  }

  console.log(`[ingest] ${collective.slug}: "${parsed.subject}" → thread ${thread.id}${isNewThread ? ' (new)' : ''}`)
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
