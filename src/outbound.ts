import crypto from 'node:crypto'
import { cfg } from './config.js'
import {
  addEvent, all, get, getThread, lastInboundMessage, messageAttachments, run, setStatus, storeAttachment,
  type Collective, type Member, type Message,
} from './db.js'
import { readBlob } from './storage.js'
import { escapeHtml, now, splitQuotedTail } from './util.js'
import { assertCanSend, assertRecipientCap } from './billing.js'

/** Who a reply goes out as. Verified Pro domains send as the custom address;
 *  a configured-but-unverified domain degrades to slug@ with the custom
 *  address in the display name (honest, deliverable, no DMARC spoofing). */
export function outboundFrom(collective: Collective): { fromAddress: string; fromHeader: string } {
  const custom = collective.plan === 'pro' && collective.custom_domain && collective.custom_local
  if (custom && collective.domain_status === 'verified') {
    const addr = `${collective.custom_local}@${collective.custom_domain}`
    return { fromAddress: addr, fromHeader: `${collective.name} <${addr}>` }
  }
  const addr = `${collective.slug}@${cfg.emailDomain}`
  const name = custom ? `${collective.name} · ${collective.custom_local}@${collective.custom_domain}` : collective.name
  return { fromAddress: addr, fromHeader: `${name} <${addr}>` }
}

/** The sign-off appended to replies. The web composer pre-fills it into the
 *  textarea so it can be edited or removed before sending — which is why the
 *  send path only appends it when it isn't already there. */
export const signatureFor = (collective: Collective, member: Member) =>
  `— ${member.name || member.email}, for ${collective.name}`

export interface OutAttachment {
  filename: string
  contentType: string
  content: Buffer
}

/** Send a reply from <slug>@collective.email to the thread's counterpart via Resend,
 *  record it as an outbound message and flip the thread to answered. */
/** The quoted tail, for HTML bodies: same text, muted, left-ruled. */
const quotedHtml = (history: string) => history
  ? `<blockquote style="margin:16px 0 0;padding-left:12px;border-left:2px solid #d5d7da;color:#6b7280;white-space:pre-wrap;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px">${escapeHtml(history.trim())}</blockquote>`
  : ''

