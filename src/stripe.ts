import crypto from 'node:crypto'
import { cfg } from './config.js'
import type { Collective } from './db.js'

export const stripeEnabled = () => !!cfg.stripeKey

export const PLAN_PRICING: Record<string, { label: string; monthly: number; yearly: number }> = {
  collective: { label: 'Collective', monthly: 1000, yearly: 10000 },
  pro: { label: 'Pro', monthly: 10000, yearly: 100000 },
  duo: { label: 'Duo', monthly: 1000, yearly: 10000 }, // legacy
}

async function stripe(path: string, params?: Record<string, string>, method: 'GET' | 'POST' = 'POST'): Promise<any> {
  const qs = params ? new URLSearchParams(params).toString() : ''
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' ? qs : undefined,
  })
  const json = (await res.json()) as any
  if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`)
  return json
}

/** Find (by lookup_key) or create the Stripe price for a plan/cycle/currency.
 *  Products and prices are provisioned lazily — no dashboard setup needed. */
async function ensurePrice(plan: string, cycle: 'monthly' | 'yearly', currency: 'eur' | 'usd'): Promise<string> {
  const lookup = `ce2_${plan}_${cycle}_${currency}` // v2: repriced 2026-07
  const existing = await stripe('/prices', { 'lookup_keys[]': lookup, limit: '1' }, 'GET')
  if (existing.data?.[0]) return existing.data[0].id

  const pricing = PLAN_PRICING[plan]
  const search = await stripe('/products/search', { query: `metadata['ce_plan']:'${plan}'` }, 'GET')
  const product = search.data?.[0] ?? await stripe('/products', {
    name: `collective.email · ${pricing.label}`,
    'metadata[ce_plan]': plan,
  })
  const price = await stripe('/prices', {
    product: product.id,
    currency,
    unit_amount: String(cycle === 'yearly' ? pricing.yearly : pricing.monthly),
    'recurring[interval]': cycle === 'yearly' ? 'year' : 'month',
    lookup_key: lookup,
  })
  return price.id
}

/** Hosted Stripe Checkout for a subscription; returns the redirect URL. */
export async function createCheckoutSession(
  collective: Collective,
  adminEmail: string,
  plan: string,
  cycle: 'monthly' | 'yearly',
  currency: 'eur' | 'usd',
): Promise<string> {
  const price = await ensurePrice(plan, cycle, currency)
  const billingUrl = `${cfg.baseUrl}/inbox/${collective.slug}/billing`
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: `${billingUrl}?success=1`,
    cancel_url: `${billingUrl}?canceled=1`,
    'metadata[collective_id]': String(collective.id),
    'metadata[plan]': plan,
    'metadata[cycle]': cycle,
    'subscription_data[metadata][collective_id]': String(collective.id),
  }
  if (collective.stripe_customer_id) params.customer = collective.stripe_customer_id
  else params.customer_email = adminEmail
  const session = await stripe('/checkout/sessions', params)
  return session.url
}

/** Stripe Billing Portal (update card, change plan, cancel). */
export async function createPortalSession(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe('/billing_portal/sessions', { customer: customerId, return_url: returnUrl })
  return session.url
}

/** Verify a Stripe webhook signature (`stripe-signature: t=…,v1=…`). */
export function verifyStripeSignature(body: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const t = Number(parts.t)
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex')
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))
  return sigs.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch {
      return false
    }
  })
}
