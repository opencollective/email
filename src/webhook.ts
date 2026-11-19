import crypto from 'node:crypto'
import { Hono } from 'hono'
import { simpleParser, type ParsedMail } from 'mailparser'
import { cfg } from './config.js'
import { getCollective, getCollectiveBySlug, getCollectiveByCustomAddress, getCollectiveByCustomDomain, getMember, getThread, run } from './db.js'
import { refFromReferences, resolveReplyAddress, viaSlug } from './reply-tokens.js'
import { externalRecipient, handleEmailNote, handleEmailReply, ingestInbound, teamSender } from './ingest.js'
import { applyCheckoutSession, verifyStripeSignature } from './stripe.js'
import { billingState, canReceive } from './billing.js'
import { isDeliveryEvent, recordDeliveryEvent } from './deliveries.js'

/** Verify a svix-signed webhook (Resend uses svix).
 *  signature = base64(hmacSHA256(base64decode(secret_after_whsec), `${id}.${timestamp}.${body}`)) */
function verifySvix(headers: Headers, body: string): boolean {
  // without a secret, anyone could POST a fake inbound email: only acceptable
  // in dev, where no real email flows (no Resend key)
  if (!cfg.resendWebhookSecret) return !cfg.resendKey
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signatures = headers.get('svix-signature')
  if (!id || !timestamp || !signatures) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false // 5 min tolerance
  const secret = Buffer.from(cfg.resendWebhookSecret.replace(/^whsec_/, ''), 'base64')
  const expected = crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')
  return signatures.split(' ').some((s) => {
    const sig = s.includes(',') ? s.split(',')[1] : s
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch {
      return false
    }
  })
}

interface ReceivedPayload {
  type: string
  data: {
    email_id: string
    from?: string
    to?: string[]
    cc?: string[]
    received_for?: string[]
    subject?: string
    message_id?: string
    // present in test/dev payloads; real Resend webhooks are metadata-only
    text?: string
    html?: string
    headers?: Record<string, string>
  }
}

/** The webhook payload is metadata-only: fetch the full email, preferring the
 *  raw MIME (parsed with mailparser → text, headers, references, attachments). */
