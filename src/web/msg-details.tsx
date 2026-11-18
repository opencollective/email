/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import type { Member, Message } from '../db.js'
import type { MessageEvent } from '../deliveries.js'
import { recipientsOf } from '../deliveries.js'
import { fmtDateTime, relTime } from '../util.js'

const list = (j: string | null | undefined): string[] => {
  try { return (JSON.parse(j || '[]') as string[]).filter(Boolean) } catch { return [] }
}

/** What became of an email we sent, in words. Nothing at all for mail we
 *  received, or for an email we have no word on yet. */
export const DeliveryInfo: FC<{ msg: Message; events: MessageEvent[]; names?: Map<string, string> }> = ({ msg, events, names }) => {
  if (msg.direction !== 'outbound' || !msg.sent_at) return null
  const by = (t: string) => events.find((e) => e.type === t)
  const when = (e: MessageEvent, which: 'first' | 'last' = 'first') =>
    e.detail === 'checked' ? '' : ` · ${relTime(which === 'first' ? e.first_at : e.last_at)}`
  const rcpts = recipientsOf(msg)
  const label = (a: string) => names?.get(a.toLowerCase()) || a
  const bounced = by('bounced'), complained = by('complained'), delivered = by('delivered'), opened = by('opened'), delayed = by('delivery_delayed')
  const lines: { cls: string; text: string; title?: string }[] = []
  if (bounced) lines.push({
    cls: 'dlv-bad',
    text: `Bounced${bounced.recipients ? ` for ${bounced.recipients.split(',').map(label).join(', ')}` : ''}${when(bounced)}`,
    title: bounced.detail && bounced.detail !== 'checked' ? bounced.detail : undefined,
  })
  if (complained) lines.push({ cls: 'dlv-bad', text: `Marked as spam by a recipient${when(complained)}` })
  if (delivered && !bounced) lines.push({ cls: 'dlv-ok', text: `Delivered${when(delivered)}` })
  else if (delivered) lines.push({ cls: 'dlv-ok', text: `Delivered to the others${when(delivered)}` })
  if (opened) lines.push({
    cls: 'dlv-ok',
    text: `Opened ${rcpts.length === 1 ? `by ${label(rcpts[0])}` : `by at least one of the ${rcpts.length} recipients`}${when(opened, 'last')}`,
    title: 'Their mail app loaded the invisible image in our email. We keep only that it happened and when. Apple Mail can load it without anyone reading; apps that block images never report it. With several recipients there is one image for all, so we cannot tell who.',
  })
  if (!delivered && !bounced && delayed) lines.push({ cls: 'dlv-warn', text: `Delayed: the receiving server hasn't accepted it yet${when(delayed, 'last')}` })
  if (!lines.length) return null
  return (
    <span class="dlv">
      {lines.map((l) => <span class={`dlv-line ${l.cls}`} title={l.title}>{l.text}</span>)}
    </span>
  )
}

/** The card behind a message's "sent by … · date": who sent it, from which
 *  address, to whom, when, and what became of it — enough to verify. */
export const MsgDetails: FC<{
  msg: Message
  fromName: string
  fromAddr: string
  sender?: Member
  showBcc: boolean
  events: MessageEvent[]
  names: Map<string, string>
  deliveryUrl?: string
}> = ({ msg, fromName, fromAddr, sender, showBcc, events, names, deliveryUrl }) => {
  const label = (a: string) => {
    const n = names.get(a.toLowerCase())
    return n && n !== a ? `${n} <${a}>` : a
  }
  const row = (k: string, v: string | string[]) => {
    const vals = Array.isArray(v) ? v : [v]
    if (!vals.length || !vals[0]) return null
    return (
      <div class="md-row">
        <span class="md-k">{k}</span>
        <span class="md-v">{vals.map((x) => <span class="md-addr">{x}</span>)}</span>
      </div>
    )
  }
  const outbound = msg.direction === 'outbound'
  return (
    <div class="meta-card" role="tooltip">
      {row('From', fromAddr ? (fromName && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr) : fromName)}
      {outbound && sender ? row(msg.sent_at ? 'Sent by' : 'Written by', `${sender.name || sender.email} <${sender.email}>`) : null}
      {row('To', list(msg.to_json).map(label))}
      {row('Cc', list(msg.cc_json).map(label))}
      {showBcc ? row('Bcc', list(msg.bcc_json).map(label)) : null}
      {row(outbound ? (msg.sent_at ? 'Sent' : 'Draft') : 'Received', msg.sent_at ? fmtDateTime(msg.sent_at) : fmtDateTime(msg.created_at))}
      {msg.rfc822_message_id ? row('Message-ID', msg.rfc822_message_id) : null}
      {outbound && msg.sent_at ? (
        <div class="md-row">
          <span class="md-k">Delivery</span>
          <span class="md-v" data-dlv={deliveryUrl || undefined}>
            {DeliveryInfo({ msg, events, names }) ?? <span class="dlv-line">{deliveryUrl && msg.resend_email_id ? 'Checking…' : 'No report yet'}</span>}
          </span>
        </div>
      ) : null}
    </div>
  )
}