export async function sendCollectiveReply(
  collective: Collective,
  threadId: number,
  text: string,
  member: Member,
  via: 'web' | 'email',
  attachments: OutAttachment[] = [],
  cc: string[] = [],
  bcc: string[] = [],
  /** People already holding a copy — a member's own Cc from their mail client.
   *  Stored on the message so the archive is honest about who is in the
   *  conversation, deliberately NOT sent to: they were served by Gmail. */
  alreadyCopied: string[] = [],
): Promise<Message> {
  const thread = await getThread(threadId)
  if (!thread || thread.collective_id !== collective.id) throw new Error('Thread not found')
  await assertCanSend(collective)
  const lastIn = await lastInboundMessage(threadId)
  const to = thread.counterpart_email || lastIn?.from_email
  if (!to) throw new Error('This thread has no external sender to reply to.')
  assertRecipientCap(collective, 1 + cc.length + bcc.length)

  let body = text.trim()
  if (!body && attachments.length === 0) throw new Error('Reply is empty.')
  const signature = signatureFor(collective, member)
  // never sign twice: the composer usually sends the signature inside the body
  if (cfg.signReplies && !body.includes(signature)) body += `${body ? '\n\n' : ''}${signature}`

  const { fromAddress, fromHeader } = outboundFrom(collective)
  const subject = thread.subject.match(/^re:/i) ? thread.subject : `Re: ${thread.subject}`
  const messageId = `<req-${threadId}-${crypto.randomBytes(8).toString('hex')}@${cfg.emailDomain}>`
  const references = [
    ...(lastIn?.in_reply_to ? [lastIn.in_reply_to] : []),
    ...(lastIn?.rfc822_message_id ? [lastIn.rfc822_message_id] : []),
  ]

  // Image attachments are embedded inline in an HTML body (cid references),
  // so recipients see the pictures in the email itself.
  const hasImages = attachments.some((a) => a.contentType.startsWith('image/'))
  const html = hasImages
    ? `<div style="white-space:pre-wrap;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px">${escapeHtml(body)}</div>` +
      attachments.map((a, i) => a.contentType.startsWith('image/')
        ? `<p style="margin:14px 0 0"><img src="cid:att${i}" alt="${escapeHtml(a.filename)}" style="max-width:100%;border-radius:8px"></p>`
        : '').join('')
    : undefined

  // The email carries the quoted conversation underneath, the way any mail
  // client's reply would — the recipient reads their own request at the
  // bottom instead of an answer floating free. The STORED body stays clean:
  // the thread view is the history, it doesn't need a copy quoted back.
  const history = await threadHistory(threadId, { id: 0, ts: now() }, collective.name)
  const wireText = `${body}${history}`

  let resendEmailId: string | null = null
  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] From: ${fromAddress}\n[outbound:dev] To: ${to}${cc.length ? `\n[outbound:dev] Cc: ${cc.join(', ')}` : ''}\n[outbound:dev] Subject: ${subject}\n${wireText}\n[outbound:dev] attachments: ${attachments.map((a) => a.filename).join(', ') || 'none'}${hasImages ? ' (images inline)' : ''}\n`)
  } else {
    const headers: Record<string, string> = { 'Message-ID': messageId }
    if (lastIn?.rfc822_message_id) headers['In-Reply-To'] = lastIn.rfc822_message_id
    if (references.length) headers['References'] = references.join(' ')
    const payload = (inline: boolean) => JSON.stringify({
      from: fromHeader,
      to: [to],
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      reply_to: [fromAddress],
      subject,
      text: wireText,
      ...(inline && html ? { html: html + quotedHtml(history) } : {}),
      headers,
      attachments: attachments.map((a, i) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        ...(inline && a.contentType.startsWith('image/') ? { content_id: `att${i}` } : {}),
      })),
    })
    const send = (inline: boolean) => fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: payload(inline),
    })
    let res = await send(true)
    if (!res.ok && hasImages && res.status < 500) {
      // inline embedding rejected — fall back to plain attachments
      res = await send(false)
    }
    if (!res.ok) {
      const detail = await res.text()
      throw new Error(`Could not send (${res.status}): ${detail.slice(0, 200)}`)
    }
    resendEmailId = ((await res.json()) as { id?: string }).id ?? null
  }

  const ts = now()
  const r = await run(`
    INSERT INTO messages (thread_id, rfc822_message_id, in_reply_to, direction, from_email, from_name, to_json, cc_json, bcc_json, body_text, sent_by_member_id, resend_email_id, sent_at, created_at)
    VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    threadId, messageId, lastIn?.rfc822_message_id ?? null,
    fromAddress, collective.name, JSON.stringify([to]),
    // what the record must show: everyone holding this message, however it reached them
    JSON.stringify([...new Set([...cc, ...alreadyCopied])]), JSON.stringify(bcc),
    body, member.id, resendEmailId, ts, ts,
  ])
  for (const [i, a] of attachments.entries()) await storeAttachment(r.lastId, a.filename, a.contentType, a.content, i)

  await run("UPDATE threads SET last_message_at = ?, last_direction = 'outbound', updated_at = ? WHERE id = ?", [ts, ts, threadId])
  await setStatus(threadId, 'answered', member.id, true)
  await addEvent(threadId, member.id, 'replied', { via })
  // any proposed drafts are settled the moment a real reply goes out
  await run('DELETE FROM thread_drafts WHERE thread_id = ?', [threadId]).catch(() => {})

  return (await get<Message>('SELECT * FROM messages WHERE id = ?', [r.lastId]))!
}

/** Forward one message to someone outside the thread (a colleague, a supplier).
 *  Sent as the collective, quoting the original with its own header, and
 *  recorded on the thread so the collective can see it went out — without
 *  flipping the thread to answered: forwarding isn't replying. */
/** What came before the forwarded message, quoted underneath it so the
 *  recipient can read the conversation instead of one page of it.
 *
 *  Sent messages only — internal notes stay internal, which is the whole
 *  point of them. Each body is stripped of the history its own sender quoted
 *  (we are rebuilding that chain ourselves, and nesting it would repeat the
 *  same text once per hop). Oldest messages are dropped rather than sending
 *  a megabyte of mail; the recipient is told when that happens. */
