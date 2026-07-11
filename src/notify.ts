import { cfg } from './config.js'
import {
  activeMembers, all, allCollectives, get, getMember, kvGet, kvSet, messageAttachments,
  type Collective, type Member, type Message, type Thread,
} from './db.js'
import { sendAppEmail } from './appmail.js'
import { escapeHtml, excerpt, fmtDateTime, replyAddress, signToken, waitingFor } from './util.js'

const threadUrl = (c: Collective, id: number) => `${cfg.baseUrl}/inbox/${c.slug}/thread/${id}`
const inboxUrl = (c: Collective) => `${cfg.baseUrl}/inbox/${c.slug}`

/** One-click action link: `actor` (the recipient) assigns `target` to the thread. */
function assignUrl(threadId: number, targetId: number, actorId: number, thenReply = false): string {
  const token = signToken({ a: 'assign', th: threadId, tg: targetId, by: actorId, r: thenReply ? 1 : 0 }, 60 * 60 * 24 * 14)
  return `${cfg.baseUrl}/a/${token}`
}

const btn = (href: string, label: string, solid = true) =>
  `<a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:100px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0;${
    solid ? 'background:#1869f5;color:#ffffff;' : 'border:1.5px solid #d3d6da;color:#0c2d66;'
  }">${label}</a>`

const shell = (title: string, inner: string) => `
<div style="background:#f5f7fa;padding:24px 12px;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#141414">
  <div style="max-width:560px;margin:0 auto">
    <div style="font-size:13px;font-weight:700;color:#0c2d66;margin-bottom:12px">✉ ${escapeHtml(title)}</div>
    <div style="background:#ffffff;border:1px solid #e6e8eb;border-radius:16px;padding:24px">${inner}</div>
    <div style="font-size:11px;color:#8a8f98;margin-top:12px">
      Sent by <a href="${cfg.baseUrl}" style="color:#8a8f98">collective.email</a> · <a href="${cfg.baseUrl}" style="color:#8a8f98">notification settings</a>
    </div>
  </div>
</div>`

// ---------- login code ----------

export async function sendLoginCode(email: string, code: string) {
  const html = shell('collective.email', `
    <p style="margin:0 0 8px;font-size:15px">Your sign-in code:</p>
    <p style="font-family:ui-monospace,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:8px;margin:12px 0;color:#0c2d66">${code}</p>
    <p style="margin:0;font-size:13px;color:#6b7280">Expires in 10 minutes. If you didn't request this, ignore this email.</p>`)
  await sendAppEmail({
    to: email,
    subject: `${code} is your collective.email code`,
    html,
    text: `Your sign-in code: ${code}\nExpires in 10 minutes.`,
  })
}

// ---------- new collective onboarding ----------

export async function sendOnboarding(collective: Collective, adminEmail: string) {
  const addr = `${collective.slug}@${cfg.emailDomain}`
  const html = shell('collective.email', `
    <p style="margin:0 0 8px;font-size:16px"><b>${escapeHtml(collective.name)}</b> is live! 🎉</p>
    <p style="margin:0 0 14px;font-size:14px;color:#4b5563">Your collective's address is ready to receive email:</p>
    <p style="font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700;color:#1869f5;margin:0 0 18px">${escapeHtml(addr)}</p>
    <p style="margin:0 0 14px;font-size:14px;color:#4b5563">Sign in to open the inbox and share an invite link with your people (they each sign in with their own email — no shared passwords).</p>
    ${btn(inboxUrl(collective), 'Open your inbox')}`)
  await sendAppEmail({
    to: adminEmail,
    subject: `${addr} is live 🎉`,
    html,
    text: `${collective.name} is live!\nYour address: ${addr}\nOpen your inbox: ${inboxUrl(collective)}`,
  })
}

// ---------- new inbound message notification ----------

function memberLabel(m: Member) {
  return m.name || m.email.split('@')[0]
}

/** Notify members of a new inbound message.
 *  - level 'every' members get it immediately
 *  - the assignee always gets it, whatever their level
 *  Reply-To is a signed plus-address: replying sends the answer to the
 *  original sender as the collective (and assigns you). */
