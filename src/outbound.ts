import crypto from 'node:crypto'
import { cfg } from './config.js'
import {
  addEvent, get, getThread, lastInboundMessage, run, setStatus, storeAttachment,
  type Collective, type Member, type Message,
} from './db.js'
import { escapeHtml, now } from './util.js'
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
export async function sendCollectiveReply(
  collective: Collective,
  threadId: number,
  text: string,
  member: Member,
  via: 'web' | 'email',
  attachments: OutAttachment[] = [],
  cc: string[] = [],
  bcc: string[] = [],
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

  let resendEmailId: string | null = null
  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] From: ${fromAddress}\n[outbound:dev] To: ${to}${cc.length ? `\n[outbound:dev] Cc: ${cc.join(', ')}` : ''}\n[outbound:dev] Subject: ${subject}\n${body}\n[outbound:dev] attachments: ${attachments.map((a) => a.filename).join(', ') || 'none'}${hasImages ? ' (images inline)' : ''}\n`)
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
      text: body,
      ...(inline && html ? { html } : {}),
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
    fromAddress, collective.name, JSON.stringify([to]), JSON.stringify(cc), JSON.stringify(bcc),
    body, member.id, resendEmailId, ts, ts,
  ])
  for (const [i, a] of attachments.entries()) await storeAttachment(r.lastId, a.filename, a.contentType, a.content, i)

  await run("UPDATE threads SET last_message_at = ?, last_direction = 'outbound', updated_at = ? WHERE id = ?", [ts, ts, threadId])
  await setStatus(threadId, 'answered', member.id, true)
  await addEvent(threadId, member.id, 'replied', { via })

  return (await get<Message>('SELECT * FROM messages WHERE id = ?', [r.lastId]))!
}

/** Forward one message to someone outside the thread (a colleague, a supplier).
 *  Sent as the collective, quoting the original with its own header, and
 *  recorded on the thread so the collective can see it went out — without
 *  flipping the thread to answered: forwarding isn't replying. */
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
  const when = new Date((message.sent_at || now()) * 1000).toUTCString()
  const quoted = [
    '---------- Forwarded message ----------',
    `From: ${message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email || 'unknown'}`,
    `Date: ${when}`,
    `Subject: ${thread.subject}`,
    `To: ${(JSON.parse(message.to_json || '[]') as string[]).join(', ')}`,
    '',
    message.body_text || '',
  ].join('\n')
  const body = `${note.trim() ? `${note.trim()}\n\n` : ''}${quoted}`
  const subject = /^fwd:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`
  const messageId = `<fwd-${message.id}-${crypto.randomBytes(8).toString('hex')}@${cfg.emailDomain}>`

  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] FORWARD to ${dest}\n[outbound:dev] Subject: ${subject}\n${body}\n`)
  } else {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromHeader, to: [dest], reply_to: [fromAddress], subject, text: body,
        headers: { 'Message-ID': messageId },
      }),
    })
    if (!res.ok) throw new Error(`Could not forward (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  await addEvent(thread.id, member.id, 'forwarded', { to: dest, message_id: message.id })
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
