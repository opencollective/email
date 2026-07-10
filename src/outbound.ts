import crypto from 'node:crypto'
import { cfg } from './config.js'
import {
  addEvent, get, getThread, lastInboundMessage, run, setStatus, storeAttachment,
  type Collective, type Member, type Message,
} from './db.js'
import { now } from './util.js'

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
): Promise<Message> {
  const thread = await getThread(threadId)
  if (!thread || thread.collective_id !== collective.id) throw new Error('Thread not found')
  const lastIn = await lastInboundMessage(threadId)
  const to = thread.counterpart_email || lastIn?.from_email
  if (!to) throw new Error('This thread has no external sender to reply to.')

  let body = text.trim()
  if (!body) throw new Error('Reply is empty.')
  if (cfg.signReplies) body += `\n\n— ${member.name || member.email}, for ${collective.name}`

  const fromAddress = `${collective.slug}@${cfg.emailDomain}`
  const subject = thread.subject.match(/^re:/i) ? thread.subject : `Re: ${thread.subject}`
  const messageId = `<req-${threadId}-${crypto.randomBytes(8).toString('hex')}@${cfg.emailDomain}>`
  const references = [
    ...(lastIn?.in_reply_to ? [lastIn.in_reply_to] : []),
    ...(lastIn?.rfc822_message_id ? [lastIn.rfc822_message_id] : []),
  ]

  let resendEmailId: string | null = null
  if (!cfg.resendKey) {
    console.log(`\n[outbound:dev] From: ${fromAddress}\n[outbound:dev] To: ${to}\n[outbound:dev] Subject: ${subject}\n${body}\n[outbound:dev] attachments: ${attachments.map((a) => a.filename).join(', ') || 'none'}\n`)
  } else {
    const headers: Record<string, string> = { 'Message-ID': messageId }
    if (lastIn?.rfc822_message_id) headers['In-Reply-To'] = lastIn.rfc822_message_id
    if (references.length) headers['References'] = references.join(' ')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${collective.name} <${fromAddress}>`,
        to: [to],
        reply_to: [fromAddress],
        subject,
        text: body,
        headers,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
      }),
    })
    if (!res.ok) {
      const detail = await res.text()
      throw new Error(`Could not send (${res.status}): ${detail.slice(0, 200)}`)
    }
    resendEmailId = ((await res.json()) as { id?: string }).id ?? null
  }

  const ts = now()
  const r = await run(`
    INSERT INTO messages (thread_id, rfc822_message_id, in_reply_to, direction, from_email, from_name, to_json, body_text, sent_by_member_id, resend_email_id, sent_at, created_at)
    VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    threadId, messageId, lastIn?.rfc822_message_id ?? null,
    fromAddress, collective.name, JSON.stringify([to]),
    body, member.id, resendEmailId, ts, ts,
  ])
  for (const [i, a] of attachments.entries()) await storeAttachment(r.lastId, a.filename, a.contentType, a.content, i)

  await run("UPDATE threads SET last_message_at = ?, last_direction = 'outbound', updated_at = ? WHERE id = ?", [ts, ts, threadId])
  await setStatus(threadId, 'answered', member.id, true)
  await addEvent(threadId, member.id, 'replied', { via })

  return (await get<Message>('SELECT * FROM messages WHERE id = ?', [r.lastId]))!
}