async function fetchReceivedEmail(emailId: string): Promise<ParsedMail | null> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${cfg.resendKey}` },
  })
  if (!res.ok) {
    console.error(`[webhook] fetch received email ${emailId} failed: ${res.status} ${await res.text()}`)
    return null
  }
  const email = (await res.json()) as {
    text?: string; html?: string; subject?: string; from?: string; to?: string[]; cc?: string[]
    message_id?: string; headers?: Record<string, string>; created_at?: string
    raw?: { download_url?: string }
  }
  if (email.raw?.download_url) {
    try {
      const rawRes = await fetch(email.raw.download_url)
      if (rawRes.ok) return await simpleParser(Buffer.from(await rawRes.arrayBuffer()))
    } catch (err) {
      console.error('[webhook] raw download failed, falling back to JSON fields:', err)
    }
  }
  // Fallback: reconstruct a minimal RFC822 message from the JSON fields
  return synthesizeParsed({
    from: email.from, to: email.to, cc: email.cc, subject: email.subject,
    message_id: email.message_id, text: email.text, html: email.html,
    headers: email.headers, date: email.created_at,
  })
}

async function synthesizeParsed(d: {
  from?: string; to?: string[]; cc?: string[]; subject?: string; message_id?: string
  text?: string; html?: string; headers?: Record<string, string>; date?: string
}): Promise<ParsedMail> {
  const lines = [
    `From: ${d.from || 'unknown@unknown'}`,
    `To: ${(d.to || []).join(', ')}`,
    ...(d.cc?.length ? [`Cc: ${d.cc.join(', ')}`] : []),
    `Subject: ${d.subject || ''}`,
    ...(d.message_id ? [`Message-ID: ${d.message_id}`] : []),
    ...(d.date ? [`Date: ${new Date(d.date).toUTCString()}`] : []),
    ...(d.headers?.['in-reply-to'] ? [`In-Reply-To: ${d.headers['in-reply-to']}`] : []),
    ...(d.headers?.['references'] ? [`References: ${d.headers['references']}`] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    d.text || d.html?.replace(/<[^>]+>/g, ' ') || '',
  ]
  return simpleParser(lines.join('\r\n'))
}

export const webhooks = new Hono()

webhooks.post('/webhooks/resend', async (c) => {
  const body = await c.req.text()
  if (!verifySvix(c.req.raw.headers, body)) return c.json({ error: 'invalid signature' }, 401)

  let payload: ReceivedPayload
  try {
    payload = JSON.parse(body)
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  // what became of an email we sent: delivered, bounced, opened…
  if (isDeliveryEvent(payload.type)) {
    const ours = await recordDeliveryEvent(payload as Parameters<typeof recordDeliveryEvent>[0])
    return c.json({ ok: true, recorded: ours })
  }
  if (payload.type !== 'email.received') return c.json({ ok: true, ignored: payload.type })

  const d = payload.data
  // Inline body fields (dev/test payloads) skip the API round-trip
  const parsed = d.text !== undefined || d.html !== undefined
    ? await synthesizeParsed({ ...d, date: undefined })
    : cfg.resendKey
      ? await fetchReceivedEmail(d.email_id)
      : null
  if (!parsed) return c.json({ ok: false, error: 'could not load email content' }, 200)

  // Candidate recipients on our domain, from webhook metadata AND parsed headers
  const parsedTo = [
    ...(Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []),
    ...(Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : []),
  ].flatMap((a) => a.value.map((v) => (v.address || '').toLowerCase()))
  const allAddrs = [...new Set([
    ...(d.to || []), ...(d.cc || []), ...(d.received_for || []), ...parsedTo,
  ].map((a) => a.toLowerCase().trim()).filter(Boolean))]
  const candidates = allAddrs.filter((a) => a.endsWith(`@${cfg.emailDomain}`))

  // 1. Member replying to a notification? The token says what the reply does:
  // answer the outside sender, or file an internal note.
  for (const addr of candidates) {
    const ref = await resolveReplyAddress(addr)
    if (ref) {
      if (ref.kind === 'note') {
        await handleEmailNote(parsed, ref)
        return c.json({ ok: true, handled: 'member_note' })
      }
      await handleEmailReply(parsed, ref)
      return c.json({ ok: true, handled: 'member_reply' })
    }
  }

  // 1b. A teammate answering one of our notifications whose reply address got
  // lost on the way: their mail app answered the From instead of Reply-To, or
  // the address had expired. Our notification's signed Message-ID is still in
  // In-Reply-To / References. Only when it was written to us alone: if they
  // put the outside person in To themselves, that person already has it.
  const refIds = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []),
  ]
  const notified = refIds.length ? await refFromReferences(refIds) : null
  if (notified) {
    const member = await getMember(notified.memberId)
    const thread = await getThread(notified.threadId)
    const collective = thread ? await getCollective(thread.collective_id) : undefined
    const fromAddr = (Array.isArray(parsed.from) ? parsed.from[0] : parsed.from)?.value?.[0]?.address?.toLowerCase() || ''
    if (member && collective && !member.removed_at) {
      const { member: who } = await teamSender(collective, fromAddr)
      const rcpts = [...(Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []),
        ...(Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [])]
        .flatMap((a) => a.value.map((v) => ({ address: (v.address || '').toLowerCase(), name: v.name || '' })))
      const outsider = await externalRecipient(collective, rcpts)
      if ((fromAddr === member.email.toLowerCase() || who?.id === member.id) && !outsider) {
        console.log(`[webhook] reply to notification (thread ${notified.threadId}) reached us without its reply address — routed by Message-ID`)
        if (notified.kind === 'note') await handleEmailNote(parsed, notified)
        else await handleEmailReply(parsed, notified)
        return c.json({ ok: true, handled: notified.kind === 'note' ? 'member_note' : 'member_reply', via: 'references' })
      }
    }
  }

  // 2. Route to collectives by local part (before any +tag). A reply address
  // whose token expired still lands in the inbox via its -via-<slug> suffix.
  const seen = new Set<number>()
  let routed = 0
  for (const addr of candidates) {
    const local = addr.split('@')[0].split('+')[0]
    const slug = viaSlug(local) ?? local
    const collective = await getCollectiveBySlug(slug)
    if (!collective || collective.status !== 'active' || seen.has(collective.id)) continue
    if (!canReceive(billingState(collective))) continue // trial + grace over: address released
    seen.add(collective.id)
    await ingestInbound(collective, parsed, d.email_id)
    routed++
  }

  // 3. Pro custom domains on the MX path: the exact address first (a domain
  // can carry several inboxes), else the domain's catch-all (once MX points
  // at us, unrouted locals would otherwise black-hole)
  for (const addr of allAddrs) {
    const [local, domain] = addr.split('@')
    if (!domain || domain === cfg.emailDomain) continue
    const collective = (await getCollectiveByCustomAddress(local.split('+')[0], domain)) ?? (await getCollectiveByCustomDomain(domain))
    if (!collective || collective.plan !== 'pro' || seen.has(collective.id)) continue
    if (collective.status !== 'active') continue // archived: bounce, like the slug route
    if (!canReceive(billingState(collective))) continue
    seen.add(collective.id)
    await ingestInbound(collective, parsed, d.email_id)
    routed++
  }
  return c.json({ ok: true, routed })
})

// ---------- Stripe billing webhook ----------

webhooks.post('/webhooks/stripe', async (c) => {
  const body = await c.req.text()
  // an unsigned event could make any collective "subscribed": with billing
  // configured, a missing secret means refuse, never trust
  if (!cfg.stripeWebhookSecret) {
    if (cfg.stripeKey) return c.json({ error: 'webhook secret not configured' }, 503)
  } else if (!verifyStripeSignature(body, c.req.header('stripe-signature') || '', cfg.stripeWebhookSecret)) {
    // a length mismatch means the body was rewritten on the way in (re-serialised
    // JSON); equal lengths mean STRIPE_WEBHOOK_SECRET isn't this endpoint's secret
    console.error(`[stripe] invalid signature: content-length ${c.req.header('content-length') ?? '?'}, received ${Buffer.byteLength(body)} bytes`)
    return c.json({ error: 'invalid signature' }, 401)
  }
  let event: any
  try {
    event = JSON.parse(body)
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data?.object ?? {}
    const collectiveId = await applyCheckoutSession(s)
    if (collectiveId) console.log(`[stripe] collective ${collectiveId} subscribed (${s.metadata?.plan}/${s.metadata?.cycle})`)
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data?.object ?? {}
    const status = event.type.endsWith('deleted') ? 'canceled' : String(sub.status || 'active')
    await run('UPDATE collectives SET stripe_status = ? WHERE stripe_subscription_id = ?', [status, sub.id])
    console.log(`[stripe] subscription ${sub.id} → ${status}`)
  }

  return c.json({ received: true })
})