const HISTORY_MAX = 12
const HISTORY_CHARS = 60000

async function threadHistory(threadId: number, before: { id: number; ts: number }, collectiveName: string): Promise<string> {
  const earlier = await all<Message>(
    'SELECT * FROM messages WHERE thread_id = ? AND id != ? AND (sent_at IS NOT NULL OR direction = ?) AND COALESCE(sent_at, created_at) <= ? ORDER BY COALESCE(sent_at, created_at) DESC, id DESC',
    [threadId, before.id, 'inbound', before.ts])
  if (!earlier.length) return ''

  const kept = earlier.slice(0, HISTORY_MAX)
  const blocks: string[] = []
  let budget = HISTORY_CHARS
  let dropped = earlier.length - kept.length

  for (const m of kept) {
    const main = splitQuotedTail(m.body_text || '').main.trim()
    const name = m.from_name || (m.direction === 'outbound' ? collectiveName : '') || m.from_email || 'someone'
    const attribution = `On ${new Date(((m.sent_at || m.created_at) as number) * 1000).toUTCString()}, ${name} wrote:`
    const block = `${attribution}\n${main.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}`
    if (block.length > budget) { dropped++; continue }
    budget -= block.length
    blocks.push(block)
  }
  if (!blocks.length) return ''
  const tail = dropped > 0
    ? `\n\n[${dropped} earlier message${dropped === 1 ? '' : 's'} not included — open the thread for the full history.]`
    : ''
  return `\n\n${blocks.join('\n\n')}${tail}`
}

/** Load a message's stored attachments as sendable buffers.
 *  A blob that has gone missing must not sink the send: the text is still
 *  worth delivering, and the recipient can be told what didn't come along. */
export async function gatherAttachments(messageId: number): Promise<{
  files: { filename: string; content: Buffer }[]; missing: string[]
}> {
  const files: { filename: string; content: Buffer }[] = []
  const missing: string[] = []
  for (const a of await messageAttachments(messageId)) {
    const content = a.path ? await readBlob(a.path).catch(() => null) : null
    if (content) files.push({ filename: a.filename, content })
    else missing.push(a.filename)
  }
  return { files, missing }
}

