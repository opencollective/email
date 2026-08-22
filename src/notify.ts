import { cfg } from './config.js'
import {
  activeMembers, all, allCollectives, get, getMember, kvGet, kvSet, messageAttachments,
  type Collective, type Member, type Message, type Thread,
} from './db.js'
import { sendAppEmail } from './appmail.js'
import { outboundFrom } from './outbound.js'
import { escapeHtml, excerpt, fmtDateTime, signToken, splitQuotedTail, waitingFor } from './util.js'
import { mintNoteReplyAddress, mintReplyAddress } from './reply-tokens.js'
import { noteParts } from './mentions.js'

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

/** Who a notification appears to come from.
 *
 *  The address always stays on our own sending domain — that is not a choice:
 *  we generate these emails rather than relaying them, so we could never carry
 *  a DKIM signature for gmail.com (or any sender's domain), SPF and DKIM would
 *  both fail alignment, and Gmail would file us as spam. The inbound loop guard
 *  keys on our domain too.
 *
 *  So we do what Google Groups does when it can't keep the original From: put
 *  the person in the display name — "Marie Dupont via Commons Hub" — which is
 *  what makes a list scannable at a glance, and keep authentication intact. */
/** Strip what would break a quoted display name in a From/Reply-To header. */
const clean = (v: string) => v.replace(/["\\<>\n\r]/g, '').trim()

const notifyFrom = (collective: Collective, sender?: { name?: string | null; email?: string | null }) => {
  const who = sender ? clean(sender.name || (sender.email || '').split('@')[0] || '') : ''
  // "via <the address they wrote to>" — the same shape a group uses, and it
  // says which inbox this landed in when someone reads several of them
  const label = who ? `${who} via ${receivingAddress(collective)}` : clean(collective.name)
  return `${label.slice(0, 78)} <${collective.slug}@${cfg.emailDomain}>`
}

/** The address the outside world writes to: the custom one for Pro domains,
 *  otherwise slug@collective.email. */
export const receivingAddress = (c: Collective) =>
  c.custom_domain && c.custom_local ? `${c.custom_local}@${c.custom_domain}` : `${c.slug}@${cfg.emailDomain}`

/** Thread notifications use the full width of the reading pane: a thin header,
 *  the message itself, and a thin footer — no nested cards, no wasted margins.
 *  The client already shows the subject, so the body never repeats it. */
const threadShell = (collective: Collective, inner: string, footerLinks?: string) => `
<div style="font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#141414;background:#ffffff">
  <div style="max-width:720px;margin:0 auto;padding:8px 16px 0">
    ${inner}
    <div style="border-top:1px solid #e6e8eb;margin-top:18px;padding:10px 0 16px;font-size:11px;color:#8a8f98">
      ${footerLinks ? `${footerLinks} · ` : ''}<a href="${inboxUrl(collective)}/notifications" style="color:#8a8f98">notification settings</a> · <a href="${cfg.baseUrl}" style="color:#8a8f98">collective.email</a>
    </div>
  </div>
</div>`

/** Quiet link-buttons for thread notifications — the message is the point,
 *  the actions shouldn't shout. */
const quietBtn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;padding:5px 12px;border:1px solid #d3d6da;border-radius:8px;font-size:12.5px;color:#4e5052;text-decoration:none;margin:0 6px 6px 0">${label}</a>`

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
    ${collective.contribution_offer ? `<p style="margin:0 0 14px;font-size:14px;color:#4b5563">You offered to contribute: <i>“${escapeHtml(collective.contribution_offer)}”</i> — we'll take you up on that 🙂 When it's done (or to talk about it), just reply to this email.</p>` : ''}
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
export async function notifyInbound(
  collective: Collective,
  thread: Thread,
  message: Message,
  extraActions?: { label: string; url: string }[],
  rule?: { tag: string | null },
) {
  const members = await activeMembers(collective.id)
  const assigneeId = thread.assignee_member_id
  // per-member mutes: the collective still receives and stores everything —
  // this only silences the direct notification for members who asked
  const muted = new Set((await all<{ member_id: number }>(
    'SELECT member_id FROM member_mutes WHERE collective_id = ? AND match_from = ?',
    [collective.id, (message.from_email || '').toLowerCase()])).map((r) => r.member_id))
  // Reply-all: anyone the sender addressed directly already has this message
  // in their own inbox. A second copy from us is noise, and it arrives looking
  // like news. They still see it in the app, unread, like everyone else.
  const directlyAddressed = new Set<string>([
    ...(JSON.parse(message.to_json || '[]') as string[]),
    ...(JSON.parse(message.cc_json || '[]') as string[]),
    ...(JSON.parse(message.bcc_json || '[]') as string[]),
  ].map((a) => (a || '').toLowerCase().trim()).filter(Boolean))

  // guests only hear about the threads shared with them
  const guestIds = new Set((await all<{ member_id: number }>(
    'SELECT member_id FROM thread_access WHERE thread_id = ?', [thread.id])).map((r) => r.member_id))
  const recipients = members.filter(
    // agents have synthetic addresses and hear about mail through their own
    // event stream — never through SMTP
    (m) => m.kind !== 'agent' && m.role !== 'reader' && !muted.has(m.id) && (m.notify_level === 'every' || m.id === assigneeId)
      && (m.role !== 'guest' || guestIds.has(m.id))
      && m.email !== message.from_email?.toLowerCase()
      && !directlyAddressed.has(m.email.toLowerCase()),
  )
  if (recipients.length === 0) return

  const senderLabel = message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email || 'unknown sender'
  // What the collective actually receives and sends as — the custom address
  // for Pro domains, slug@ otherwise (outboundFrom degrades until verified).
  const inboundAddr = receivingAddress(collective)
  const { fromAddress: sendAddr } = outboundFrom(collective)
  const assignee = assigneeId ? members.find((m) => m.id === assigneeId) : undefined
  // the quoted tail is noise in a notification — the thread has the history
  const bodyPreview = splitQuotedTail(message.body_text || '').main.slice(0, 4000)
  const atts = await messageAttachments(message.id)
  const attHtml = atts.length
    ? `<p style="margin:0 0 14px;font-size:13px;color:#6b7280">📎 ${atts.map((a) => `<a href="${cfg.baseUrl}/attachment/${a.id}" style="color:#0c2d66">${escapeHtml(a.filename)}</a> (${Math.ceil(a.size / 1024)} KB)`).join(' · ')}</p>`
    : ''
  const attText = atts.length ? `Attachments: ${atts.map((a) => a.filename).join(', ')}\n` : ''

  for (const m of recipients) {
    const others = members.filter((o) => o.id !== m.id && o.role !== 'reader')

    // Live badge: rendered by the server when the email is opened, so it
    // shows the CURRENT state (answered/assigned/unclaimed), never a stale one.
    const badgeToken = signToken({ a: 'aimg', th: thread.id, m: m.id }, 60 * 60 * 24 * 90)
    const assignLine = `<p style="margin:0 0 4px"><a href="${threadUrl(collective, thread.id)}" style="text-decoration:none"><img src="${cfg.baseUrl}/aimg/${badgeToken}" height="30" style="vertical-align:middle;border:0;height:30px;width:auto;max-width:80%" alt="${assignee ? `Assigned to ${escapeHtml(memberLabel(assignee))} when this was sent` : 'Unassigned when this was sent'}"></a> <a href="${threadUrl(collective, thread.id)}" style="font-size:12px;color:#6b7280;vertical-align:middle;margin-left:6px">change →</a></p>`
    const spamUrl = `${cfg.baseUrl}/a/${signToken({ a: 'spam', th: thread.id, by: m.id }, 60 * 60 * 24 * 14)}`
    const noteUrl = `${threadUrl(collective, thread.id)}?pane=note#composer`
    // one-click, member-scoped: only this member stops hearing from this sender
    const muteUrl = message.from_email
      ? `${cfg.baseUrl}/a/${signToken({ a: 'mute', c: collective.id, m: m.id, f: message.from_email.toLowerCase() }, 60 * 60 * 24 * 90)}`
      : null
    const footerLinks = muteUrl
      ? `<a href="${muteUrl}" style="color:#8a8f98">Stop receiving emails from ${escapeHtml(message.from_email!)}</a>`
      : undefined
    const fromLine = `<p style="margin:0 0 2px;font-size:14px"><span style="color:#6b7280">From:</span> <b>${escapeHtml(message.from_name || (message.from_email || 'unknown').split('@')[0])}</b> <span style="color:#6b7280">&lt;${escapeHtml(message.from_email || 'unknown')}&gt;</span></p>`
    const toLine = `<p style="margin:0 0 10px;font-size:13px;color:#6b7280">To: ${escapeHtml(inboundAddr)}</p>`
    const headerBlock = `<div style="border-bottom:1px solid #e6e8eb;padding-bottom:10px;margin-bottom:14px">${fromLine}${toLine}${assignLine}</div>`

    // Rule-filed mail (newsletters, updates): forward the real HTML (already
    // sanitized at ingest) instead of a text preview, and drop the reply /
    // assignment machinery — it's filed, nobody needs to answer it.
    const bodyBlock = rule && message.body_html
      ? `<div style="margin:14px 0">${message.body_html}</div>`
      : `<div style="margin:14px 0;font-size:15px;line-height:1.55;white-space:pre-wrap">${escapeHtml(bodyPreview)}</div>`

    const html = rule
      ? threadShell(collective, `
      <div style="border-bottom:1px solid #e6e8eb;padding-bottom:10px;margin-bottom:14px">
        ${fromLine}${toLine}
        <p style="margin:0;font-size:12px;color:#6b7280">Filed${rule.tag ? ` as <b>#${escapeHtml(rule.tag)}</b>` : ''} — no reply needed</p>
      </div>
      ${bodyBlock}
      ${attHtml}
      ${quietBtn(threadUrl(collective, thread.id), 'Open thread')}
      <p style="margin:14px 0 0;font-size:12px;color:#9aa1ab"><a href="${noteUrl}" style="color:#6b7280">Add a private note</a> · <a href="${spamUrl}" style="color:#6b7280">Mark as spam</a></p>`, footerLinks)
      : threadShell(collective, `
      ${headerBlock}
      ${bodyBlock}
      ${attHtml}
      <p style="margin:0 0 10px;font-size:13px;color:#6b7280"><b style="color:#141414">Just reply to this email</b> to answer ${escapeHtml(message.from_email || 'the sender')} as ${escapeHtml(sendAddr)}${assignee?.id === m.id ? '' : ' — the thread is assigned to you'}. If a teammate answers first, we stop your reply and tell you.</p>
      ${(extraActions || []).map((x) => quietBtn(x.url, x.label)).join('')}
      ${assignee?.id === m.id ? '' : quietBtn(assignUrl(thread.id, m.id, m.id, true), 'Assign to me — answer later')}
      ${quietBtn(threadUrl(collective, thread.id), 'Open thread')}
      ${others.length ? others.slice(0, 12).map((o) => quietBtn(assignUrl(thread.id, o.id, m.id), `→ ${escapeHtml(memberLabel(o))}`)).join('') : ''}
      <p style="margin:10px 0 0;font-size:12px;color:#9aa1ab"><a href="${noteUrl}" style="color:#6b7280">Add a private note</a> · <a href="${spamUrl}" style="color:#6b7280">Mark as spam</a></p>`, footerLinks)

    const text = rule ? [
      `Filed${rule.tag ? ` as #${rule.tag}` : ''} — no reply needed (to ${inboundAddr})`,
      `Subject: ${thread.subject}`,
      `From: ${senderLabel}`,
      '',
      bodyPreview,
      '',
      attText + `Open thread: ${threadUrl(collective, thread.id)}`,
    ].join('\n') : [
      `New message to ${inboundAddr}`,
      `Subject: ${thread.subject}`,
      `From: ${senderLabel}`,
      assignee ? `Assigned to ${memberLabel(assignee)}${assignee.id === m.id ? ' (you)' : ''}` : 'Nobody has this yet.',
      '',
      bodyPreview,
      '',
      attText + `Assign to me & reply: ${assignUrl(thread.id, m.id, m.id, true)}`,
      `Open thread: ${threadUrl(collective, thread.id)}`,
      '',
      `Or just reply to this email — your answer goes to the sender as ${sendAddr} and the thread is assigned to you.`,
    ].join('\n')

    await sendAppEmail({
      to: m.email,
      // the collective is the From now, so the subject needn't repeat its name
      subject: thread.subject,
      html,
      text,
      from: notifyFrom(collective, { name: message.from_name, email: message.from_email }),
      // the compose window then shows "Rūta … via hello@… " instead of a token
      replyTo: `${notifyFrom(collective, { name: message.from_name, email: message.from_email }).split(' <')[0]} <${await mintReplyAddress(collective.slug, message.from_email, thread.id, m.id, message.id)}>`,
    })
  }
}

// ---------- @mention in an internal note ----------

/** Someone was named in an internal note — tell them now.
 *
 *  A mention is addressed at a person, so it ignores notify_level: choosing the
 *  daily digest means "don't tell me about every email", not "don't tell me when
 *  a teammate asks me a question". Readers get it too — they can open the thread
 *  even if they can't answer in it.
 *
 *  Reply-To is a note-kind token, so answering by email files another internal
 *  note (opening with @author, which notifies them back) instead of mailing the
 *  outside sender. The distinction is enforced in the token row, not in the
 *  wording: there is no path from this address to the customer's inbox. */
export async function notifyMention(
  collective: Collective,
  thread: Thread,
  author: Member,
  mentioned: Member[],
  noteBody: string,
) {
  const url = threadUrl(collective, thread.id)
  const authorName = memberLabel(author)
  const counterpart = thread.counterpart_name || thread.counterpart_email || 'the sender'
  const roster = await activeMembers(collective.id)

  for (const m of mentioned.filter((x) => x.kind !== 'agent')) {
    // the note as written, with the handles picked out — and the reader's own
    // name standing out, so a long note shows at a glance where they come in
    const bodyHtml = noteParts(noteBody, roster).map((p) =>
      'mention' in p
        ? `<b style="color:${p.member.id === m.id ? '#0c2d66' : '#1869f5'};${p.member.id === m.id ? 'background:#e4edfd;border-radius:4px;padding:0 3px' : ''}">${escapeHtml(p.mention)}</b>`
        : escapeHtml(p.text)).join('')
    const others = mentioned.filter((o) => o.id !== m.id)
    const alsoLine = others.length
      ? `<p style="margin:0 0 10px;font-size:12px;color:#6b7280">Also mentioned: ${others.map((o) => escapeHtml(memberLabel(o))).join(', ')}</p>`
      : ''
    const html = threadShell(collective, `
      <div style="border-bottom:1px solid #e6e8eb;padding-bottom:10px;margin-bottom:14px">
        <p style="margin:0;font-size:14px;line-height:1.5"><b>${escapeHtml(authorName)}</b> mentioned you in an internal note about <a href="${url}" style="color:#0c2d66;font-weight:600">${escapeHtml(thread.subject)}</a> from ${escapeHtml(counterpart)}.</p>
      </div>
      <div style="border-left:3px dashed #d3d6da;padding-left:14px;margin:14px 0;font-size:15px;line-height:1.55;white-space:pre-wrap">${bodyHtml}</div>
      ${alsoLine}
      <p style="margin:0 0 12px;font-size:13px;color:#6b7280"><b style="color:#141414">Just reply to this email</b> to answer ${escapeHtml(authorName)}. Your reply is added to this thread as another internal note — only members of ${escapeHtml(collective.name)} can see it, and ${escapeHtml(counterpart)} never does.</p>
      ${quietBtn(url, 'Open thread')}`)

    const text = [
      `${authorName} mentioned you in an internal note about "${thread.subject}" from ${counterpart}.`,
      '',
      noteBody,
      '',
      others.length ? `Also mentioned: ${others.map(memberLabel).join(', ')}` : '',
      `Just reply to this email to answer ${authorName} — your reply is added to the thread as another internal note, visible only to members of ${collective.name}. ${counterpart} never sees it.`,
      '',
      `Open thread: ${url}`,
    ].filter(Boolean).join('\n')

    await sendAppEmail({
      to: m.email,
      subject: `${authorName} mentioned you — ${thread.subject}`,
      html,
      text,
      from: notifyFrom(collective, { name: author.name, email: author.email }),
      // a note-kind address: replying files an internal note, and cannot reach
      // the outside sender even by accident
      replyTo: `${clean(`${authorName} · internal note`)} <${await mintNoteReplyAddress(collective.slug, thread.id, m.id, author.id)}>`,
    })
  }
}

// ---------- collision & confirmation ----------

export async function sendCollisionNotice(
  collective: Collective, member: Member, thread: Thread,
  answeredBy: Member | undefined, answeredAt: number | null,
  draft: string, theirReply = '', holdKey = '',
) {
  const who = answeredBy ? memberLabel(answeredBy) : 'Someone'
  // The override link carries the held reply, so the person who wrote it can
  // send it unchanged or edit it first. Held replies keep for 30 days.
  const reviewUrl = holdKey ? `${cfg.baseUrl}/a/${signToken({ a: 'held', k: holdKey }, 60 * 60 * 24 * 30)}` : ''
  const quote = (text: string) => `<div style="border:1.5px dashed #d3d6da;border-radius:12px;padding:14px;font-size:14px;white-space:pre-wrap;background:#f5f7fa;margin-bottom:18px">${escapeHtml(text)}</div>`
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px"><b>${escapeHtml(who)} already replied</b> to “${escapeHtml(thread.subject)}” ${answeredAt ? `(${fmtDateTime(answeredAt)})` : ''} — <b>your reply was not sent</b>, in case you were both answering the same message.</p>
    ${theirReply ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280">What ${escapeHtml(who)} sent:</p>${quote(splitQuotedTail(theirReply).main.slice(0, 4000))}` : ''}
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280">What you wrote:</p>
    ${quote(draft)}
    ${reviewUrl ? `${btn(reviewUrl, 'Send my reply anyway', true)}
      <p style="margin:10px 0 0;font-size:13px"><a href="${reviewUrl}" style="color:#1869f5">Edit my reply first →</a></p>`
      : btn(threadUrl(collective, thread.id), 'Open the thread', false)}`)
  await sendAppEmail({
    to: member.email,
    subject: `Not sent — ${who} already replied: ${thread.subject}`,
    from: notifyFrom(collective),
    html,
    text: `${who} already replied to "${thread.subject}" — your reply was not sent, in case you were both answering the same message.\n\n${theirReply ? `What ${who} sent:\n${splitQuotedTail(theirReply).main.slice(0, 4000)}\n\n` : ''}What you wrote:\n${draft}\n\n${reviewUrl ? `Send it anyway (or edit it first): ${reviewUrl}` : `Open the thread: ${threadUrl(collective, thread.id)}`}`,
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
    from: notifyFrom(collective),
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
    from: notifyFrom(collective),
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
        ${member.role === 'reader'
          ? `<a href="${threadUrl(collective, t.id)}" style="font-size:12.5px;color:#1869f5;font-weight:600">Open thread →</a>`
          : `<a href="${assignUrl(t.id, member.id, member.id, true)}" style="font-size:12.5px;color:#1869f5;font-weight:600">Assign to me & reply →</a>`}
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
    subject: `${threads.length} unanswered request${threads.length === 1 ? '' : 's'} — ${period} digest`,
    from: notifyFrom(collective),
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


// ---------- credit emails ----------

export async function sendCreditEmail(collective: Collective, admins: Member[], subject: string, message: string) {
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px">${escapeHtml(message)}</p>
    ${btn(`${cfg.baseUrl}/inbox/${collective.slug}/billing`, 'See balance & ways to earn', false)}`)
  for (const a of admins) {
    await sendAppEmail({ to: a.email, subject, html, text: `${message}\n\n${cfg.baseUrl}/inbox/${collective.slug}/billing` })
  }
}

// ---------- trial lifecycle emails ----------

import { billingState, trialDaysLeft } from './billing.js'

async function sendTrialEmail(collective: Collective, admins: Member[], subject: string, message: string) {
  const html = shell(collective.name, `
    <p style="margin:0 0 8px;font-size:15px">${escapeHtml(message)}</p>
    <p style="margin:0 0 14px;font-size:13px;color:#6b7280">Your community keeps reading for free — subscribing keeps replies flowing from ${escapeHtml(collective.slug)}@${escapeHtml(cfg.emailDomain)}.</p>
    ${btn(`${cfg.baseUrl}/inbox/${collective.slug}/billing`, 'Open Billing')}`)
  for (const a of admins) {
    await sendAppEmail({ to: a.email, subject, html, text: `${message}\n\nBilling: ${cfg.baseUrl}/inbox/${collective.slug}/billing` })
  }
}

/** Called hourly by the cron. Reminds admins at 15 and 5 days before the trial
 *  ends, and once more when the inbox goes read-only. */
export async function trialTick() {
  for (const collective of await allCollectives()) {
    if (collective.status !== 'active') continue
    const state = billingState(collective)
    if (state !== 'trial' && state !== 'grace') continue
    const days = trialDaysLeft(collective)
    const milestone = state === 'grace' ? 'grace' : days !== null && days <= 5 ? '5' : days !== null && days <= 15 ? '15' : null
    if (!milestone) continue
    const key = `trialmail:${collective.id}:${milestone}`
    if (await kvGet(key)) continue
    const admins = (await activeMembers(collective.id)).filter((m) => m.role === 'admin')
    if (admins.length === 0) continue
    try {
      if (milestone === 'grace') {
        await sendTrialEmail(collective, admins, `${collective.name}: trial ended — inbox is now read-only`,
          `The free trial of ${collective.name} has ended. Incoming email still arrives and nothing is lost, but nobody can reply until you subscribe. After 30 days the address stops receiving.`)
      } else {
        await sendTrialEmail(collective, admins, `${collective.name}: ${days} days left in your free trial`,
          `Your free trial of ${collective.name} ends in ${days} day${days === 1 ? '' : 's'}. Subscribe for €10/month (or €100/year) to keep replying as ${collective.slug}@${cfg.emailDomain}.`)
      }
      await kvSet(key, String(Math.floor(Date.now() / 1000)))
    } catch (err) {
      console.error(`[trial] reminder failed for ${collective.slug}:`, err)
    }
  }
}
