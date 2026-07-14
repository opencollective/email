import { cfg } from './config.js'

/** Resend custom-domain lifecycle for the Pro plan. Ownership verification
 *  IS the sending setup: whoever can add the DKIM/SPF records controls the
 *  domain, so no separate proof is needed. Without RESEND_API_KEY (dev,
 *  tests) the calls return a deterministic stub so flows stay testable. */

export interface DomainRecord {
  record: string // 'SPF' | 'DKIM' | 'MX' | …
  name: string
  type: string
  value: string
  status?: string
}

export interface ResendDomain {
  id: string
  name: string
  status: string // 'not_started' | 'pending' | 'verified' | 'failure' | …
  records: DomainRecord[]
}

const STUB: ResendDomain = {
  id: 'dev-domain',
  name: 'example.org',
  status: 'pending',
  records: [
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=DEV_STUB_KEY', status: 'pending' },
    { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', status: 'pending' },
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', status: 'pending' },
  ],
}

async function resend(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<any> {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`Resend ${method} ${path} failed (${res.status}): ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

export async function createResendDomain(name: string): Promise<ResendDomain> {
  if (!cfg.resendKey) return { ...STUB, name }
  const d = await resend('/domains', 'POST', { name, region: 'eu-west-1' })
  return { id: d.id, name: d.name, status: d.status, records: d.records || [] }
}

export async function getResendDomain(id: string): Promise<ResendDomain | null> {
  if (!cfg.resendKey) return STUB
  try {
    const d = await resend(`/domains/${id}`, 'GET')
    return { id: d.id, name: d.name, status: d.status, records: d.records || [] }
  } catch {
    return null
  }
}

/** Ask Resend to (re)check the DNS records. */
export async function verifyResendDomain(id: string): Promise<void> {
  if (!cfg.resendKey) return
  await resend(`/domains/${id}/verify`, 'POST')
}

/** MX path: Resend also receives mail for the domain (adds an MX record to the set). */
export async function enableDomainReceiving(id: string): Promise<void> {
  if (!cfg.resendKey) return
  await resend(`/domains/${id}`, 'PATCH', { capabilities: { receiving: 'enabled' } })
}

export async function deleteResendDomain(id: string): Promise<void> {
  if (!cfg.resendKey) return
  await resend(`/domains/${id}`, 'DELETE').catch(() => {})
}

export const validDomainName = (d: string) =>
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d) && d !== cfg.emailDomain && !d.endsWith(`.${cfg.emailDomain}`)

export const validLocalPart = (l: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(l)