export async function notifyInbound(collective: Collective, thread: Thread, message: Message) {
  const members = await activeMembers(collective.id)
  const assigneeId = thread.assignee_member_id
  const recipients = members.filter(
    (m) => (m.notify_level === 'every' || m.id === assigneeId) && m.email !== message.from_email?.toLowerCase(),
  )
  if (recipients.length === 0) return

  const senderLabel = message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email || 'unknown sender'
  const assignee = assigneeId ? members.find((m) => m.id === assigneeId) : undefined
  const bodyPreview = (message.body_text || '').slice(0, 4000)
  const atts = await messageAttachments(message.id)
  const attHtml = atts.length
    ? `<p style="margin:0 0 14px;font-size:13px;color:#6b7280">📎 ${atts.map((a) => `<a href="${cfg.baseUrl}/attachment/${a.id}" style="color:#0c2d66">${escapeHtml(a.filename)}</a> (${Math.ceil(a.size / 1024)} KB)`).join(' · ')}</p>`
    : ''
  const attText = atts.length ? `Attachments: ${atts.map((a) => a.filename).join(', ')}\n` : ''

  for (const m of recipients) {
    const others = members.filter((o) => o.id !== m.id)
    const assignOthers = others
      .slice(0, 12)
      .map((o) => `<a href="${assignUrl(thread.id, o.id, m.id)}" style="color:#0c2d66">assign to ${escapeHtml(memberLabel(o))}</a>`)
      .join(' · ')

    const assignLine = assignee
      ? `<p style="margin:0 0 14px;font-size:13px;color:#6b7280">Assigned to <b style="color:#141414">${escapeHtml(memberLabel(assignee))}</b>${assignee.id === m.id ? ' (you)' : ''}.</p>`
      : `<p style="margin:0 0 14px;font-size:13px;color:#b45309"><b>Nobody has this yet.</b></p>`

    const html = shell(collective.name, `
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280">New message to ${escapeHtml(collective.slug)}@${escapeHtml(cfg.emailDomain)}</p>
      <p style="margin:0 0 2px;font-size:16px;font-weight:700;color:#0c2d66">${escapeHtml(thread.subject)}</p>
      <p style="margin:0 0 14px;font-size:13px;color:#6b7280">From ${escapeHtml(senderLabel)} · ${fmtDateTime(message.sent_at)}</p>
      ${assignLine}
      <div style="border:1px solid #e6e8eb;border-radius:12px;padding:14px;font-size:14px;white-space:pre-wrap;margin-bottom:14px">${escapeHtml(bodyPreview)}</div>
      ${attHtml}
      ${btn(assignUrl(thread.id, m.id, m.id, true), 'Assign to me & reply')}
      ${btn(threadUrl(collective, thread.id), 'Open thread', false)}
      <p style="margin:10px 0 0;font-size:13px;color:#6b7280">Or <b>just reply to this email</b> — your answer goes to ${escapeHtml(message.from_email || 'the sender')} as ${escapeHtml(collective.slug)}@${escapeHtml(cfg.emailDomain)} and the thread is assigned to you. If someone answers before you, we'll stop your reply and let you know.</p>
      <p style="margin:10px 0 0;font-size:12px;color:#9aa1ab">${assignOthers}</p>`)

    const text = [
      `New message to ${collective.slug}@${cfg.emailDomain}`,
      `Subject: ${thread.subject}`,
      `From: ${senderLabel}`,
      assignee ? `Assigned to ${memberLabel(assignee)}${assignee.id === m.id ? ' (you)' : ''}` : 'Nobody has this yet.',
      '',
      bodyPreview,
      '',
      attText + `Assign to me & reply: ${assignUrl(thread.id, m.id, m.id, true)}`,
      `Open thread: ${threadUrl(collective, thread.id)}`,
      '',
      `Or just reply to this email — your answer goes to the sender as ${collective.slug}@${cfg.emailDomain} and the thread is assigned to you.`,
    ].join('\n')

    await sendAppEmail({
      to: m.email,
      subject: `[${collective.name}] ${thread.subject}`,
      html,
      text,
      replyTo: replyAddress(collective.slug, thread.id, m.id, message.id),
    })
  }
}

// ---------- collision & confirmation ----------

export async function sendCollisionNotice(collective: Collective, member: Member, thread: Thread, answeredBy: Member | undefined, answeredAt: number | null, draft: string) {
  const who = answeredBy ? memberLabel(answeredBy) : 'Someone'
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px"><b>${escapeHtml(who)} already replied</b> to “${escapeHtml(thread.subject)}” ${answeredAt ? `(${fmtDateTime(answeredAt)})` : ''} — <b>your reply was NOT sent</b>, to avoid answering twice.</p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280">Your draft, in case you still need it:</p>
    <div style="border:1.5px dashed #d3d6da;border-radius:12px;padding:14px;font-size:14px;white-space:pre-wrap;background:#f5f7fa;margin-bottom:18px">${escapeHtml(draft)}</div>
    ${btn(threadUrl(collective, thread.id), 'Open the thread', false)}`)
  await sendAppEmail({
    to: member.email,
    subject: `Not sent — ${who} already replied: ${thread.subject}`,
    html,
    text: `${who} already replied to "${thread.subject}" — your reply was NOT sent.\n\nYour draft:\n${draft}\n\nOpen the thread: ${threadUrl(collective, thread.id)}`,
  })
}

export async function sendReplyFailure(collective: Collective, member: Member, thread: Thread, reason: string, draft: string) {
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px">⚠️ <b>Your reply to “${escapeHtml(thread.subject)}” could not be sent.</b></p>
    <p style="margin:0 0 14px;font-size:13px;color:#6b7280">${escapeHtml(reason)}</p>
    ${draft ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280">Your draft, so nothing is lost:</p>
    <div style="border:1.5px dashed #d3d6da;border-radius:12px;padding:14px;font-size:14px;white-space:pre-wrap;background:#f5f7fa;margin-bottom:18px">${escapeHtml(draft)}</div>` : ''}
    ${btn(threadUrl(collective, thread.id), 'Reply from the app instead', false)}`)
  await sendAppEmail({
    to: member.email,
    subject: `⚠️ Not sent: ${thread.subject}`,
    html,
    text: `Your reply to "${thread.subject}" could not be sent.\nReason: ${reason}\n\n${draft ? `Your draft:\n${draft}\n\n` : ''}Reply from the app: ${threadUrl(collective, thread.id)}`,
  })
}

export async function sendReplyConfirmation(collective: Collective, member: Member, thread: Thread, to: string) {
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px">✓ Your reply to “${escapeHtml(thread.subject)}” was sent to <b>${escapeHtml(to)}</b> as ${escapeHtml(collective.slug)}@${escapeHtml(cfg.emailDomain)}, and the thread is assigned to you.</p>
    ${btn(threadUrl(collective, thread.id), 'Open the thread', false)}`)
  await sendAppEmail({
    to: member.email,
    subject: `Sent ✓ ${thread.subject}`,
    html,
    text: `Your reply to "${thread.subject}" was sent to ${to}.\nOpen the thread: ${threadUrl(collective, thread.id)}`,
  })
}

