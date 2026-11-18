import { cfg } from './config.js'
import { all, get, run, type Message } from './db.js'
import { now } from './util.js'

/** What happened to an email after Resend took it.
 *
 *  Two sources: Resend's webhook events (email.delivered, email.bounced, …),
 *  when the webhook is subscribed to them, and a one-off look at the email in
 *  Resend's API when someone opens a message's details and we know nothing
 *  yet. Both land in message_events, one row per message and kind.
 *
 *  "Opened" comes from a tracking image, so it is only as good as that: it
 *  needs open tracking on the sending domain, mail clients that block images
 *  never report it, Apple Mail's privacy proxy can report it without anyone
 *  reading, and when an email went to several people it can't say which one
 *  opened it. */

export type DeliveryType = 'delivered' | 'bounced' | 'delivery_delayed' | 'complained' | 'opened'

export interface MessageEvent {
  message_id: number
  type: DeliveryType
  recipients: string | null
  detail: string | null
  first_at: number
  last_at: number
  count: number
}

const TYPES: Record<string, DeliveryType> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.delivery_delayed': 'delivery_delayed',
  'email.complained': 'complained',
  'email.opened': 'opened',
  // a click means it was opened, whatever the image did
  'email.clicked': 'opened',
}

export const isDeliveryEvent = (type: string) => type in TYPES

async function record(messageId: number, type: DeliveryType, recipients: string[], detail: string | null, at: number) {
  const rcpt = recipients.map((r) => r.toLowerCase().trim()).filter(Boolean).join(',') || null
  await run(`
    INSERT INTO message_events (message_id, type, recipients, detail, first_at, last_at, count)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (message_id, type) DO UPDATE SET
      last_at = MAX(last_at, excluded.last_at),
      first_at = MIN(first_at, excluded.first_at),
      count = count + 1,
      recipients = COALESCE(excluded.recipients, recipients),
      detail = COALESCE(excluded.detail, detail)`,
  [messageId, type, rcpt, detail, at, at])
}

/** A Resend webhook event about an email we sent. Returns false when the
 *  email isn't one of ours (an app email, a notification). */
export async function recordDeliveryEvent(payload: {
  type: string; created_at?: string
  data: { email_id?: string; to?: string[]; created_at?: string; bounce?: { message?: string; type?: string; subType?: string } }
}): Promise<boolean> {
  const type = TYPES[payload.type]
  const emailId = payload.data?.email_id
  if (!type || !emailId) return false
  const msg = await get<{ id: number }>('SELECT id FROM messages WHERE resend_email_id = ? AND direction = ?', [emailId, 'outbound'])
  if (!msg) return false
  const stamp = Date.parse(payload.created_at || payload.data.created_at || '')
  const at = Number.isFinite(stamp) ? Math.floor(stamp / 1000) : now()
  const b = payload.data.bounce
  const detail = type === 'bounced' && b ? [b.type, b.subType, b.message].filter(Boolean).join(' · ').slice(0, 300) : null
  await record(msg.id, type, payload.data.to ?? [], detail, at)
  // being opened or bouncing late both say it got as far as a mailbox server
  if (type === 'opened') await record(msg.id, 'delivered', [], null, at).catch(() => undefined)
  return true
}

/** Someone's mail app loaded the image in one of our emails. We record that
 *  it happened and when — not the IP address, not the user agent, not a
 *  cookie, nothing that says who or where. */
export async function recordPixelOpen(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false
  const msg = await get<{ id: number }>("SELECT id FROM messages WHERE open_token = ? AND direction = 'outbound' AND sent_at IS NOT NULL", [token])
  if (!msg) return false
  const at = now()
  await record(msg.id, 'opened', [], 'pixel', at)
  await record(msg.id, 'delivered', [], 'pixel', at)
  return true
}

/** The image itself: a transparent 1x1 GIF. */
export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export const messageEvents = async (messageIds: number[]): Promise<Map<number, MessageEvent[]>> => {
  const out = new Map<number, MessageEvent[]>()
  if (!messageIds.length) return out
  const rows = await all<MessageEvent>(
    `SELECT * FROM message_events WHERE message_id IN (${messageIds.map(() => '?').join(',')})`, messageIds)
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r])
  return out
}

/** Ask Resend about one email we know nothing final about. The answer is the
 *  email's latest event without its time, so the row is stamped "checked at". */
export async function refreshDelivery(msg: Pick<Message, 'id' | 'direction' | 'resend_email_id' | 'sent_at'>): Promise<MessageEvent[]> {
  const known = (await messageEvents([msg.id])).get(msg.id) ?? []
  const settled = known.some((e) => e.type !== 'delivery_delayed')
  if (settled || msg.direction !== 'outbound' || !msg.resend_email_id || !msg.sent_at || !cfg.resendKey) return known
  try {
    const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(msg.resend_email_id)}`, {
      headers: { Authorization: `Bearer ${cfg.resendKey}` },
    })
    if (!res.ok) return known
    const email = (await res.json()) as { last_event?: string; to?: string[] }
    const type = TYPES[`email.${email.last_event}`]
    if (!type) return known
    const at = now()
    if (type === 'opened') await record(msg.id, 'delivered', [], 'checked', at)
    await record(msg.id, type, [], 'checked', at)
  } catch (err) {
    console.error(`[deliveries] lookup failed for message ${msg.id}:`, err)
  }
  return (await messageEvents([msg.id])).get(msg.id) ?? []
}

/** Every address an outbound message went to, To then Cc then Bcc. */
export const recipientsOf = (m: Pick<Message, 'to_json' | 'cc_json'> & { bcc_json?: string | null }): string[] => {
  const list = (j: string | null | undefined) => { try { return (JSON.parse(j || '[]') as string[]) } catch { return [] } }
  return [...list(m.to_json), ...list(m.cc_json), ...list(m.bcc_json)]
}
