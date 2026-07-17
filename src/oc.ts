import { cfg } from './config.js'

/** Open Collective GraphQL v2 — ownership verification for claims.
 *
 *  The insight: to send as / prove control of an OC collective you must be able
 *  to reach its admins (contact form) or edit its public profile — both are
 *  admin-only, so either one proves ownership. We use the contact form to
 *  deliver the claim code when it's available, and a description token as the
 *  self-serve fallback when it isn't (there is no public email field on the
 *  profile — `emails` is null and socialLinks carries no email). */

const API = 'https://api.opencollective.com/graphql/v2'

// Injectable for tests; defaults to the platform fetch.
let fetcher: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a)
export function __setOcFetcher(f: typeof fetch) { fetcher = f }

async function ocGraphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetcher(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Personal-Token': cfg.ocToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  })
  return res.json()
}

export const ocEnabled = () => !!cfg.ocToken

export type OcStatus =
  | { kind: 'none' }        // no such collective on opencollective.com
  | { kind: 'unknown' }     // couldn't check (no token / API error) — caller should fall back
  | { kind: 'contactable'; name: string; admins: string[] }
  | { kind: 'uncontactable'; name: string }

const INFO_QUERY = `query ($slug: String!) {
  account(slug: $slug) {
    name
    features { CONTACT_FORM }
    members(role: [ADMIN], limit: 20) { nodes { account { name slug } } }
  }
}`

/** Look up an OC collective's claim status. */
export async function ocCollectiveInfo(slug: string): Promise<OcStatus> {
  if (!cfg.ocToken) return { kind: 'unknown' }
  let json: any
  try {
    json = await ocGraphql(INFO_QUERY, { slug })
  } catch {
    return { kind: 'unknown' }
  }
  if (json.errors?.length) {
    return json.errors[0]?.extensions?.code === 'NotFound' ? { kind: 'none' } : { kind: 'unknown' }
  }
  const a = json.data?.account
  if (!a) return { kind: 'none' }
  const admins: string[] = (a.members?.nodes || [])
    .map((n: any) => n.account?.name || n.account?.slug)
    .filter(Boolean)
  if (a.features?.CONTACT_FORM === 'ACTIVE') return { kind: 'contactable', name: a.name || slug, admins }
  return { kind: 'uncontactable', name: a.name || slug }
}

const SEND_MUTATION = `mutation ($account: AccountReferenceInput!, $message: NonEmptyString!, $subject: String) {
  sendMessage(account: $account, message: $message, subject: $subject) { success }
}`

/** Deliver a claim code to a collective's admins via the OC contact form.
 *  Returns false if the send failed (caller surfaces a retry message). */
export async function sendOcVerificationCode(slug: string, code: string): Promise<boolean> {
  if (!cfg.ocToken) return false
  const message = [
    `Someone is claiming the email address ${slug}@${cfg.emailDomain} for your collective on collective.email — a shared inbox any of your team can read and answer from.`,
    '',
    `If that's you (or someone on your team), enter this code to confirm you manage this collective:`,
    '',
    `    ${code}`,
    '',
    `It expires in 10 minutes. If you didn't request this, you can safely ignore this message.`,
    '',
    '— collective.email',
  ].join('\n')
  try {
    const json = await ocGraphql(SEND_MUTATION, { account: { slug }, message, subject: 'Your collective.email verification code' })
    return !!json.data?.sendMessage?.success
  } catch {
    return false
  }
}

const DESC_QUERY = `query ($slug: String!) {
  account(slug: $slug) { description longDescription }
}`

/** Fallback proof: does the collective's public description contain `needle`?
 *  Only an admin can edit it, so finding a token we handed out proves control. */
export async function ocDescriptionContains(slug: string, needle: string): Promise<boolean> {
  if (!cfg.ocToken) return false
  try {
    const json = await ocGraphql(DESC_QUERY, { slug })
    const a = json.data?.account
    const hay = `${a?.description || ''}\n${a?.longDescription || ''}`.toLowerCase()
    return hay.includes(needle.toLowerCase())
  } catch {
    return false
  }
}