// ---------- digests ----------

async function sendDigest(collective: Collective, member: Member, threads: Thread[], membersById: Map<number, Member>, period: 'daily' | 'weekly') {
  const parts: string[] = []
  for (const t of threads) {
    const assignee = t.assignee_member_id ? membersById.get(t.assignee_member_id) : undefined
    const lastMsg = await get<{ body_text: string }>(
      "SELECT body_text FROM messages WHERE thread_id = ? AND direction='inbound' ORDER BY sent_at DESC LIMIT 1", [t.id])
    parts.push(`
      <div style="border-top:1px solid #e6e8eb;padding:12px 0">
        <p style="margin:0 0 2px;font-size:14px"><a href="${threadUrl(collective, t.id)}" style="color:#0c2d66;font-weight:700">${escapeHtml(t.subject)}</a></p>
        <p style="margin:0 0 6px;font-size:12px;color:#6b7280">
          ${escapeHtml(t.counterpart_name || t.counterpart_email || '')} · waiting ${waitingFor(t.last_message_at)} ·
          ${assignee ? `assigned to ${escapeHtml(memberLabel(assignee))}` : '<b style="color:#b45309">unassigned</b>'}
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#4b5563">${escapeHtml(excerpt(lastMsg?.body_text || '', 160))}</p>
        <a href="${assignUrl(t.id, member.id, member.id, true)}" style="font-size:12.5px;color:#1869f5;font-weight:600">Assign to me & reply →</a>
      </div>`)
  }

  const html = shell(collective.name, `
    <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#0c2d66">${threads.length} request${threads.length === 1 ? '' : 's'} need${threads.length === 1 ? 's' : ''} a reply</p>
    ${parts.join('')}
    <div style="margin-top:16px">${btn(inboxUrl(collective), 'Open the inbox')}</div>`)

  const text = [
    `[${collective.name}] ${threads.length} request(s) need a reply:`,
    '',
    ...threads.map((t) => `- ${t.subject} (waiting ${waitingFor(t.last_message_at)}) ${threadUrl(collective, t.id)}`),
    '',
    `Open the inbox: ${inboxUrl(collective)}`,
  ].join('\n')

  await sendAppEmail({
    to: member.email,
    subject: `[${collective.name}] ${threads.length} unanswered request${threads.length === 1 ? '' : 's'} — ${period} digest`,
    html,
    text,
  })
}

/** Called by the local interval or the Vercel cron. Sends daily digests at
 *  DIGEST_HOUR (local TZ), weekly digests on Monday. Max one per period per member. */
export async function digestTick() {
  const d = new Date()
  if (d.getHours() !== cfg.digestHour) return
  const nowTs = Math.floor(Date.now() / 1000)

  for (const collective of await allCollectives()) {
    if (collective.status !== 'active') continue
    const threads = await all<Thread>(
      "SELECT * FROM threads WHERE collective_id = ? AND status = 'needs_reply' ORDER BY last_message_at ASC", [collective.id])
    if (threads.length === 0) continue
    const members = await activeMembers(collective.id)
    const membersById = new Map(members.map((m) => [m.id, m]))
    for (const m of members) {
      if (m.notify_level !== 'daily' && m.notify_level !== 'weekly') continue
      if (m.notify_level === 'weekly' && d.getDay() !== 1) continue
      const last = Number((await kvGet(`digest:${m.id}`)) || 0)
      const minGap = m.notify_level === 'daily' ? 20 * 3600 : 6 * 86400
      if (nowTs - last < minGap) continue
      try {
        await sendDigest(collective, m, threads, membersById, m.notify_level)
        await kvSet(`digest:${m.id}`, String(nowTs))
      } catch (err) {
        console.error(`[digest] failed for ${m.email}:`, err)
      }
    }
  }
}