export async function forwardMessage(
  collective: Collective,
  message: Message,
  to: string,
  note: string,
  member: Member,
): Promise<void> {
  const thread = await getThread(message.thread_id)
  if (!thread || thread.collective_id !== collective.id) throw new Error('Thread not found')
  await assertCanSend(collective)
  const dest = to.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) throw new Error('That email address doesn\'t look right.')

  const { fromAddress, fromHeader } = outboundFrom(collective)
  // outbound rows carry the address but not always a display name
  const label = (m: Message) => m.from_name || (m.direction === 'outbound' ? collective.name : '') || m.from_email || 'unknown'
  const who = (m: Message) => m.from_email ? `${label(m)} <${m.from_email}>` : label(m)
  const stamp = (m: Message) => new Date(((m.sent_at || m.created_at) as number) * 1000).toUTCString()
  const history = await threadHistory(thread.id, { id: message.id, ts: (message.sent_at || message.created_at) as number }, collective.name)
  // when we rebuild the chain below, the sender's own quoted tail is the same
  // text a second time — keep it only when there is no history to replace it
  const forwardedBody = history
    ? (splitQuotedTail(message.body_text || '').main || message.body_text || '')
    : (message.body_text || '')
  const quoted = [
    '---------- Forwarded message ----------',
    `From: ${who(message)}`,
    `Date: ${stamp(message)}`,
    `Subject: ${thread.subject}`,
    `To: ${(JSON.parse(message.to_json || '[]') as string[]).join(', ') || `${collective.slug}@${cfg.emailDomain}`}`,
    '',
    forwardedBody,
  ].join('\n')
  const body = `${note.trim() ? `${note.trim()}\n\n` : ''}${quoted}${history}`
  const subject = /^fwd:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`
  const messageId = `<fwd-${message.id}-${crypto.randomBytes(8).toString('hex')}@${cfg.emailDomain}>`

  const { files, missing } = await gatherAttachments(message.id)
  const outBody = missing.length
    ? `${body}\n\n[Could not attach: ${missing.join(', ')} — open the thread to download.]`
    : body

  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] FORWARD to ${dest}\n[outbound:dev] Subject: ${subject}\n${outBody}\n[outbound:dev] attachments: ${files.map((f) => f.filename).join(', ') || 'none'}\n`)
  } else {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromHeader, to: [dest], reply_to: [fromAddress], subject, text: outBody,
        headers: { 'Message-ID': messageId },
        attachments: files.map((f) => ({ filename: f.filename, content: f.content.toString('base64') })),
      }),
    })
    if (!res.ok) throw new Error(`Could not forward (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  // the log has to name WHICH message: a long thread has many
  await addEvent(thread.id, member.id, 'forwarded', {
    to: dest,
    message_id: message.id,
    from: message.from_name || message.from_email || null,
    at: message.sent_at || message.created_at || null,
    files: files.length,
  })
}

/** Send a composed draft: a fresh outbound thread the collective started,
 *  rather than an answer to something received. The draft row already holds
 *  to/cc/bcc/body; this stamps it sent — so a failed send leaves the draft
 *  intact, and nothing is ever half-recorded. */
export async function sendComposed(collective: Collective, threadId: number, member: Member): Promise<Message> {
  const thread = await getThread(threadId)
  if (!thread || thread.collective_id !== collective.id) throw new Error('Thread not found')
  const draft = await get<Message>(
    "SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' AND sent_at IS NULL ORDER BY id LIMIT 1", [threadId])
  if (!draft) throw new Error('Nothing to send — this thread has no draft.')
  await assertCanSend(collective)

  const to = (JSON.parse(draft.to_json || '[]') as string[]).filter(Boolean)
  const cc = (JSON.parse(draft.cc_json || '[]') as string[]).filter(Boolean)
  const bcc = (JSON.parse(draft.bcc_json || '[]') as string[]).filter(Boolean)
  if (to.length === 0) throw new Error('Add at least one recipient before sending.')
  assertRecipientCap(collective, to.length + cc.length + bcc.length)

  let body = (draft.body_text || '').trim()
  if (!body) throw new Error('The draft is empty.')
  const signature = signatureFor(collective, member)
  if (cfg.signReplies && !body.includes(signature)) body += `\n\n${signature}`

  const { fromAddress, fromHeader } = outboundFrom(collective)
  const messageId = `<req-${threadId}-${crypto.randomBytes(8).toString('hex')}@${cfg.emailDomain}>`

  let resendEmailId: string | null = null
  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] From: ${fromAddress}\n[outbound:dev] To: ${to.join(', ')}${cc.length ? `\n[outbound:dev] Cc: ${cc.join(', ')}` : ''}${bcc.length ? `\n[outbound:dev] Bcc: ${bcc.join(', ')}` : ''}\n[outbound:dev] Subject: ${thread.subject}\n${body}\n`)
  } else {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromHeader,
        to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        reply_to: [fromAddress],
        subject: thread.subject,
        text: body,
        headers: { 'Message-ID': messageId },
      }),
    })
    if (!res.ok) throw new Error(`Could not send (${res.status}): ${(await res.text()).slice(0, 200)}`)
    resendEmailId = ((await res.json()) as { id?: string }).id ?? null
  }

  const ts = now()
  await run(
    'UPDATE messages SET rfc822_message_id = ?, body_text = ?, resend_email_id = ?, sent_at = ? WHERE id = ?',
    [messageId, body, resendEmailId, ts, draft.id])
  await run(
    "UPDATE threads SET counterpart_email = ?, last_message_at = ?, last_direction = 'outbound', updated_at = ? WHERE id = ?",
    [to[0], ts, ts, threadId])
  await setStatus(threadId, 'answered', member.id, true)
  await addEvent(threadId, member.id, 'replied', { via: 'web' })
  return (await get<Message>('SELECT * FROM messages WHERE id = ?', [draft.id]))!
}
