import { resolveMx } from 'node:dns/promises'

/** Where a domain's mail goes today, read from its MX records, so the domain
 *  page can say exactly what to do instead of listing every option. */

export type MxProvider = {
  key: string
  name: string
  /** where the person goes to add a forward, when we know */
  forwardHow?: string
}

export type MxState =
  | { kind: 'none' }                          // no MX at all: nothing receives this domain's mail
  | { kind: 'ours'; hosts: string[] }          // already points at us
  | { kind: 'provider'; provider: MxProvider; hosts: string[] }
  | { kind: 'unknown'; hosts: string[] }       // some mail server we don't recognise
  | { kind: 'error' }                          // DNS lookup failed: say nothing specific

const PROVIDERS: { match: RegExp; p: MxProvider }[] = [
  { match: /(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com)$/, p: { key: 'google', name: 'Google Workspace',
    forwardHow: 'Sign in to Gmail as {addr} → Settings (gear) → See all settings → Forwarding and POP/IMAP → Add a forwarding address → {target}. Google sends a confirmation email: it will appear in this inbox, and any admin clicks the link. If {addr} is a Google Group rather than a mailbox, add {target} as a member of the group instead.' } },
  { match: /\.mail\.protection\.outlook\.com$|\.outlook\.com$/, p: { key: 'microsoft', name: 'Microsoft 365',
    forwardHow: 'In Outlook on the web as {addr}: Settings → Mail → Forwarding → Enable forwarding → {target}, and keep a copy if you like. An admin may need to allow external forwarding in the Microsoft 365 Defender outbound spam policy.' } },
  { match: /\.mail\.ovh\.net$|\.ovh\.net$/, p: { key: 'ovh', name: 'OVHcloud',
    forwardHow: 'In the OVHcloud control panel: Web Cloud → Emails → your domain → Redirection → Add a redirection from {addr} to {target}.' } },
  { match: /gandi\.net$/, p: { key: 'gandi', name: 'Gandi',
    forwardHow: 'In Gandi: Domain → Email → Forwarding addresses → Create → {addr} forwards to {target}.' } },
  { match: /registrar-servers\.com$|privateemail\.com$/, p: { key: 'namecheap', name: 'Namecheap',
    forwardHow: 'In Namecheap: Domain List → Manage → Redirect Email → Add forwarder → {addr} to {target}.' } },
  { match: /protonmail\.ch$|proton\.me$/, p: { key: 'proton', name: 'Proton Mail',
    forwardHow: 'In Proton Mail as {addr}: Settings → All settings → Proton Mail → Forward emails → Add forwarding rule → {target} (needs a paid plan).' } },
  { match: /messagingengine\.com$|fastmail\.com$/, p: { key: 'fastmail', name: 'Fastmail',
    forwardHow: 'In Fastmail: Settings → Mail rules → Forwarding → forward {addr} to {target}.' } },
  { match: /zoho\.(com|eu|in)$|zohomail\./, p: { key: 'zoho', name: 'Zoho Mail',
    forwardHow: 'In Zoho Mail as {addr}: Settings → Mail Forwarding and POP/IMAP → Add forwarding → {target}, then confirm the code Zoho emails to this inbox.' } },
  { match: /mail\.icloud\.com$/, p: { key: 'icloud', name: 'iCloud Mail' } },
  { match: /infomaniak\.(ch|com)$/, p: { key: 'infomaniak', name: 'Infomaniak',
    forwardHow: 'In the Infomaniak Manager: Mail service → {addr} → Redirection → add {target}.' } },
  { match: /yahoodns\.net$/, p: { key: 'yahoo', name: 'Yahoo' } },
  { match: /mailgun\.org$/, p: { key: 'mailgun', name: 'Mailgun',
    forwardHow: 'In Mailgun: Receiving → Create route → match recipient {addr} → forward to {target}.' } },
  { match: /improvmx\.com$/, p: { key: 'improvmx', name: 'ImprovMX',
    forwardHow: 'In ImprovMX: your domain → Add alias → {addr} forwards to {target}.' } },
  { match: /cloudflare\.net$|mx\.cloudflare\.net$/, p: { key: 'cloudflare', name: 'Cloudflare Email Routing',
    forwardHow: 'In Cloudflare: your domain → Email → Email Routing → Routing rules → Create address → {addr} sends to {target}, then verify the destination (the email arrives in this inbox).' } },
]

/** Our own receiving hosts: Resend inbound. */
const OURS = /inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$|(^|\.)resend\.(com|dev)$/

let stub: ((domain: string) => Promise<string[]>) | null = null
/** Test seam: pretend DNS returns these MX hosts (or throws). */
export function __setMxStub(fn: ((domain: string) => Promise<string[]>) | null) { stub = fn }

export async function mxHosts(domain: string): Promise<string[]> {
  if (stub) return stub(domain)
  const recs = await Promise.race([
    resolveMx(domain),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
  ])
  return recs.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
}

/** `ourHosts`: the receiving MX values Resend gave for this domain, if any. */
export async function mxState(domain: string, ourHosts: string[] = []): Promise<MxState> {
  let hosts: string[]
  try {
    hosts = await mxHosts(domain)
  } catch (err) {
    const code = (err as { code?: string }).code
    // ENODATA / ENOTFOUND: the domain answers, it just has no mail servers
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { kind: 'none' }
    return { kind: 'error' }
  }
  hosts = hosts.filter(Boolean)
  if (hosts.length === 0 || (hosts.length === 1 && hosts[0] === '')) return { kind: 'none' }
  const ours = new Set(ourHosts.map((h) => h.toLowerCase().replace(/\.$/, '')))
  if (hosts.every((h) => ours.has(h) || OURS.test(h))) return { kind: 'ours', hosts }
  for (const { match, p } of PROVIDERS) if (hosts.some((h) => match.test(h))) return { kind: 'provider', provider: p, hosts }
  return { kind: 'unknown', hosts }
}

export const fillHow = (how: string, addr: string, target: string) =>
  how.replaceAll('{addr}', addr).replaceAll('{target}', target)
