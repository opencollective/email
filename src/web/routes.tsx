/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { cfg } from '../config.js'
import {
  activeMembers, addTag, all, allCollectives, attachmentsByMessage, batchAll, createCollective, get, getCollective,
  getCollectiveBySlug, getMember, getMemberIn, getThread, kvGet, kvSet, lastMessageByThread, memberMap,
  renameCollectiveSlug,
  markThreadSeen, membershipsByEmail, readsForMember, removeTag, run, setAssignee, setStatus, tagsByThread, threadMessages, threadReads, threadTags,
  type ThreadRead,
  type Attachment, type Collective, type Invite, type Member, type Message, type Thread,
} from '../db.js'
import {
  accountsFromCookie, checkCode, createSession, destroySession, issueCode,
  type Account, type LoginCodeRow,
} from '../auth.js'
import { forwardMessage, outboundFrom, sendCollectiveReply, sendComposed, signatureFor } from '../outbound.js'
import { digestTick, receivingAddress, sendOnboarding, trialTick } from '../notify.js'
import { mentionLabels, noteParts } from '../mentions.js'
import { addNote } from '../notes.js'
import { backupTick } from '../backup.js'
import { archiveCollective, messageCount, PURGE_AFTER, purgeArchivedTick, purgeDueAt, restoreCollective } from '../archive.js'
import { CONTRIBUTE_SLUG, creditBalance, creditsLedger, creditsTick, fileContribution, mintCredits, referralUrl , PRO_MONTH_CREDITS } from '../credits.js'
import {
  approveApplication, checkDiscountCode, checkOcOwnershipCode, discountCodeFor, fileApplication, fileProApplication,
  issueOcOwnershipCode, ocSlugTaken, slugAvailability, validateClaimSlug,
} from '../claim.js'
import { ocCollectiveInfo, ocDescriptionContains, sendOcVerificationCode, type OcStatus } from '../oc.js'
import { createRule, deleteRule, describeRule, listRules, matchingRule } from '../rules.js'
import { emailHtmlDocument } from '../sanitize.js'
import { sendAppEmail } from '../appmail.js'
import { readBlob, saveBlob } from '../storage.js'
import { createCheckoutSession, createPortalSession, stripeUsable } from '../stripe.js'
import { billingState, canSend, planLimits, repliesThisMonth, trialDaysLeft, GRACE_DAYS } from '../billing.js'
import { escapeHtml, excerpt, fmtDate, fmtDateTime, initials, now, randomToken, relTime, signToken, slugify, splitQuotedTail, verifyToken, waitingFor } from '../util.js'
import { AssigneeChip, AuthCard, Avatar, eventText, Shell, StatusChip, TimeAgo } from './ui.js'
import { HomePage } from './home.js'
import { AboutPage, DocsPage, FaqPage } from './pages.js'
import {
  createResendDomain, deleteResendDomain, domainVerifyTick, enableDomainReceiving, getResendDomain,
  validDomainName, validLocalPart, verifyResendDomain,
} from '../domains.js'

type Env = { Variables: { email: string | null; accounts: Account[] } }
export const app = new Hono<Env>()

const SID = 'requests_sid'
/** Roles: reader (can read) → commenter (can comment) → member (can send) → admin.
 *  Readers see everything but act on nothing; commenters do everything except
 *  send external email; senders + admins are the paid contributor seats. */
const canSendRole = (r: Member['role']) => r === 'member' || r === 'admin'
const ROLE_LABELS: Record<Member['role'], string> = { reader: 'reader', commenter: 'commenter', member: 'sender', admin: 'admin' }
const ROLE_HINTS: Record<Member['role'], string> = {
  reader: 'Reads everything and gets the digests — takes no actions.',
  commenter: 'Discusses internally: notes, assigning, tags — cannot email the outside world.',
  member: 'Answers senders as the collective — uses a paid seat.',
  admin: 'Everything a sender can, plus members, billing and settings.',
}
/** Nothing may be written to an archived inbox — it is on its way out, and the
 *  outside world is already being told so by the bounces. */
const archivedBlock = (c: Context<Env>, t: { collective: Collective }) =>
  t.collective.status === 'archived'
    ? c.redirect(`/inbox/${t.collective.slug}?m=` + encodeURIComponent('This inbox is closed — restore it from Settings → Data to use it again.'))
    : null
const readerBlock = (c: Context<Env>, t: { collective: Collective; member: Member }) =>
  archivedBlock(c, t) ??
  (t.member.role === 'reader'
    ? c.redirect(`/inbox/${t.collective.slug}?m=` + encodeURIComponent('You have read access — ask an admin to let you comment or send.'))
    : null)
const senderBlock = (c: Context<Env>, t: { collective: Collective; member: Member }) =>
  archivedBlock(c, t) ??
  (!canSendRole(t.member.role)
    ? c.redirect(`/inbox/${t.collective.slug}?m=` + encodeURIComponent('Your role can comment but not send email — ask an admin for sending rights.'))
    : null)
const memberName = (m?: Member | null) => (m ? m.name || m.email.split('@')[0] : 'someone')
const isPlatformAdmin = (email: string | null) => !!email && !!cfg.adminEmail && email === cfg.adminEmail

const LEVELS: { value: Member['notify_level']; label: string; hint: string }[] = [
  { value: 'every', label: 'As they arrive', hint: 'One email per incoming request — reply to it to answer directly.' },
  { value: 'daily', label: 'Daily digest', hint: 'At most one email a day with everything that needs a reply.' },
  { value: 'weekly', label: 'Weekly digest', hint: 'At most one email a week. For the lightly involved.' },
]

// EU/EEA + CH: show EUR; everyone else sees USD
const EUR_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH', 'NO', 'IS', 'LI',
])

/** Dollars everywhere by default; euros when the visitor looks European.
 *  Signals in order of trust: edge-resolved IP country, the browser's own
 *  time zone (set as a cookie on first load), then accept-language. Nobody is
 *  ever asked to choose — the charge currency is decided server-side. */
function visitorCurrency(c: Context): 'USD' | 'EUR' {
  const country = (
    c.req.header('x-vercel-ip-country') ||
    c.req.header('cf-ipcountry') ||
    c.req.header('x-country-code') ||
    ''
  ).toUpperCase()
  if (country) return EUR_COUNTRIES.has(country) ? 'EUR' : 'USD'
  const tz = getCookie(c, 'tz') || ''
  // Europe/* covers the euro zone and neighbours; Atlantic/* (Azores, Canaries,
  // Madeira, Faroe, Reykjavik) is European too. Europe/Istanbul and
  // Europe/Moscow are not euro users — they fall through to USD.
  if (/^Europe\//.test(tz) && !/^Europe\/(Istanbul|Moscow|Kirov|Samara|Volgograd|Saratov|Ulyanovsk|Astrakhan|Minsk|Kiev|Kyiv)$/.test(tz)) return 'EUR'
  if (/^Atlantic\/(Azores|Canary|Madeira|Faeroe|Faroe|Reykjavik)$/.test(tz)) return 'EUR'
  const langs = c.req.header('accept-language') || ''
  for (const m of langs.matchAll(/[a-z]{2,3}-([A-Z]{2})/g)) {
    if (EUR_COUNTRIES.has(m[1])) return 'EUR'
    return 'USD'
  }
  return 'USD'
}

// ---------- session middleware ----------

app.use('*', async (c, next) => {
  // every signed-in account, cookie order; `email` stays the first one for the
  // handful of places where any verified identity will do
  const accounts = await accountsFromCookie(getCookie(c, SID))
  c.set('accounts', accounts)
  c.set('email', accounts[0]?.email ?? null)
  await next()
})

/** Up to five accounts at once; the cookie is just their session tokens. */
const MAX_ACCOUNTS = 5
function writeSessionCookie(c: Context<Env>, accounts: Account[]) {
  if (accounts.length === 0) {
    deleteCookie(c, SID, { path: '/' })
    return
  }
  setCookie(c, SID, accounts.map((a) => a.token).join('.'), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: cfg.baseUrl.startsWith('https'),
    maxAge: cfg.sessionDays * 86400,
    path: '/',
  })
}

/** The signed-in account that is a platform admin, if any. */
const platformAdminAccount = (c: Context<Env>): string | null =>
  c.get('accounts').map((a) => a.email).find(isPlatformAdmin) ?? null

/** The first signed-in account with a live membership in this collective. */
async function memberAmongAccounts(c: Context<Env>, collectiveId: number): Promise<Member | undefined> {
  for (const a of c.get('accounts')) {
    const m = await getMemberIn(collectiveId, a.email)
    if (m && !m.removed_at) return m
  }
  return undefined
}

/** The :addr URL segment is the collective's address — `commonshub` or
 *  `commonshub@collective.email` (the domain part is optional). */
function slugFromAddr(c: Context<Env>): string | null {
  const raw = decodeURIComponent(c.req.param('addr') || '').toLowerCase().trim()
  if (!raw) return null
  const at = raw.indexOf('@')
  if (at === -1) return raw
  return raw.slice(at + 1) === cfg.emailDomain ? raw.slice(0, at) : null
}

/** Resolve the collective from :addr and the signed-in member within it.
 *  Returns a Response when access fails: login redirect (preserving the
 *  destination) or an explicit "wrong account" page — never a silent bounce. */
async function tenant(c: Context<Env>): Promise<{ collective: Collective; member: Member } | Response> {
  const accounts = c.get('accounts')
  if (accounts.length === 0) return c.redirect('/login?next=' + encodeURIComponent(c.req.path))
  const slug = slugFromAddr(c)
  // Collective + membership in one round-trip. The URL names the collective and
  // the collective picks the identity: whichever signed-in account is a member
  // acts here, so moving between inboxes on different accounts is just a click.
  const emails = accounts.map((a) => a.email)
  const row = slug ? await get<any>(`
    SELECT c.id AS c_id, c.slug AS c_slug, c.name AS c_name, c.status AS c_status, c.plan AS c_plan, c.created_at AS c_created_at,
           c.stripe_status AS c_stripe_status, c.trial_ends_at AS c_trial_ends_at, c.comped AS c_comped,
           c.custom_domain AS c_custom_domain, c.custom_local AS c_custom_local, c.domain_status AS c_domain_status,
           c.archived_at AS c_archived_at,
           m.id, m.collective_id, m.email, m.name, m.role, m.notify_level, m.avatar_path, m.created_at, m.last_seen_at, m.removed_at
    FROM collectives c LEFT JOIN members m
      ON m.collective_id = c.id AND m.removed_at IS NULL AND m.email IN (${emails.map(() => '?').join(',')})
    WHERE c.slug = ?
    ORDER BY (m.id IS NULL), m.id LIMIT 1
  `, [...emails, slug]) : undefined
  if (!row || (row.c_status !== 'active' && row.c_status !== 'archived')) return c.notFound()
  const collective: Collective = {
    id: row.c_id, slug: row.c_slug, name: row.c_name, status: row.c_status, plan: row.c_plan, created_at: row.c_created_at,
    stripe_status: row.c_stripe_status, trial_ends_at: row.c_trial_ends_at, comped: row.c_comped,
    custom_domain: row.c_custom_domain, custom_local: row.c_custom_local, domain_status: row.c_domain_status,
    archived_at: row.c_archived_at,
  }
  const member = (row.id != null ? (row as Member) : undefined) as Member | undefined
  if (!member || member.removed_at) {
    return c.html(
      <AuthCard title={collective.name}>
        <h1>Wrong account for {collective.name}</h1>
        <p class="muted">
          You're signed in as {accounts.map((a, i) => <>{i ? ', ' : ''}<b>{a.email}</b></>)} —
          {accounts.length === 1 ? ' which is not ' : ' none of which are '}a member of {collective.name}.
          If the invite or onboarding email went to another address, add that account:
          you stay signed in to {accounts.length === 1 ? 'this one' : 'these'} too.
        </p>
        <a class="btn" href={`/login?add=1&next=${encodeURIComponent(c.req.path)}`}>Add another account</a>
        {platformAdminAccount(c) ? (
          <form method="post" action={`/inbox/${collective.slug}/join-admin`}>
            <button class="btn ghost" type="submit">Add {platformAdminAccount(c)} as admin of this collective</button>
          </form>
        ) : (
          <p class="fineprint">Not a member at all yet? Ask someone in the collective for an invite link.</p>
        )}
      </AuthCard>,
      403,
    )
  }
  run('UPDATE members SET last_seen_at = ? WHERE id = ?', [now(), member.id]).catch(() => {})
  return { collective, member }
}

// ---------- health, cron & home ----------

app.get('/health', async (c) => c.json({
  ok: true,
  // 'remote' = Turso; 'ephemeral' = file fallback (catastrophic on Vercel — CI fails the deploy)
  db: cfg.dbUrl.startsWith('file:') ? 'ephemeral' : 'remote',
  // config fingerprints (no secret material): which Stripe mode, and are secrets present
  stripe: cfg.stripeKey.startsWith('sk_live') ? 'live' : cfg.stripeKey.startsWith('sk_test') ? 'test' : 'none',
  stripe_webhook: cfg.stripeWebhookSecret.startsWith('whsec_'),
  // key validated against Stripe (cached) — false hides all subscribe UI
  stripe_usable: await stripeUsable(),
}))

// Vercel Cron (or any external scheduler) hits this hourly; digestTick decides who is due.
app.get('/cron/digest', async (c) => {
  const auth = c.req.header('authorization') || ''
  if (cfg.cronSecret && auth !== `Bearer ${cfg.cronSecret}`) return c.json({ error: 'unauthorized' }, 401)
  await digestTick()
  await trialTick()
  await creditsTick()
  await backupTick()
  await purgeArchivedTick()
  await domainVerifyTick()
  return c.json({ ok: true })
})

app.get('/', async (c) => {
  const accounts = c.get('accounts')
  if (accounts.length === 0) return c.html(<HomePage joined={c.req.query('joined') === '1'} currency={visitorCurrency(c)} />)
  const byAccount = await Promise.all(accounts.map(async (a) => ({ account: a, memberships: await membershipsByEmail(a.email) })))
  const total = byAccount.reduce((n, g) => n + g.memberships.length, 0)
  if (accounts.length === 1 && total === 1) return c.redirect(`/inbox/${byAccount[0].memberships[0].collective_slug}`)
  if (total === 0 && platformAdminAccount(c)) return c.redirect('/admin')
  return c.html(
    <AuthCard title="Your collective email addresses" flash={c.req.query('m')}>
      <h1>Your collective email addresses</h1>
      {byAccount.map(({ account, memberships }) => (
        <div class="acct">
          <div class="acct-head">
            <span class="acct-mail">{account.email}</span>
            <form method="post" action="/logout">
              <input type="hidden" name="email" value={account.email} />
              <button class="linkish" type="submit">sign out</button>
            </form>
          </div>
          {memberships.length === 0 ? (
            <p class="fineprint">Not part of any collective yet — ask for an invite link, or <a href="/claim">claim an address</a>.</p>
          ) : (
            <div class="chooser">
              {memberships.map((m) => (
                <a class="chooser-item" href={`/inbox/${m.collective_slug}`}>
                  <b>{m.collective_name}</b>
                  <small>{m.collective_slug}@{cfg.emailDomain}</small>
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
      <div class="chooser">
        <a class="chooser-item chooser-new" href="/login?add=1">
          <b>+ Add another account</b>
          <small>sign in with a second email — this one stays signed in</small>
        </a>
        <a class="chooser-item chooser-new" href="/claim">
          <b>+ New address</b>
          <small>claim one for another collective</small>
        </a>
      </div>
      {platformAdminAccount(c) ? <p class="fineprint"><a href="/admin">Platform admin →</a></p> : null}
      {accounts.length > 1 ? <form method="post" action="/logout"><button class="linkish" type="submit">Sign out of all accounts</button></form> : null}
    </AuthCard>,
  )
})

app.post('/waitlist', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim().slice(0, 200)
  const name = slugify(String(body.collective_name || ''))
  const plan = ['duo', 'collective', 'pro'].includes(String(body.plan)) ? String(body.plan) : 'collective'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.redirect('/#waitlist')
  await run('INSERT OR IGNORE INTO waitlist (email, collective_name, plan, created_at) VALUES (?, ?, ?, ?)',
    [email, name || null, plan, now()])
  if (cfg.adminEmail) {
    const total = (await get<{ n: number }>('SELECT COUNT(*) AS n FROM waitlist'))!.n
    await sendAppEmail({
      to: cfg.adminEmail,
      subject: `[collective.email] waitlist #${total}: ${name || '(no name)'} (${plan})`,
      html: `<p><b>${name || '(no name)'}@${cfg.emailDomain}</b> · ${plan} · ${email}</p><p><a href="${cfg.baseUrl}/admin">Open admin</a> · ${total} signups so far.</p>`,
      text: `${name || '(no name)'}@${cfg.emailDomain} · ${plan} · ${email}\n${cfg.baseUrl}/admin · ${total} signups so far.`,
    }).catch(() => {})
  }
  return c.redirect('/?joined=1#waitlist')
})

// ---------- login ----------

/** Only ever redirect to relative in-app paths from user-supplied `next`. */
const safeNext = (v: unknown): string | null =>
  typeof v === 'string' && /^\/[^/\\]/.test(v) ? v : null

const CodeForm = (p: { email: string; error?: string; next?: string | null; sentToAdmins?: string; resend?: boolean; claiming?: boolean }) => (
  <AuthCard title="Enter code">
    {p.claiming ? <Steps current={2} /> : null}
    <h1>Check your inbox</h1>
    {p.sentToAdmins ? (
      <p class="muted">To confirm you're part of <b>{p.sentToAdmins}</b>, we sent a 6-digit code to its admins on Open Collective. Whoever receives it can enter it here. <a href="/claim">Not your collective?</a></p>
    ) : (
      <p class="muted">We sent a 6-digit code to <b>{p.email}</b>. <a href="/login">Wrong address?</a></p>
    )}
    {p.error ? <p class="error">{p.error}</p> : null}
    {p.resend ? (
      // The code can't work anymore (expired / used / too many tries) — the only
      // useful action is getting a fresh one, so that becomes the button.
      <form method="post" action="/resend">
        <input type="hidden" name="email" value={p.email} />
        {p.next ? <input type="hidden" name="next" value={p.next} /> : null}
        <button class="btn" type="submit" data-busy="Sending…">Send me a new code</button>
      </form>
    ) : (
      <form method="post" action="/verify">
        <input type="hidden" name="email" value={p.email} />
        {p.next ? <input type="hidden" name="next" value={p.next} /> : null}
        <input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder="······" required />
        <button class="btn" type="submit">Sign in</button>
      </form>
    )}
    <p class="fineprint">Code expires in 10 minutes. You'll stay signed in on this device for 3 months, unless you sign out.</p>
  </AuthCard>
)

// The bare homepage, reachable even when signed in (`/` redirects members
// straight to their inbox).
app.get('/homepage', (c) => c.html(<HomePage currency={visitorCurrency(c)} />))
app.get('/faq', (c) => c.html(<FaqPage currency={visitorCurrency(c)} />))
app.get('/docs', (c) => c.html(<DocsPage currency={visitorCurrency(c)} />))
app.get('/about', (c) => c.html(<AboutPage currency={visitorCurrency(c)} />))

app.get('/login', (c) => {
  const next = safeNext(c.req.query('next'))
  const adding = c.req.query('add') === '1'
  if (c.get('email') && !adding) return c.redirect(next || '/')
  return c.html(
    <AuthCard title={adding ? 'Add another account' : 'Sign in'} flash={c.req.query('m')}>
      <h1>{adding ? 'Add another account' : 'Sign in'}</h1>
      {adding && c.get('accounts').length ? (
        <p class="muted">Already signed in as {c.get('accounts').map((a, i) => <>{i ? ', ' : ''}<b>{a.email}</b></>)} — that stays. Enter the other address; we'll send it a 6-digit code.</p>
      ) : (
        <p class="muted">Enter your personal email address. We'll send you a 6-digit code — no password needed.</p>
      )}
      <form method="post" action="/login">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <input class="input" type="email" name="email" placeholder="you@example.com" required autofocus />
        <button class="btn" type="submit">Send me a code</button>
      </form>
      <p class="fineprint">Only members of a collective can sign in. Not a member yet? Ask your collective for an invite link.</p>
    </AuthCard>,
  )
})

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const next = safeNext(body.next)
  if ((await membershipsByEmail(email)).length === 0 && !isPlatformAdmin(email)) {
    return c.html(
      <AuthCard title="Sign in">
        <h1>Not a member (yet)</h1>
        <p class="muted"><b>{email}</b> isn't part of any collective. Ask your collective to share their invite link — it lets you join on your own. Or <a href="/#waitlist">join the waiting list</a> to start one.</p>
        <a class="btn ghost" href="/login">Try another address</a>
      </AuthCard>,
    )
  }
  await issueCode(email, 'login')
  return c.html(<CodeForm email={email} next={next} />)
})

app.post('/verify', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const code = String(body.code || '')
  const res = await checkCode(email, code)
  if (!res.ok) return c.html(<CodeForm email={email} error={res.error} resend={res.resend} next={safeNext(body.next)} />)

  let redirect = safeNext(body.next) || '/'
  if (res.replay) {
    // Duplicate of a submit that already succeeded (double tap / OTP autofill
    // firing twice): the claim/join side effects already ran — just sign in.
    redirect = res.row.purpose === 'claim' && res.row.claim_slug ? `/claim/${res.row.claim_slug}` : redirect
  } else if (res.row.purpose === 'claim' && res.row.claim_slug) {
    const slug = res.row.claim_slug
    // re-check availability at the moment of reservation (it may have been
    // claimed, or appeared on opencollective.com, since the code was sent)
    const unavailable = await slugAvailability(slug)
    if (unavailable) {
      return c.redirect('/claim?m=' + encodeURIComponent(unavailable))
    }
    const collective = await createCollective(slug, res.row.join_name ? `${res.row.join_name}'s collective` : slug, 'collective', { status: 'pending', trial: false })
    if (res.row.claim_ref) {
      const referrer = await getCollectiveBySlug(res.row.claim_ref)
      if (referrer && referrer.status === 'active' && referrer.id !== collective.id) {
        await run('UPDATE collectives SET referred_by = ? WHERE id = ?', [referrer.id, collective.id])
      }
    }
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, email, res.row.join_name || email.split('@')[0], 'admin', 'every', now()])
    redirect = `/claim/${slug}`
  } else if (res.row.purpose === 'join' && res.row.invite_token) {
    const joined = await applyInviteJoin(res.row.invite_token, email, res.row.join_name || '', res.row.join_level || '')
    if (joined) redirect = `/inbox/${joined.slug}?m=` + encodeURIComponent(`Welcome to ${joined.name}!`)
  }

  // Signing in adds an account rather than replacing the session: whoever was
  // already signed in stays signed in. A repeat sign-in for the same email
  // renews its token; past five accounts the oldest quietly drops off.
  const token = await createSession(email)
  const existing = c.get('accounts')
  for (const a of existing) if (a.email === email) await destroySession(a.token)
  const merged = [...existing.filter((a) => a.email !== email), { token, email }]
  for (const dropped of merged.slice(0, Math.max(0, merged.length - MAX_ACCOUNTS))) await destroySession(dropped.token)
  writeSessionCookie(c, merged.slice(-MAX_ACCOUNTS))
  return c.redirect(redirect)
})

// "Send me a new code" from the code screen. Re-issues with the same purpose and
// payload as the previous code so a claim/join in progress isn't lost.
app.post('/resend', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const next = safeNext(body.next)
  if (!emailLooksValid(email)) return c.redirect('/login')

  const prev = await get<LoginCodeRow>('SELECT * FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [email])
  const rateLimited = 'We sent a code less than a minute ago — check your inbox (and spam).'
  if (prev) {
    const join = {
      inviteToken: prev.invite_token ?? undefined, name: prev.join_name ?? undefined, level: prev.join_level ?? undefined,
      claimSlug: prev.claim_slug ?? undefined, claimRef: prev.claim_ref ?? undefined,
    }
    if (prev.purpose === 'claim' && prev.claim_slug) {
      // Ownership proof must not be bypassable: if the slug belongs to a
      // contactable OC collective, the new code goes to its admins again.
      const info = await ocCollectiveInfo(prev.claim_slug)
      if (info.kind === 'contactable') {
        const slug = prev.claim_slug
        const ok = await issueCode(email, 'claim', join, (code) => sendOcVerificationCode(slug, code))
        return c.html(<CodeForm email={email} sentToAdmins={info.name} next={next} error={ok ? undefined : rateLimited} />)
      }
    }
    const ok = await issueCode(email, prev.purpose, join)
    return c.html(<CodeForm email={email} next={next} error={ok ? undefined : rateLimited} />)
  }

  // No previous code (already consumed & cleaned up) — plain sign-in resend.
  if ((await membershipsByEmail(email)).length === 0 && !isPlatformAdmin(email)) return c.redirect('/login')
  const ok = await issueCode(email, 'login')
  return c.html(<CodeForm email={email} next={next} error={ok ? undefined : rateLimited} />)
})

/** Sign out one account (leaving the rest signed in), or everything. */
const doLogout = async (c: Context<Env>, only?: string) => {
  const accounts = c.get('accounts')
  const leaving = only ? accounts.filter((a) => a.email === only) : accounts
  for (const a of leaving) await destroySession(a.token)
  const staying = only ? accounts.filter((a) => a.email !== only) : []
  writeSessionCookie(c, staying)
  if (staying.length > 0) return c.redirect('/?m=' + encodeURIComponent(`Signed out of ${only}.`))
  return c.redirect('/login?m=' + encodeURIComponent('Signed out.'))
}
app.post('/logout', async (c) => {
  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
  const only = String(body.email || '').toLowerCase().trim() || undefined
  return doLogout(c, only)
})
app.get('/logout', (c) => doLogout(c)) // force sign-out by URL — everything

/** All mailboxes the signed-in user belongs to, with live counts, for the
 *  collective switcher. One query; only fetched when the switcher is opened. */
app.get('/mailboxes', async (c) => {
  const emails = c.get('accounts').map((a) => a.email)
  if (emails.length === 0) return c.json({ mailboxes: [] })
  const rows = await all<{ slug: string; name: string; email: string; needs_reply: number; mine: number }>(`
    SELECT c.slug, c.name, m.email,
      (SELECT COUNT(*) FROM threads t WHERE t.collective_id = c.id AND t.status = 'needs_reply') AS needs_reply,
      (SELECT COUNT(*) FROM threads t WHERE t.collective_id = c.id AND t.assignee_member_id = m.id AND t.status IN ('needs_reply','answered')) AS mine
    FROM members m JOIN collectives c ON c.id = m.collective_id
    WHERE m.email IN (${emails.map(() => '?').join(',')}) AND m.removed_at IS NULL AND c.status = 'active'
    ORDER BY needs_reply DESC, c.name COLLATE NOCASE
  `, emails)
  // two signed-in accounts can share a collective — one entry is enough
  const seen = new Set<string>()
  const mailboxes = rows.filter((r) => !seen.has(r.slug) && seen.add(r.slug))
    .map((r) => ({ slug: r.slug, name: r.name, email: r.email, needsReply: r.needs_reply, mine: r.mine }))
  return c.json({ mailboxes, accounts: emails.length })
})

// ---------- join via invite ----------

/** Add `email` to the invite's collective (or restore a removed membership).
 *  The caller vouches for the email: either a code was just verified, or the
 *  address belongs to a signed-in account. Returns the collective, or null
 *  when the invite is dead. */
async function applyInviteJoin(inviteToken: string, email: string, name: string, level: string): Promise<Collective | null> {
  const invite = await get<Invite>('SELECT * FROM invites WHERE token = ?', [inviteToken])
  const collective = invite ? await getCollective(invite.collective_id) : undefined
  if (!invite || !collective || invite.revoked_at || invite.expires_at < now()) return null
  const existing = await getMemberIn(collective.id, email)
  if (existing) {
    await run("UPDATE members SET removed_at = NULL, name = COALESCE(NULLIF(?, ''), name), notify_level = ? WHERE id = ?",
      [name, level || existing.notify_level, existing.id])
  } else {
    let role = ['reader', 'commenter', 'member'].includes(invite.role || '') ? invite.role! : 'reader'
    if (role === 'member') {
      const senders = (await activeMembers(collective.id)).filter((m) => canSendRole(m.role)).length
      if (senders >= planLimits(collective.plan).contributors) role = 'commenter' // seats full — join with the closest free role
    }
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, email, name || email.split('@')[0], role, level || 'daily', now()])
  }

  // A reserved address goes live the moment a second person joins: recruiting
  // a real teammate is the proof-of-collective that replaced the instant
  // self-serve trial (one verified stranger per address does not scale for a
  // squatter, and is zero extra work for an actual collective).
  if (collective.status === 'pending' || collective.status === 'applied') {
    await run(
      "UPDATE collectives SET status = 'active', trial_ends_at = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ? AND status IN ('pending', 'applied')",
      [now() + 30 * 86400, now(), collective.id])
    const fresh = await getCollective(collective.id)
    if (fresh?.status === 'active') {
      for (const admin of (await activeMembers(collective.id)).filter((m) => m.role === 'admin' && m.email !== email)) {
        await sendOnboarding(fresh, admin.email).catch(() => {})
      }
      return fresh
    }
  }
  return collective
}

app.get('/join/:token', async (c) => {
  const token = c.req.param('token')
  const invite = await get<Invite>('SELECT * FROM invites WHERE token = ?', [token])
  const collective = invite ? await getCollective(invite.collective_id) : undefined
  if (!invite || !collective || invite.revoked_at || invite.expires_at < now()) {
    return c.html(
      <AuthCard title="Invite expired">
        <h1>This invite link has expired</h1>
        <p class="muted">Invite links are only valid for 24 hours. Ask your collective for a fresh one.</p>
      </AuthCard>,
    )
  }
  const inviter = invite.created_by ? await getMember(invite.created_by) : null
  const accounts = c.get('accounts')
  return c.html(
    <AuthCard title={`Join ${collective.name}`} flash={c.req.query('m')}>
      <h1>Join {collective.name}</h1>
      <p class="muted">
        {inviter ? `${memberName(inviter)} invited you to follow` : 'You were invited to follow'} email
        sent to <b>{collective.slug}@{cfg.emailDomain}</b>.
      </p>
      <p class="muted">You'll join as a <b>{ROLE_LABELS[(invite.role || 'reader') as Member['role']]}</b> — {ROLE_HINTS[(invite.role || 'reader') as Member['role']].charAt(0).toLowerCase()}{ROLE_HINTS[(invite.role || 'reader') as Member['role']].slice(1)}</p>
      <form method="post" action={`/join/${token}`}>
        <label class="lbl">Your name</label>
        <input class="input" name="name" placeholder="First name (as teammates know you)" required />
        <label class="lbl">How do you want to hear about new requests?</label>
        <div class="level-cards">
          {LEVELS.map((l, i) => (
            <label class="level-card">
              <input type="radio" name="level" value={l.value} checked={i === 0} />
              <span><b>{l.label}</b><small>{l.hint}</small></span>
            </label>
          ))}
        </div>
        <label class="lbl">Where should we send them?</label>
        {accounts.length ? (
          <div class="level-cards">
            {/* already signed in: those addresses are verified, so joining with
                one is a single click — no code, no sign-out */}
            {accounts.map((a, i) => (
              <label class="level-card">
                <input type="radio" name="account" value={a.email} checked={i === 0} />
                <span><b>{a.email}</b><small>you're signed in — no code needed</small></span>
              </label>
            ))}
            <label class="level-card">
              <input type="radio" name="account" value="other" />
              <span><b>Another email</b>
                <small>we'll send it a 6-digit code to confirm it's yours</small>
                <input class="input" type="email" name="email" placeholder="you@example.com — your personal email" autocomplete="off" />
              </span>
            </label>
          </div>
        ) : (
          <input class="input" type="email" name="email" placeholder="you@example.com — your personal email" required />
        )}
        <button class="btn" type="submit">{accounts.length ? 'Join' : 'Send me a code'}</button>
      </form>
      <p class="fineprint">Notifications go to that address. You can change the notification level any time.</p>
    </AuthCard>,
  )
})

app.post('/join/:token', async (c) => {
  const token = c.req.param('token')
  const invite = await get<Invite>('SELECT * FROM invites WHERE token = ?', [token])
  if (!invite || invite.revoked_at || invite.expires_at < now()) return c.redirect(`/join/${token}`)
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim().slice(0, 60)
  const level = ['every', 'daily', 'weekly'].includes(String(body.level)) ? String(body.level) : 'every'

  // A signed-in account is already a verified address — the session is the
  // proof, so joining with it needs no code. The cookie is checked, not the
  // form: naming someone else's email here must not work.
  const choice = String(body.account || 'other')
  if (choice !== 'other') {
    if (!c.get('accounts').some((a) => a.email === choice)) return c.redirect(`/join/${token}`)
    const joined = await applyInviteJoin(token, choice, name, level)
    if (!joined) return c.redirect(`/join/${token}`)
    return c.redirect(`/inbox/${joined.slug}?m=` + encodeURIComponent(`Welcome to ${joined.name}!`))
  }

  const email = String(body.email || '').toLowerCase().trim()
  if (!emailLooksValid(email)) return c.redirect(`/join/${token}?m=` + encodeURIComponent('Enter the email address to join with.'))
  await issueCode(email, 'join', { inviteToken: token, name, level })
  return c.html(<CodeForm email={email} />)
})

// ---------- one-click action links (from notification emails) ----------

app.get('/a/:token', async (c) => {
  const payload = verifyToken(c.req.param('token'))
  if (!payload || !['assign', 'spam', 'approve', 'approvepro', 'credits', 'mute', 'unmute'].includes(payload.a)) {
    return c.html(
      <AuthCard title="Link expired">
        <h1>This link has expired</h1>
        <p class="muted">Action links in notification emails are valid for 14 days. Open the app instead.</p>
        <a class="btn" href="/">Open collective.email</a>
      </AuthCard>,
    )
  }
  if (payload.a === 'mute' || payload.a === 'unmute') {
    const target = await getCollective(Number(payload.c))
    const mutedMember = await getMember(Number(payload.m))
    const sender = String(payload.f || '').toLowerCase().trim()
    if (!target || !mutedMember || mutedMember.collective_id !== target.id || !sender) return c.redirect('/')
    if (payload.a === 'mute') {
      await run('INSERT OR IGNORE INTO member_mutes (collective_id, member_id, match_from, created_at) VALUES (?, ?, ?, ?)',
        [target.id, mutedMember.id, sender, now()])
      const undo = `${cfg.baseUrl}/a/${signToken({ a: 'unmute', c: target.id, m: mutedMember.id, f: sender }, 60 * 60 * 24 * 90)}`
      return c.html(
        <AuthCard title="Muted">
          <h1>✓ You won't get emails from {sender} anymore</h1>
          <p class="muted">{target.slug}@{cfg.emailDomain} still receives everything they send — their messages stay in the shared inbox for the whole collective, you just won't be emailed about them. Manage this any time under Notifications.</p>
          <div class="btn-row">
            <a class="btn ghost" href={undo}>Undo</a>
            <a class="btn" href={`/inbox/${target.slug}/notifications`}>Notification settings</a>
          </div>
        </AuthCard>,
      )
    }
    await run('DELETE FROM member_mutes WHERE collective_id = ? AND member_id = ? AND match_from = ?', [target.id, mutedMember.id, sender])
    return c.html(
      <AuthCard title="Unmuted">
        <h1>✓ You'll get emails from {sender} again</h1>
        <a class="btn" href={`/inbox/${target.slug}/notifications`}>Notification settings</a>
      </AuthCard>,
    )
  }
  if (payload.a === 'credits') {
    const target = await getCollective(Number(payload.cid))
    const n = Math.min(12, Math.max(1, Number(payload.n) || 1))
    if (!target) return c.redirect('/')
    // grant tokens are one-shot: a re-click can't double-mint
    const onceKey = `granted:${payload.cid}:${payload.n}:${payload.t}`
    if (await kvGet(onceKey)) {
      return c.html(
        <AuthCard title="Already granted">
          <h1>Already granted</h1>
          <p class="muted">This grant link was already used — {target.slug} received the credits the first time.</p>
        </AuthCard>,
      )
    }
    await kvSet(onceKey, String(now()))
    await mintCredits(target.id, n, 'contribution', 'admin')
    const admins = (await activeMembers(target.id)).filter((m) => m.role === 'admin')
    const { sendCreditEmail } = await import('../notify.js')
    await sendCreditEmail(target, admins,
      `+${n} credit${n > 1 ? 's' : ''} for your contribution 🙌`,
      `Thank you for contributing to collective.email! ${n} credit${n > 1 ? 's' : ''} (${n} month${n > 1 ? 's' : ''} of service) were added to ${target.slug}@${cfg.emailDomain}. Balance: ${await creditBalance(target.id)}.`).catch(() => {})
    return c.html(
      <AuthCard title="Credits granted">
        <h1>✓ Granted {String(n)} credit{n > 1 ? 's' : ''} to {target.slug}</h1>
        <p class="muted">Their admins were notified and the balance is now {String(await creditBalance(target.id))}.</p>
        <a class="btn" href="/">Open collective.email</a>
      </AuthCard>,
    )
  }

  if (payload.a === 'approvepro') {
    const months = Math.min(24, Math.max(1, Number(payload.m) || 2))
    const target = await getCollective(Number(payload.cid))
    if (!target || target.status !== 'active') return c.redirect('/')
    const onceKey = `approvepro:${target.id}:${payload.m}:${payload.t ?? ''}`
    await run("UPDATE collectives SET plan = 'pro', trial_ends_at = ? WHERE id = ?",
      [Math.max(target.trial_ends_at || 0, now()) + months * 30 * 86400, target.id])
    void onceKey
    const admins = (await activeMembers(target.id)).filter((m) => m.role === 'admin')
    const { sendCreditEmail } = await import('../notify.js')
    await sendCreditEmail(target, admins, `${target.slug}@${cfg.emailDomain} is now on Pro 🎉`,
      `Your Pro application was approved for ${months} months — you can now connect your own domain from the Domain page. Enjoy!`).catch(() => {})
    return c.html(
      <AuthCard title="Pro approved">
        <h1>✓ {target.slug}@{cfg.emailDomain} is now Pro</h1>
        <p class="muted">{String(months)} months granted. The admins just got an email pointing them to the Domain page.</p>
        <a class="btn" href="/">Open collective.email</a>
      </AuthCard>,
    )
  }

  if (payload.a === 'approve') {
    const months = Math.min(24, Math.max(1, Number(payload.m) || 2))
    const approved = await approveApplication(Number(payload.cid), months)
    if (!approved) return c.redirect('/')
    if (approved.status === 'active') {
      const admin = await get<Member>("SELECT * FROM members WHERE collective_id = ? AND role = 'admin' ORDER BY id LIMIT 1", [approved.id])
      if (admin && approved.trial_ends_at && approved.trial_ends_at > now()) {
        await sendOnboarding(approved, admin.email).catch(() => {})
      }
    }
    return c.html(
      <AuthCard title="Approved">
        <h1>✓ {approved.slug}@{cfg.emailDomain} approved</h1>
        <p class="muted">The collective is live with a {String(Math.min(24, Math.max(1, Number(payload.m) || 2)))}-month free trial and the applicant just received their onboarding email.</p>
        <a class="btn" href="/">Open collective.email</a>
      </AuthCard>,
    )
  }

  const thread = await getThread(Number(payload.th))
  const actor = await getMember(Number(payload.by))
  const collective = thread ? await getCollective(thread.collective_id) : undefined
  if (!thread || !collective) return c.redirect('/')

  let act = ''
  let pane = payload.r ? 'reply' : 'note'
  if (payload.a === 'spam') {
    await setStatus(thread.id, 'spam', actor?.id ?? null)
    act = 'spam'
  } else {
    const target = await getMember(Number(payload.tg))
    if (!target || target.removed_at) return c.redirect('/')
    if (!thread.assignee_member_id || thread.assignee_member_id === target.id) {
      await setAssignee(thread, target.id, actor?.id ?? null, 'one_click')
      act = 'assigned'
    } else {
      // someone got there first — never override from an email link
      act = 'kept'
    }
  }
  // Land at the bottom of the thread: the outcome banner + composer are there,
  // and the whole history is one scroll up.
  const dest = `/inbox/${collective.slug}/thread/${thread.id}?act=${act}&pane=${pane}#act`
  if (!c.get('email')) return c.redirect('/login?next=' + encodeURIComponent(dest))
  return c.redirect(dest)
})

// ---------- attachments (proxied: locators are never exposed) ----------

app.get('/attachment/:id', async (c) => {
  if (c.get('accounts').length === 0) return c.redirect('/login')
  const att = await get<Attachment>('SELECT * FROM attachments WHERE id = ?', [Number(c.req.param('id'))])
  if (!att) return c.notFound()
  const msg = await get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', [att.message_id])
  const thread = msg ? await getThread(msg.thread_id) : undefined
  if (!thread || (!(await memberAmongAccounts(c, thread.collective_id)) && !platformAdminAccount(c))) return c.notFound()
  const content = await readBlob(att.path)
  if (!content) return c.notFound()
  return c.body(new Uint8Array(content), 200, {
    'Content-Type': att.content_type,
    'Content-Disposition': `attachment; filename="${att.filename.replace(/"/g, '')}"`,
  })
})

// ---------- platform admin ----------

app.get('/admin', async (c) => {
  if (c.get('accounts').length === 0) return c.redirect('/login')
  const email = platformAdminAccount(c)
  if (!email) return c.notFound()
  const waitlist = await all<{ id: number; email: string; collective_name: string | null; plan: string | null; created_at: number }>(
    'SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 200')
  const collectives = []
  for (const col of await allCollectives()) {
    collectives.push({
      ...col,
      members: (await get<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE collective_id = ? AND removed_at IS NULL', [col.id]))!.n,
      threads: (await get<{ n: number }>('SELECT COUNT(*) AS n FROM threads WHERE collective_id = ?', [col.id]))!.n,
    })
  }
  const taken = new Set(collectives.map((col) => col.slug))
  const prefillSlug = c.req.query('slug') || ''
  const prefillEmail = c.req.query('email') || ''
  const prefillPlan = c.req.query('plan') || 'collective'
  return c.html(
    <AuthCard title="Platform admin" flash={c.req.query('m')}>
      <h1>Platform admin</h1>

      <h2 class="admin-h">Create a collective</h2>
      <form method="post" action="/admin/collectives">
        <label class="lbl">Address</label>
        <span class="wl-addr"><input name="slug" value={prefillSlug} placeholder="lacooperative" required /><span class="domain">@{cfg.emailDomain}</span></span>
        <label class="lbl">Display name</label>
        <input class="input" name="name" placeholder="La Coopérative" />
        <label class="lbl">Admin's email (gets the onboarding email)</label>
        <input class="input" type="email" name="admin_email" value={prefillEmail} required />
        <label class="lbl">Plan</label>
        <select class="input" name="plan">
          <option value="duo" selected={prefillPlan === 'duo'}>Duo</option>
          <option value="collective" selected={prefillPlan === 'collective'}>Collective</option>
          <option value="pro" selected={prefillPlan === 'pro'}>Pro</option>
        </select>
        <button class="btn" type="submit">Create &amp; send onboarding email</button>
      </form>

      <h2 class="admin-h">Issue credits</h2>
      <form method="post" action="/admin/credits" class="me-form">
        <div class="btn-row">
          <input class="input" name="slug" placeholder="collective slug" required />
          <input class="input" name="amount" type="number" min="-12" max="24" value="1" style="max-width:90px" required />
        </div>
        <input class="input" name="reason" placeholder="reason (shown in their ledger)" required />
        <button class="btn small" type="submit" data-busy="Issuing…">Issue</button>
      </form>

      <h2 class="admin-h">Discount code generator</h2>
      <form method="get" action="/admin" class="assign-form">
        <input class="input" name="dslug" placeholder="collective slug" value={c.req.query('dslug') || ''} />
        <select class="input" name="dmonths" style="max-width:140px">
          {['1', '2', '3', '6', '12'].map((m) => <option value={m} selected={(c.req.query('dmonths') || '2') === m}>{m} months</option>)}
          <option value="forever" selected={c.req.query('dmonths') === 'forever'}>free forever</option>
        </select>
        <select class="input" name="dplan" style="max-width:130px">
          <option value="collective" selected={c.req.query('dplan') !== 'pro'}>Collective</option>
          <option value="pro" selected={c.req.query('dplan') === 'pro'}>Pro</option>
        </select>
        <button class="btn small ghost" type="submit">Generate</button>
      </form>
      {c.req.query('dslug') ? (() => {
        const ds = slugify(c.req.query('dslug')!)
        const dm = c.req.query('dmonths') === 'forever' ? undefined : Math.min(24, Math.max(1, Number(c.req.query('dmonths')) || 2))
        const dplan = c.req.query('dplan') === 'pro' ? 'pro' as const : 'collective' as const
        return <p class="fineprint">Code for <b>{ds}</b> ({dplan}): <code>{discountCodeFor(ds, dm, dplan)}</code> — {dm ? `${dm}-month free trial` : 'free forever (comped)'} on the {dplan} plan, for exactly that address.</p>
      })() : null}

      <h2 class="admin-h">Collectives ({collectives.length})</h2>
      <div class="admin-list">
        {collectives.map((col) => (
          <div class="admin-row">
            <b>{col.slug}@{cfg.emailDomain}</b>
            <small>{col.name} · {col.plan} · {col.members} members · {col.threads} threads · {relTime(col.created_at)}</small>
          </div>
        ))}
      </div>

      <h2 class="admin-h">Waiting list ({waitlist.length})</h2>
      <div class="admin-list">
        {waitlist.map((w) => (
          <div class="admin-row">
            <b>{w.collective_name || '(no name)'}</b>
            <small>{w.email} · {w.plan} · {relTime(w.created_at)}</small>
            {w.collective_name && taken.has(w.collective_name)
              ? <small>✓ created</small>
              : <a href={`/admin?slug=${encodeURIComponent(w.collective_name || '')}&email=${encodeURIComponent(w.email)}&plan=${w.plan || 'collective'}`}>create ↑</a>}
          </div>
        ))}
      </div>
    </AuthCard>,
  )
})

app.post('/admin/credits', async (c) => {
  const email = platformAdminAccount(c)
  if (!email) return c.notFound()
  const body = await c.req.parseBody()
  const target = await getCollectiveBySlug(slugify(String(body.slug || '')))
  const amount = Math.min(24, Math.max(-12, Math.round(Number(body.amount) || 0)))
  const reason = String(body.reason || '').trim().slice(0, 120)
  if (!target || !amount || !reason) return c.redirect('/admin?m=' + encodeURIComponent('Need an existing slug, a non-zero amount, and a reason.'))
  await mintCredits(target.id, amount, reason, 'admin')
  if (amount > 0) {
    const admins = (await activeMembers(target.id)).filter((m) => m.role === 'admin')
    const { sendCreditEmail } = await import('../notify.js')
    await sendCreditEmail(target, admins, `+${amount} credit${amount > 1 ? 's' : ''} for ${target.slug}@${cfg.emailDomain}`,
      `${reason} — ${amount} credit${amount > 1 ? 's' : ''} added. Balance: ${await creditBalance(target.id)}.`).catch(() => {})
  }
  return c.redirect('/admin?m=' + encodeURIComponent(`${amount > 0 ? '+' : ''}${amount} credits → ${target.slug} (balance ${await creditBalance(target.id)})`))
})

app.post('/admin/collectives', async (c) => {
  const email = platformAdminAccount(c)
  if (!email) return c.notFound()
  const body = await c.req.parseBody()
  const slug = slugify(String(body.slug || ''))
  const name = String(body.name || '').trim().slice(0, 80) || slug
  const adminEmail = String(body.admin_email || '').toLowerCase().trim()
  const plan = ['duo', 'collective', 'pro'].includes(String(body.plan)) ? String(body.plan) : 'collective'
  try {
    const collective = await createCollective(slug, name, plan)
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, adminEmail, adminEmail.split('@')[0], 'admin', 'every', now()])
    await sendOnboarding(collective, adminEmail)
    return c.redirect('/admin?m=' + encodeURIComponent(`${slug}@${cfg.emailDomain} created — onboarding email sent to ${adminEmail}.`))
  } catch (err) {
    return c.redirect('/admin?m=' + encodeURIComponent(err instanceof Error ? err.message : 'Could not create collective'))
  }
})

// ---------- tenant: inbox ----------

const FILTERS: Record<string, { label: string; where: string }> = {
  all: { label: 'Inbox', where: "t.status != 'spam'" },
  needs_reply: { label: 'Needs reply', where: "t.status = 'needs_reply'" },
  mine: { label: 'Mine', where: "t.assignee_member_id = ? AND t.status IN ('needs_reply','answered')" },
  answered: { label: 'Answered', where: "t.status = 'answered'" },
  closed: { label: 'Closed', where: "t.status = 'closed'" },
  spam: { label: 'Spam', where: "t.status = 'spam'" },
}

// FILTERS.mine uses one positional `?` (the member id); build args accordingly
function filterArgs(key: string, memberId: number): (string | number)[] {
  return key === 'mine' ? [memberId] : []
}

app.get('/inbox/:addr', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const f = FILTERS[c.req.query('f') || 'all'] ? (c.req.query('f') || 'all') : 'all'
  const tag = c.req.query('tag') || ''
  const q = (c.req.query('q') || '').trim()

  let where = `t.collective_id = ? AND (${FILTERS[f].where})`
  const args: (string | number)[] = [collective.id, ...filterArgs(f, member.id)]
  if (tag) {
    where += ' AND EXISTS (SELECT 1 FROM thread_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.thread_id = t.id AND tg.name = ?)'
    args.push(tag)
  }
  if (q) {
    where += ' AND (t.subject LIKE ? OR t.counterpart_email LIKE ? OR t.counterpart_name LIKE ?)'
    args.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  const sortQ = c.req.query('sort')
  const sort = sortQ === 'newest' || sortQ === 'oldest' ? sortQ : f === 'needs_reply' ? 'oldest' : 'newest'
  const order = sort === 'oldest' ? 't.last_message_at ASC' : 't.last_message_at DESC'

  // round-trip 1: thread list + all sidebar data in ONE batched DB request
  const filterKeys = Object.keys(FILTERS)
  const batch1 = await batchAll([
    { sql: `SELECT t.* FROM threads t WHERE ${where} ORDER BY ${order} LIMIT 200`, args },
    ...filterKeys.map((key) => ({
      sql: `SELECT COUNT(*) AS n FROM threads t WHERE t.collective_id = ? AND (${FILTERS[key].where})`,
      args: [collective.id, ...filterArgs(key, member.id)],
    })),
    {
      sql: `SELECT tg.name, COUNT(*) AS n FROM tags tg
            JOIN thread_tags tt ON tt.tag_id = tg.id
            JOIN threads t ON t.id = tt.thread_id AND t.status != 'spam'
            WHERE tg.collective_id = ?
            GROUP BY tg.id ORDER BY n DESC, tg.name LIMIT 20`,
      args: [collective.id],
    },
    { sql: 'SELECT * FROM members WHERE collective_id = ?', args: [collective.id] },
  ])
  const threads = batch1[0] as Thread[]
  const counts: Record<string, number> = {}
  filterKeys.forEach((key, i) => { counts[key] = (batch1[1 + i][0] as { n: number }).n })
  const tagRows = batch1[1 + filterKeys.length] as { name: string; n: number }[]
  const members = new Map((batch1[2 + filterKeys.length] as Member[]).map((m) => [m.id, m]))

  // round-trip 2: per-thread previews for the listed threads
  const ids = threads.map((th) => th.id)
  const ph = ids.map(() => '?').join(',')
  const [lastMsgRows, threadTagRows] = ids.length ? await batchAll([
    { sql: `SELECT * FROM messages WHERE id IN (SELECT MAX(id) FROM messages WHERE thread_id IN (${ph}) GROUP BY thread_id)`, args: ids },
    { sql: `SELECT tt.thread_id, t.id, t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id IN (${ph}) ORDER BY t.name`, args: ids },
  ]) : [[], []]
  const lastMsgs = new Map((lastMsgRows as Message[]).map((m) => [m.thread_id, m]))
  void lastMsgs
  const [seenAt, extras] = await Promise.all([
    readsForMember(member.id, threads.map((th) => th.id)),
    threadListExtras(threads.map((th) => th.id)),
  ])
  const tagsMap = new Map<number, { id: number; name: string }[]>()
  for (const r of threadTagRows as { thread_id: number; id: number; name: string }[]) {
    if (!tagsMap.has(r.thread_id)) tagsMap.set(r.thread_id, [])
    tagsMap.get(r.thread_id)!.push({ id: r.id, name: r.name })
  }

  const sidebar = (
    <nav class="nav">
      {Object.entries(FILTERS).filter(([k]) => k !== 'spam' || counts.spam > 0).map(([key, def]) => (
        <a class={`nav-item ${f === key && !tag ? 'active' : ''}`} href={`${base}?f=${key}`}>
          {def.label} <span class="count">{counts[key]}</span>
        </a>
      ))}
      {tagRows.length > 0 ? <div class="label">Tags</div> : null}
      {tagRows.map((tr) => (
        <a class={`nav-item ${tag === tr.name ? 'active' : ''}`} href={`${base}?f=all&tag=${encodeURIComponent(tr.name)}`}>
          # {tr.name} <span class="count">{tr.n}</span>
        </a>
      ))}
    </nav>
  )

  return c.html(
    <Shell member={member} collective={collective} active="inbox" flash={c.req.query('m')} sidebar={sidebar}>
      <div class="topbar">
        <form method="get" action={base} class="search-form">
          <input type="hidden" name="f" value={f} />
          {tag ? <input type="hidden" name="tag" value={tag} /> : null}
          <input type="hidden" name="sort" value={sort} />
          <input class="search" name="q" value={q} placeholder="Search threads, senders…" />
        </form>
        <button class="icon-btn" type="button" data-dialog="#sort-modal" aria-label="Sorting options" title="Sorting">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 19V5M4 9l4-4 4 4M16 5v14M12 15l4 4 4-4" />
          </svg>
        </button>
      </div>
      <dialog id="sort-modal" class="modal">
        <h2>Sort threads</h2>
        <form method="get" action={base} class="modal-form">
          <input type="hidden" name="f" value={f} />
          {tag ? <input type="hidden" name="tag" value={tag} /> : null}
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <label class="level-card">
            <input type="radio" name="sort" value="oldest" checked={sort === 'oldest'} />
            <span><b>Oldest first</b><small>Longest-waiting conversations on top.</small></span>
          </label>
          <label class="level-card">
            <input type="radio" name="sort" value="newest" checked={sort === 'newest'} />
            <span><b>Newest first</b><small>Latest activity on top.</small></span>
          </label>
          <div class="btn-row">
            <button class="btn small" type="submit">Apply</button>
            <button class="btn small ghost" type="button" data-close>Cancel</button>
          </div>
        </form>
      </dialog>
      <div class="rows">
        {threads.length === 0 ? (
          <div class="empty-state">
            {f === 'needs_reply'
              ? '🎉 Nothing needs a reply. The inbox is at zero.'
              : f === 'all'
                ? `No conversations yet — email ${collective.slug}@${cfg.emailDomain} to start one.`
                : 'No threads here.'}
          </div>
        ) : threads.map((th) => (
          <ThreadRow base={base} thread={th} members={members}
            unread={(seenAt.get(th.id) ?? 0) < (th.last_message_at ?? 0)}
            lastMsg={extras.lastMsgs.get(th.id)} participants={extras.participants.get(th.id)}
            noteCount={extras.noteCounts.get(th.id)} tags={tagsMap.get(th.id)} />
        ))}
      </div>
    </Shell>,
  )
})

// ---------- the one way a thread appears in a list ----------

/** Row-sized date: "9 Aug", year only when it isn't this one. */
const shortDate = (ts: number | null | undefined) => ts
  ? new Date(ts * 1000).toLocaleDateString('en-GB', new Date(ts * 1000).getFullYear() === new Date().getFullYear()
      ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  : '—'

/** Everything a thread list needs beyond the threads themselves, batched:
 *  last message, who participated (replies + notes), and note counts. */
async function threadListExtras(threadIds: number[]): Promise<{
  lastMsgs: Map<number, Message>; participants: Map<number, number[]>; noteCounts: Map<number, number>
}> {
  if (threadIds.length === 0) return { lastMsgs: new Map(), participants: new Map(), noteCounts: new Map() }
  const ph = threadIds.map(() => '?').join(',')
  const [partRows, noteRows] = await Promise.all([
    all<{ thread_id: number; mid: number }>(
      `SELECT DISTINCT thread_id, sent_by_member_id AS mid FROM messages WHERE thread_id IN (${ph}) AND sent_by_member_id IS NOT NULL
       UNION SELECT DISTINCT thread_id, member_id AS mid FROM notes WHERE thread_id IN (${ph})`, [...threadIds, ...threadIds]),
    all<{ thread_id: number; n: number }>(
      `SELECT thread_id, COUNT(*) AS n FROM notes WHERE thread_id IN (${ph}) GROUP BY thread_id`, threadIds),
  ])
  const participants = new Map<number, number[]>()
  for (const r of partRows) participants.set(r.thread_id, [...(participants.get(r.thread_id) ?? []), r.mid])
  return {
    lastMsgs: await lastMessageByThread(threadIds),
    participants,
    noteCounts: new Map(noteRows.map((r) => [r.thread_id, r.n])),
  }
}

/** THE thread row. Two lines per row, each column a stacked pair:
 *
 *    read | first date (dim) | name  | subject            | assignee     | status
 *         | LAST DATE        | email | last-message line  | participants | n notes
 *
 *  `sender={false}` drops the name/email column — in a contact view every
 *  row is the same person. Every list renders this, so a thread reads the
 *  same everywhere. */
const ThreadRow: FC<{
  base: string; thread: Thread; unread: boolean; members: Map<number, Member>
  lastMsg?: Message; participants?: number[]; noteCount?: number
  tags?: { id: number; name: string }[]; sender?: boolean
}> = (p) => {
  const th = p.thread
  const showSender = p.sender !== false
  const sameDay = shortDate(th.first_message_at) === shortDate(th.last_message_at)
  // a REAL two-row grid (named areas), so line 1 aligns across every column
  // and line 2 does too — stacked cells only pretend to be rows
  return (
    <a class={`row${showSender ? '' : ' no-sender'}${p.unread ? ' unread' : ''}`} href={`${p.base}/thread/${th.id}`}>
      <span class={`dot ${th.status === 'needs_reply' ? 'open' : 'done'}`} />
      <span class="r-d1">{shortDate(th.first_message_at)}</span>
      <b class="r-d2">{sameDay ? '' : shortDate(th.last_message_at)}</b>
      {showSender ? <span class="r-name">{th.counterpart_name || th.counterpart_email || '—'}</span> : null}
      {showSender ? <span class="r-mail">{th.counterpart_email}</span> : null}
      <span class="r-subj">{th.subject}{(p.tags ?? []).slice(0, 2).map((tg) => <span class="chip">#{tg.name}</span>)}</span>
      <span class="r-snip">{excerpt(p.lastMsg?.body_text || '', 110)}</span>
      <span class="r-meta1">
        <AssigneeChip thread={th} members={p.members} />
        <StatusChip status={th.status} />
      </span>
      <span class="r-meta2">
        <span class="participants">{(p.participants ?? []).slice(0, 4).map((mid) => <Avatar member={p.members.get(mid)} />)}</span>
        {p.noteCount ? <span class="r-notes">⌁ {p.noteCount} note{p.noteCount === 1 ? '' : 's'}</span> : null}
      </span>
    </a>
  )
}

// ---------- contacts: everyone the collective has talked with ----------

const contactUrl = (base: string, email: string) => `${base}/contact/${encodeURIComponent(email)}`

app.get('/inbox/:addr/contacts', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  // one cheap scan, aggregated here: most recent name wins, spam stays out
  const rows = await all<{ counterpart_email: string; counterpart_name: string | null; status: string; last_message_at: number | null }>(
    "SELECT counterpart_email, counterpart_name, status, last_message_at FROM threads WHERE collective_id = ? AND status != 'spam' AND counterpart_email IS NOT NULL ORDER BY last_message_at DESC",
    [collective.id])
  const contacts = new Map<string, { email: string; name: string; threads: number; open: number; last: number }>()
  for (const r of rows) {
    const key = r.counterpart_email.toLowerCase()
    const entry = contacts.get(key) ?? { email: r.counterpart_email, name: '', threads: 0, open: 0, last: 0 }
    entry.threads++
    if (r.status === 'needs_reply') entry.open++
    if (!entry.name && r.counterpart_name) entry.name = r.counterpart_name // rows arrive newest-first
    entry.last = Math.max(entry.last, r.last_message_at ?? 0)
    contacts.set(key, entry)
  }
  const list = [...contacts.values()].sort((a, b) => b.last - a.last)

  return c.html(
    <Shell member={member} collective={collective} title="Contacts" active="contacts" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Contacts</h1>
        <p class="muted">Everyone this inbox has a conversation with — tap one to see your whole history together.</p>
        <div class="rows">
          {list.length === 0 ? (
            <div class="empty-state">Nobody yet — contacts appear with the first conversation.</div>
          ) : list.map((p) => (
            <a class="row contact-row" href={contactUrl(base, p.email)}>
              <span class="avatar" aria-hidden="true">{initials(p.name, p.email)}</span>
              <span class="from">
                {p.name || p.email.split('@')[0]}
                <small>{p.email}</small>
              </span>
              <span class="subj">
                {p.threads} conversation{p.threads === 1 ? '' : 's'}
                {p.open ? <span class="snippet"> — {p.open} waiting for a reply</span> : null}
              </span>
              <span class="age">{relTime(p.last)}</span>
            </a>
          ))}
        </div>
      </div>
    </Shell>,
  )
})

app.get('/inbox/:addr/contact/:email', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const email = decodeURIComponent(c.req.param('email') || '').toLowerCase().trim()
  if (!email) return c.redirect(`${base}/contacts`)

  const threads = await all<Thread>(
    "SELECT * FROM threads WHERE collective_id = ? AND lower(counterpart_email) = ? AND status != 'spam' ORDER BY last_message_at DESC",
    [collective.id, email])
  const members = await memberMap(collective.id)
  const [extras, seenAt] = await Promise.all([
    threadListExtras(threads.map((th) => th.id)),
    readsForMember(member.id, threads.map((th) => th.id)),
  ])
  const name = threads.find((th) => th.counterpart_name)?.counterpart_name || email.split('@')[0]
  const open = threads.filter((th) => th.status === 'needs_reply').length

  return c.html(
    <Shell member={member} collective={collective} title={name} active="contacts" flash={c.req.query('m')} sidebar={
      <nav class="nav"><a class="nav-item" href={`${base}/contacts`}>← All contacts</a></nav>
    }>
      <div class="page">
        <div class="contact-head">
          <span class="avatar contact-avatar" aria-hidden="true">{initials(name, email)}</span>
          <div class="contact-id">
            <h1>{name}</h1>
            <p class="muted">{email} · {threads.length} conversation{threads.length === 1 ? '' : 's'}{open ? ` · ${open} waiting for a reply` : ''}</p>
          </div>
          {canSendRole(member.role) ? (
            <a class="btn small ghost" href={`${base}/compose?to=${encodeURIComponent(email)}`}>✉ New email</a>
          ) : null}
        </div>
        <div class="rows">
          {threads.length === 0 ? (
            <div class="empty-state">No conversations with {email} yet.</div>
          ) : threads.map((th) => (
            <ThreadRow base={base} thread={th} members={members} sender={false}
              unread={(seenAt.get(th.id) ?? 0) < (th.last_message_at ?? 0)}
              lastMsg={extras.lastMsgs.get(th.id)} participants={extras.participants.get(th.id)}
              noteCount={extras.noteCounts.get(th.id)} />
          ))}
        </div>
      </div>
    </Shell>,
  )
})

// ---------- tenant: thread ----------

type TimelineItem =
  | { kind: 'msg'; ts: number; msg: Message }
  | { kind: 'note'; ts: number; id: number; member_id: number; body: string }
  | { kind: 'event'; ts: number; ev: { actor_member_id: number | null; type: string; data_json: string | null } }

async function threadOf(c: Context<Env>, t: { collective: Collective }): Promise<Thread | undefined> {
  const thread = await getThread(Number(c.req.param('id')))
  return thread && thread.collective_id === t.collective.id ? thread : undefined
}

app.get('/inbox/:addr/thread/:id', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()

  // one batched round-trip for everything the page needs (except attachments,
  // which depend on the message ids)
  const batch = await batchAll([
    { sql: 'SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at, id', args: [thread.id] },
    { sql: 'SELECT * FROM notes WHERE thread_id = ? ORDER BY created_at', args: [thread.id] },
    { sql: 'SELECT * FROM events WHERE thread_id = ? ORDER BY created_at', args: [thread.id] },
    { sql: 'SELECT t.id, t.name FROM tags t JOIN thread_tags tt ON tt.tag_id = t.id WHERE tt.thread_id = ? ORDER BY t.name', args: [thread.id] },
    { sql: 'SELECT * FROM members WHERE collective_id = ?', args: [collective.id] },
    { sql: 'SELECT nm.note_id, nm.member_id FROM note_mentions nm JOIN notes n ON n.id = nm.note_id WHERE n.thread_id = ?', args: [thread.id] },
  ])
  const msgs = batch[0] as Message[]
  const notes = batch[1] as { id: number; member_id: number; body: string; created_at: number }[]
  const allEvents = batch[2] as { actor_member_id: number | null; type: string; data_json: string | null; created_at: number }[]
  const tags = batch[3] as { id: number; name: string }[]
  const members = new Map((batch[4] as Member[]).map((m) => [m.id, m]))
  // notes that named *you* — worth a marker when you land on a long thread
  const mentionsMe = new Set((batch[5] as { note_id: number; member_id: number }[])
    .filter((r) => r.member_id === member.id).map((r) => r.note_id))
  const attsMap = await attachmentsByMessage(msgs.map((m) => m.id))
  // opening the page is seeing it — recorded before rendering so the sidebar
  // this response carries already includes the viewer
  await markThreadSeen(thread.id, member.id, 'web')
  const reads = await threadReads(thread.id)
  const otherThreads = thread.counterpart_email ? await all<Thread>(
    "SELECT * FROM threads WHERE collective_id = ? AND lower(counterpart_email) = lower(?) AND id != ? AND status != 'spam' ORDER BY last_message_at DESC LIMIT 5",
    [collective.id, thread.counterpart_email, thread.id]) : []
  const firstInboundId = msgs.find((m) => m.direction === 'inbound' && m.from_email && m.from_email.toLowerCase() === (thread.counterpart_email || '').toLowerCase())?.id
  const otherCount = thread.counterpart_email ? Number((await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM threads WHERE collective_id = ? AND lower(counterpart_email) = lower(?) AND id != ? AND status != 'spam'",
    [collective.id, thread.counterpart_email, thread.id]))?.n ?? 0) : 0
  // who did something on the thread (replied or left a note), for the sidebar
  const contributed = new Set<number>([
    ...msgs.filter((m) => m.sent_by_member_id).map((m) => m.sent_by_member_id!),
    ...notes.map((n) => n.member_id),
  ])
  // a composed-but-unsent thread: the reply pane becomes the draft editor
  const draftMsg = thread.status === 'draft' ? msgs.find((m) => m.direction === 'outbound' && !m.sent_at) : undefined
  const events = allEvents.filter((e) => e.type !== 'replied')
  const lastAssignEvent = [...allEvents].reverse().find((e) => e.type === 'assigned' || e.type === 'unassigned')
  const activeList = [...members.values()].filter((m) => !m.removed_at).sort((a, b) => memberName(a).localeCompare(memberName(b)))
  const assignee = thread.assignee_member_id ? members.get(thread.assignee_member_id) : null
  const counterpartFirst = (thread.counterpart_name || thread.counterpart_email || 'the sender').split(' ')[0]
  // reflects the actual From: verified custom domain, else slug@collective.email
  const collectiveAddr = outboundFrom(collective).fromAddress
  // matching rule for this thread (newsletters & co.) — drives HTML display
  const rule = await matchingRule(collective.id, thread.counterpart_email, thread.subject)
  // Cc sticks to the thread (everyone keeps being copied) but stays editable
  const threadCc: string[] = JSON.parse(thread.cc_json || '[]')
  const signature = signatureFor(collective, member)

  const items: TimelineItem[] = [
    ...msgs.map((m): TimelineItem => ({ kind: 'msg', ts: m.sent_at || m.created_at, msg: m })),
    ...notes.map((n): TimelineItem => ({ kind: 'note', ts: n.created_at, id: n.id, member_id: n.member_id, body: n.body })),
    ...events.map((e): TimelineItem => ({ kind: 'event', ts: e.created_at, ev: e })),
  ].sort((a, b) => a.ts - b.ts)

  const groups: (Message | TimelineItem[])[] = []
  for (const item of items) {
    if (item.kind === 'msg') groups.push(item.msg)
    else {
      const last = groups[groups.length - 1]
      if (Array.isArray(last)) last.push(item)
      else groups.push([item])
    }
  }

  // WhatsApp-style: under each timeline entry, who has read up to there —
  // a reader sits under the last item older than their last opening
  const groupTs = groups.map((g) => Array.isArray(g) ? Math.max(...g.map((i) => i.ts)) : (g.sent_at || g.created_at))
  const seenUpTo = new Map<number, ThreadRead[]>()
  for (const r of reads) {
    let idx = -1
    for (let i = 0; i < groupTs.length; i++) if (groupTs[i] <= r.last_seen_at) idx = i
    if (idx >= 0) seenUpTo.set(idx, [...(seenUpTo.get(idx) ?? []), r])
  }
  const SeenMarker = ({ at }: { at: number }) => {
    const rs = seenUpTo.get(at)
    if (!rs?.length) return null
    return (
      <div class="seen-row" title={rs.map((r: ThreadRead) => `${memberName(members.get(r.member_id))} · ${relTime(r.last_seen_at)}`).join('\n')}>
        <span class="seen-eye" aria-hidden="true">✓</span>
        {rs.map((r: ThreadRead) => <Avatar member={members.get(r.member_id)} />)}
        <small>seen {rs.length === 1 ? `by ${memberName(members.get(rs[0].member_id))} ${relTime(rs[0].last_seen_at)}` : `by ${rs.length} people`}</small>
      </div>
    )
  }

  return c.html(
    <Shell member={member} collective={collective} active="inbox" flash={c.req.query('m')}
      bundle={member.role === 'reader' ? undefined : 'composer.js'} sidebar={
      <nav class="nav"><a class="nav-item" href={`${base}`}>← Back to inbox</a></nav>
    }>
      <div class="thread-wrap">
        <div class="thread-main">
          <div class="thread-top">
            <h1>{thread.subject}</h1>
            <StatusChip status={thread.status} />
            {rule?.close && !thread.assignee_member_id
              ? <span class="chip" title={`Filed by ${rule.tag ? `the #${rule.tag}` : 'a'} rule — no assignment needed`}>⚡ auto-filed</span>
              : <AssigneeChip thread={thread} members={members} />}
            {tags.map((tg) => <span class="chip">#{tg.name}</span>)}
          </div>

          <div class="tl">
            {groups.map((g, gi) => <>
              {Array.isArray(g) ? (
                <div class="internal">
                  <span class="internal-tag">⌁ Internal — not visible to {counterpartFirst}</span>
                  {g.map((item) =>
                    item.kind === 'note' ? (
                      <div class={`note${mentionsMe.has(item.id) ? ' note-mine' : ''}`}>
                        <div class="note-head">
                          <Avatar member={members.get(item.member_id)} />
                          <b>{memberName(members.get(item.member_id))}</b>
                          {mentionsMe.has(item.id) ? <span class="chip mention-chip">@ mentions you</span> : null}
                          <span class="when">{fmtDateTime(item.ts)}</span>
                        </div>
                        <p>
                          {noteParts(item.body, activeList).map((p) =>
                            'mention' in p
                              ? <span class={`mention${p.member.id === member.id ? ' mention-me' : ''}`} title={p.member.email}>{p.mention}</span>
                              : p.text)}
                        </p>
                      </div>
                    ) : item.kind === 'event' ? (
                      <div class="event">{eventText(item.ev, members)} · {relTime(item.ts)}</div>
                    ) : null,
                  )}
                </div>
              ) : (
                <div class={`msg ${g.direction}`}>
                  <div class="msg-head">
                    <Avatar member={g.sent_by_member_id ? members.get(g.sent_by_member_id) : null} empty={g.direction === 'inbound'} />
                    <span class="who">
                      {g.direction === 'outbound' || !g.from_email ? (
                        <b>{g.direction === 'outbound' ? collective.name : g.from_name || g.from_email}</b>
                      ) : (
                        <a class="sender-link" href={contactUrl(base, g.from_email)}
                          title={otherCount > 0 && g.from_email.toLowerCase() === thread.counterpart_email?.toLowerCase()
                            ? `${otherCount} other thread${otherCount === 1 ? '' : 's'} with ${g.from_name || g.from_email} — see them all`
                            : `All conversations with ${g.from_name || g.from_email}`}>
                          <b>{g.from_name || g.from_email}</b>
                        </a>
                      )}
                      {/* the contact view has to announce itself — a count next
                          to the name is what makes it discoverable */}
                      {otherCount > 0 && g.direction === 'inbound' && g.id === firstInboundId ? (
                        <a class="chip other-chip" href={contactUrl(base, g.from_email!)}>{otherCount} other thread{otherCount === 1 ? '' : 's'}</a>
                      ) : null}
                      <small>{g.from_email} → {JSON.parse(g.to_json || '[]').join(', ')}</small>
                    </span>
                    <span class="msg-meta">
                      <span class="when">{fmtDateTime(g.sent_at)}</span>
                      {g.direction === 'outbound' && g.sent_by_member_id ? (
                        <small class="sentby">sent by {memberName(members.get(g.sent_by_member_id))}</small>
                      ) : null}
                    </span>
                    {canSendRole(member.role) ? (
                      <details class="fwd">
                        <summary title="Forward" aria-label="Forward this message">↪</summary>
                        <form method="post" action={`${base}/thread/${thread.id}/forward`}>
                          <input type="hidden" name="message_id" value={String(g.id)} />
                          <input class="input small" type="email" name="to" placeholder="colleague@example.com" required />
                          <input class="input small" name="note" placeholder="Add a note (optional)" />
                          <button class="btn small ghost" type="submit" data-busy="Forwarding…">Forward</button>
                        </form>
                      </details>
                    ) : null}
                  </div>
                  {rule?.close && g.direction === 'inbound' && g.body_html ? (
                    // Rule-filed mail renders its real (sanitized) HTML in a
                    // sandboxed frame: no scripts, opaque to the app, links
                    // open in a new tab.
                    <iframe class="msg-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc={emailHtmlDocument(g.body_html)}></iframe>
                  ) : (() => {
                    const q = splitQuotedTail(g.body_text || '')
                    return (
                      <div class="msg-body">
                        {q.main || '(no text content)'}
                        {q.quoted ? (
                          <details class="qhist">
                            <summary>Show quoted history</summary>
                            {'\n'}{q.quoted}
                          </details>
                        ) : null}
                      </div>
                    )
                  })()}
                  {g.direction === 'outbound' && !g.sent_by_member_id && g.from_email
                    && g.from_email !== collectiveAddr && g.from_email !== `${collective.slug}@${cfg.emailDomain}`
                    && member.role === 'admin' ? (
                    <form class="link-sender" method="post" action={`/inbox/${collective.slug}/thread/${thread.id}/sender`}>
                      <input type="hidden" name="email" value={g.from_email} />
                      <span>This answer came from <b>{g.from_email}</b>, which isn't linked to any member.</span>
                      <select class="input" name="member_id">
                        {activeList.map((m) => <option value={String(m.id)}>{memberName(m)}</option>)}
                      </select>
                      <button class="btn small" name="act" value="link" type="submit" data-busy="Linking…">It's them — link</button>
                      <button class="btn small ghost" name="act" value="external" type="submit" data-busy="Saving…">Not a teammate</button>
                    </form>
                  ) : null}
                  {(attsMap.get(g.id) || []).length > 0 ? (
                    <div class="msg-atts">
                      {(attsMap.get(g.id) || []).map((a) =>
                        a.content_type.startsWith('image/') ? (
                          <a class="att-img-link" href={`/attachment/${a.id}`} title={a.filename}>
                            <img class="att-img" src={`/attachment/${a.id}`} alt={a.filename} loading="lazy" />
                          </a>
                        ) : (
                          <a class="chip att" href={`/attachment/${a.id}`}>📎 {a.filename} <small>{Math.ceil(a.size / 1024)} KB</small></a>
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              )}
              <SeenMarker at={gi} />
            </>)}
          </div>

          {(() => {
            const act = c.req.query('act')
            if (!act) return null
            const lastAssign = [...allEvents].reverse().find((e) => e.type === 'assigned')
            const data = lastAssign?.data_json ? JSON.parse(lastAssign.data_json) : {}
            const byName = lastAssign?.actor_member_id ? memberName(members.get(lastAssign.actor_member_id)) : 'someone'
            const toName = data.to ? memberName(members.get(data.to)) : 'someone'
            return (
              <div class="act-banner" id="act">
                {act === 'assigned' ? <p><b>✓ Assigned to {assignee ? memberName(assignee) : toName}</b>{assignee?.id === member.id ? ' (you)' : ''}.</p>
                  : act === 'kept' && lastAssign ? <p><b>⚠ {byName} already assigned this to {toName}</b> {relTime(lastAssign.created_at)} — nothing was changed.</p>
                  : act === 'spam' ? <p><b>🚫 Marked as spam.</b> It won't count as needing a reply.</p>
                  : null}
                {member.role !== 'reader' ? (
                  <form method="post" action={`${base}/thread/${thread.id}/assign`} class="assign-form">
                    <select name="member_id">
                      <option value="">— Unassigned —</option>
                      {activeList.map((m) => (
                        <option value={String(m.id)} selected={m.id === thread.assignee_member_id}>
                          {memberName(m)}{m.id === member.id ? ' (you)' : ''}
                        </option>
                      ))}
                    </select>
                    <button class="btn small ghost" type="submit">Change assignment</button>
                  </form>
                ) : null}
                <p class="fineprint">Add a private note below — only members see it. Scroll up for the full history.</p>
              </div>
            )
          })()}

          <div class="typing" id="typing" data-url={`${base}/thread/${thread.id}/typing`} hidden></div>

          {member.role === 'reader' ? (
            <div class="reader-note">👀 You have read access. Ask an admin to let you comment or send.</div>
          ) : (
          <div class="composer" id="composer">
            {canSendRole(member.role) ? (
              <div class="tabs">
                <button class="tab on" data-tab="reply" type="button">{draftMsg ? '✉ Edit draft' : `✉ Reply to ${counterpartFirst}`}</button>
                <button class="tab" data-tab="note" type="button">⌁ Internal note</button>
              </div>
            ) : null}
            {canSendRole(member.role) && draftMsg ? (
            <form method="post" action={`${base}/thread/${thread.id}/draft`} data-pane="reply">
              <div class="to note-to">✎ Draft — nothing has been sent yet. Teammates with this link can add internal notes below.</div>
              <div class="c-row">
                <span class="c-k">To</span>
                <input class="c-in" name="to" value={JSON.parse(draftMsg.to_json || '[]').join(', ')} autocomplete="off" spellcheck={false} />
              </div>
              {(() => {
                const dcc = JSON.parse(draftMsg.cc_json || '[]').join(', ')
                const dbcc = JSON.parse(draftMsg.bcc_json || '[]').join(', ')
                return (
                  // collapsed unless something is already in there — hiding a
                  // recipient the draft actually has would be a nasty surprise
                  <details class="ccb" open={Boolean(dcc || dbcc)}>
                    <summary>Cc/Bcc, From: {collectiveAddr}</summary>
                    <div class="c-row"><span class="c-k">Cc</span><input class="c-in" name="cc" value={dcc} autocomplete="off" spellcheck={false} /></div>
                    <div class="c-row"><span class="c-k">Bcc</span><input class="c-in" name="bcc" value={dbcc} autocomplete="off" spellcheck={false} /></div>
                    <div class="c-row"><span class="c-k">From</span><span class="c-static">{collectiveAddr}</span></div>
                  </details>
                )
              })()}
              <div class="c-row">
                <span class="c-k">Subject</span>
                <input class="c-in" name="subject" value={thread.subject} maxlength={200} />
              </div>
              <textarea name="body" rows={8}>{draftMsg.body_text || ''}</textarea>
              <div class="actions">
                <span class="send-stack">
                  <button class="btn send-btn" type="submit" name="action" value="send" data-busy="Sending…">Send</button>
                  <span class="fineprint send-note"><span>as <b>{collectiveAddr}</b></span></span>
                </span>
                <button class="btn ghost" type="submit" name="action" value="save" data-busy="Saving…">Save changes</button>
              </div>
            </form>
            ) : null}
            {canSendRole(member.role) && !draftMsg ? (
            <form method="post" action={`${base}/thread/${thread.id}/reply`} data-pane="reply" enctype="multipart/form-data">
              <div class="c-row"><span class="c-k">To</span><span class="c-static c-to">{thread.counterpart_email || 'unknown'}</span></div>
              {/* same quiet line as compose; open when the thread carries a
                  sticky Cc — hiding a recipient that will be copied would lie */}
              <details class="ccb" open={threadCc.length > 0}>
                <summary>Cc/Bcc, From: {collectiveAddr}</summary>
                <div class="c-row"><span class="c-k">Cc</span><input class="c-in" name="cc" value={threadCc.join(', ')} autocomplete="off" spellcheck={false} /></div>
                <div class="c-row"><span class="c-k">Bcc</span><input class="c-in" name="bcc" autocomplete="off" spellcheck={false} /></div>
                <div class="c-row"><span class="c-k">From</span><span class="c-static">{collectiveAddr}</span></div>
              </details>
              {/* the sign-off is in the text, so it can be edited or deleted before sending */}
              <textarea name="body" rows={6} placeholder={`Write to ${counterpartFirst}…`} data-draft="reply" data-signature={signature} required>{`\n\n${signature}`}</textarea>
              <div class="actions">
                <label class="file-label">📎 Attach<input type="file" name="files" multiple class="file-input" /></label>
                <span class="send-stack">
                  <button class="btn send-btn" type="submit" data-busy="Sending…">Send</button>
                  <span class="fineprint send-note">
                    <span>Sending to <b>{thread.counterpart_email || 'unknown'}</b></span>
                    <span>as <b>{collectiveAddr}</b></span>
                    {threadCc.length ? <span>copying <b>{threadCc.join(', ')}</b></span> : null}
                  </span>
                </span>
              </div>
            </form>
            ) : null}
            <form method="post" action={`${base}/thread/${thread.id}/note`} data-pane="note" class={canSendRole(member.role) ? 'hidden' : ''}>
              <div class="to note-to">⌁ Only members of {collective.name} will see this</div>
              <textarea
                name="body" rows={4} placeholder="Add context, ask a teammate, leave a note… type @ to pull someone in"
                data-draft="note" required
                data-mentions={JSON.stringify({
                  people: activeList.map((m) => ({ id: m.id, name: memberName(m), email: m.email })),
                  // the matching *rules* (unique first names, login names) stay
                  // server-side; the editor only replays the derived labels
                  labels: mentionLabels(activeList).map((c) => [c.label, c.member.id]),
                })}
              ></textarea>
              <div class="actions">
                <button class="btn send-btn" type="submit" data-busy="Saving…">Add internal note</button>
                <span class="hint">@mention a member to email them this note right away.</span>
              </div>
            </form>
          </div>
          )}
        </div>

        <aside class="thread-side">
          <div class="side-block">
            <span class="label">Assignment</span>
            {assignee ? (
              <div class="assign-state assigned">
                <Avatar member={assignee} /> <b>{memberName(assignee)}</b>
                {lastAssignEvent ? <small>{eventText(lastAssignEvent, members)} · {relTime(lastAssignEvent.created_at)}</small> : null}
              </div>
            ) : rule?.close ? (
              <p class="fineprint">Filed automatically by {rule.tag ? `the ⚡ #${rule.tag}` : 'a ⚡'} rule — no assignment needed.</p>
            ) : (
              <div class="assign-state unassigned-box">
                <b>⚠ Nobody has this yet</b>
                {member.role !== 'reader' ? (
                <form method="post" action={`${base}/thread/${thread.id}/assign`}>
                  <input type="hidden" name="member_id" value={String(member.id)} />
                  <button class="btn small" type="submit">🙋 Claim it</button>
                </form>
                ) : null}
              </div>
            )}
            {member.role !== 'reader' ? (
            <form method="post" action={`${base}/thread/${thread.id}/assign`} class="assign-form">
              <select name="member_id">
                <option value="">— Unassigned —</option>
                {activeList.map((m) => (
                  <option value={String(m.id)} selected={m.id === thread.assignee_member_id}>
                    {memberName(m)}{m.id === member.id ? ' (you)' : ''}
                  </option>
                ))}
              </select>
              <button class="btn small ghost" type="submit">{assignee ? 'Reassign' : 'Assign'}</button>
            </form>
            ) : null}
          </div>

          <div class="side-block">
            <span class="label">People</span>
            <div class="ppl">
              {activeList.map((m) => {
                const r = reads.find((x) => x.member_id === m.id)
                return (
                  <div class="ppl-row">
                    <Avatar member={m} />
                    <span class="ppl-name">{memberName(m)}{m.id === member.id ? ' (you)' : ''}</span>
                    <span class="ppl-tags">
                      {m.id === thread.assignee_member_id ? <span class="chip assignee">assigned</span> : null}
                      {contributed.has(m.id) ? <span class="chip">contributed</span> : null}
                    </span>
                    <small class="ppl-seen">{r ? `seen ${relTime(r.last_seen_at)}` : 'not seen yet'}</small>
                  </div>
                )
              })}
            </div>
          </div>

          <div class="side-block">
            <span class="label">Details</span>
            <span class="kv"><span class="k">STATUS</span> <StatusChip status={thread.status} /></span>
            <span class="kv"><span class="k">FROM</span> {thread.counterpart_email
              ? <a href={contactUrl(base, thread.counterpart_email)} title={otherCount > 0 ? `${otherCount} other thread${otherCount === 1 ? '' : 's'} with this sender` : 'All conversations with this sender'}>{thread.counterpart_email}</a>
              : '—'}</span>
            <span class="kv"><span class="k">FIRST</span> {fmtDateTime(thread.first_message_at)}</span>
            <span class="kv"><span class="k">LAST</span> <TimeAgo ts={thread.last_message_at} /></span>
            {thread.status === 'needs_reply' ? <span class="kv"><span class="k">WAITING</span> <b>{waitingFor(thread.last_message_at)}</b></span> : null}
          </div>

          {member.role !== 'reader' ? (<>
          <div class="side-block">
            <span class="label">Tags</span>
            <div class="tag-list">
              {tags.map((tg) => (
                <form method="post" action={`${base}/thread/${thread.id}/tags/remove`} class="inline">
                  <input type="hidden" name="tag_id" value={String(tg.id)} />
                  <button class="chip removable" type="submit" title="Remove tag">#{tg.name} ×</button>
                </form>
              ))}
            </div>
            <form method="post" action={`${base}/thread/${thread.id}/tags`} class="assign-form">
              <input class="input small" name="name" placeholder="add-a-tag" />
              <button class="btn small ghost" type="submit">Add</button>
            </form>
            {member.role === 'admin' ? (
              rule ? (
                <p class="fineprint">⚡ A rule already matches this thread ({describeRule(rule).when}). <a href={`${base}/rules`}>Manage rules</a></p>
              ) : thread.counterpart_email ? (
                <details class="rule-reveal">
                  <summary>You can also create a rule for similar messages</summary>
                  {(() => {
                    // keep the subject's case; just drop reply/forward prefixes
                    const bareSubject = thread.subject.replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim()
                    return (
                      <form method="get" action={`${base}/rules`} class="rule-similar">
                        <input type="hidden" name="thread" value={String(thread.id)} />
                        <label class="check-row">
                          <input type="checkbox" name="from" value={thread.counterpart_email} checked />
                          <span>from <b>{thread.counterpart_email}</b></span>
                        </label>
                        <label class="check-row">
                          <input type="checkbox" name="subject" value={bareSubject} />
                          <span>subject contains <b>“{bareSubject}”</b></span>
                        </label>
                        <button class="btn small ghost" type="submit">Create rule →</button>
                      </form>
                    )
                  })()}
                </details>
              ) : null
            ) : null}
          </div>

          <div class="side-block">
            <span class="label">Actions</span>
            <div class="btn-row">
              {thread.status === 'closed' || thread.status === 'spam' ? (
                <form method="post" action={`${base}/thread/${thread.id}/status`}>
                  <input type="hidden" name="status" value="needs_reply" />
                  <button class="btn small ghost" type="submit">↩ Reopen</button>
                </form>
              ) : (
                <>
                  <form method="post" action={`${base}/thread/${thread.id}/status`}>
                    <input type="hidden" name="status" value="closed" />
                    <button class="btn small ghost" type="submit">✓ Close thread</button>
                  </form>
                  <form method="post" action={`${base}/thread/${thread.id}/status`}>
                    <input type="hidden" name="status" value="spam" />
                    <button class="btn small ghost" type="submit">🚫 Mark spam</button>
                  </form>
                </>
              )}
            </div>
          </div>
          </>) : null}
          {thread.counterpart_email && otherThreads.length ? (
            <div class="side-block">
              <span class="label">Other threads with {counterpartFirst}</span>
              <div class="side-threads">
                {otherThreads.map((o) => (
                  <a class="side-thread" href={`${base}/thread/${o.id}`}>
                    <span class={`dot ${o.status === 'needs_reply' ? 'open' : 'done'}`} />
                    <span class="st-subj">{o.subject}</span>
                    <small>{shortDate(o.last_message_at)}</small>
                  </a>
                ))}
              </div>
              <p class="fineprint"><a href={contactUrl(base, thread.counterpart_email)}>All conversations with {counterpartFirst} →</a></p>
            </div>
          ) : null}
        </aside>
      </div>
    </Shell>,
  )
})

const MAX_UPLOAD = 15 * 1024 * 1024 // total, per reply

app.post('/inbox/:addr/thread/:id/reply', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = senderBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const base = `/inbox/${t.collective.slug}`
  const body = await c.req.parseBody({ all: true })
  try {
    const raw = body['files']
    const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File && f.size > 0)
    const total = files.reduce((s, f) => s + f.size, 0)
    if (total > MAX_UPLOAD) throw new Error(`Attachments too large (${Math.ceil(total / 1024 / 1024)} MB) — keep it under 15 MB.`)
    const attachments = await Promise.all(files.map(async (f) => ({
      filename: f.name,
      contentType: f.type || 'application/octet-stream',
      content: Buffer.from(await f.arrayBuffer()),
    })))
    const cc = parseEmails(String(body.cc || ''))
    const bcc = parseEmails(String(body.bcc || ''))
    await sendCollectiveReply(t.collective, thread.id, String(body.body || ''), t.member, 'web', attachments, cc, bcc)
    // the Cc list belongs to the conversation, so the next reply keeps it
    await run('UPDATE threads SET cc_json = ? WHERE id = ?', [JSON.stringify(cc), thread.id])
    const fresh = (await getThread(thread.id))!
    if (!fresh.assignee_member_id) await setAssignee(fresh, t.member.id, t.member.id, 'claim')
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent('Reply sent ✓'))
  } catch (err) {
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(`Could not send: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

/** "a@x.test, b@y.test" → ['a@x.test','b@y.test'] (deduped, invalid dropped). */
const parseEmails = (raw: string): string[] => [...new Set(
  raw.split(/[,;\s]+/).map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
)].slice(0, 20)

app.post('/inbox/:addr/thread/:id/forward', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = senderBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const base = `/inbox/${t.collective.slug}`
  const body = await c.req.parseBody()
  const message = await get<Message>('SELECT * FROM messages WHERE id = ? AND thread_id = ?', [Number(body.message_id), thread.id])
  if (!message) return c.notFound()
  try {
    await forwardMessage(t.collective, message, String(body.to || ''), String(body.note || ''), t.member)
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(`Forwarded to ${String(body.to || '').trim()} ✓`))
  } catch (err) {
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(`Could not forward: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

app.post('/inbox/:addr/thread/:id/note', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = readerBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  const text = String(body.body || '').trim()
  let flash = 'Note added ✓'
  if (text) {
    const { mentioned, notified } = await addNote(t.collective, thread, t.member, text)
    if (mentioned.length) {
      flash = notified
        ? `Note added ✓ — notified ${mentioned.map(memberName).join(', ')}`
        : 'Note added ✓ — but the mention email could not be sent'
    }
  }
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}?m=` + encodeURIComponent(flash))
})

// ---------- compose: a new email the collective starts ----------

/** "email one, two@ three" → clean list, capped, invalid dropped. */
function parseRecipients(raw: unknown): string[] {
  return [...new Set(String(raw || '').split(/[\s,;]+/).map((a) => a.toLowerCase().trim()).filter(emailLooksValid))].slice(0, 20)
}

const ComposeForm = ({ base, addr, signature, to }: { base: string; addr: string; signature: string; to?: string }) => (
  <div class="page">
    <h1>New email</h1>
    <p class="muted">Sent as <b>{addr}</b>. Save it as a draft first and the thread gets a link you can share — teammates can weigh in with internal notes before anything goes out.</p>
    <form method="post" action={`${base}/compose`} class="card compose-form">
      <div class="c-row">
        <span class="c-k">To</span>
        <input class="c-in" name="to" value={to || ''} placeholder="them@example.org — comma-separate several" autocomplete="off" spellcheck={false} autofocus={!to} />
      </div>
      {/* Apple-Mail style: one quiet combined line; tapping expands each onto
          its own row (a <details>, so it works without JavaScript; focusing the
          body folds it back when Cc/Bcc are still empty) */}
      <details class="ccb">
        <summary>Cc/Bcc, From: {addr}</summary>
        <div class="c-row"><span class="c-k">Cc</span><input class="c-in" name="cc" autocomplete="off" spellcheck={false} /></div>
        <div class="c-row"><span class="c-k">Bcc</span><input class="c-in" name="bcc" autocomplete="off" spellcheck={false} /></div>
        <div class="c-row"><span class="c-k">From</span><span class="c-static">{addr}</span></div>
      </details>
      <div class="c-row">
        <span class="c-k">Subject</span>
        <input class="c-in" name="subject" maxlength={200} required />
      </div>
      <textarea name="body" rows={10} data-signature={signature}>{`\n\n${signature}`}</textarea>
      <div class="btn-row">
        <button class="btn" type="submit" name="action" value="send" data-busy="Sending…">Send</button>
        <button class="btn ghost" type="submit" name="action" value="draft" data-busy="Saving…">Save as draft</button>
      </div>
    </form>
  </div>
)

app.get('/inbox/:addr/compose', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = senderBlock(c, t)
  if (blocked) return blocked
  const base = `/inbox/${t.collective.slug}`
  return c.html(
    <Shell member={t.member} collective={t.collective} title="New email" active="compose" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <ComposeForm base={base} addr={outboundFrom(t.collective).fromAddress} signature={signatureFor(t.collective, t.member)} to={String(c.req.query('to') || '') || undefined} />
    </Shell>,
  )
})

app.post('/inbox/:addr/compose', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = senderBlock(c, t)
  if (blocked) return blocked
  const base = `/inbox/${t.collective.slug}`
  const body = await c.req.parseBody()
  const to = parseRecipients(body.to)
  const cc = parseRecipients(body.cc)
  const bcc = parseRecipients(body.bcc)
  const subject = String(body.subject || '').trim().slice(0, 200) || '(no subject)'
  const text = String(body.body || '').trim().slice(0, 50000)
  const send = body.action === 'send'
  const ts = now()

  // Always a draft first: the thread and its URL exist before any network I/O,
  // so a failed send leaves something to fix instead of something lost.
  const th = await run(`INSERT INTO threads (collective_id, subject, status, counterpart_email, first_message_at, last_message_at, last_direction, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, ?, ?, 'outbound', ?, ?)`,
    [t.collective.id, subject, to[0] ?? null, ts, ts, ts, ts])
  await run(`INSERT INTO messages (thread_id, direction, from_email, from_name, to_json, cc_json, bcc_json, body_text, sent_by_member_id, created_at)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [th.lastId, outboundFrom(t.collective).fromAddress, t.collective.name,
     JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), text, t.member.id, ts])

  if (!send) {
    return c.redirect(`${base}/thread/${th.lastId}?m=` + encodeURIComponent('Draft saved — share this page with teammates, or send when ready.'))
  }
  try {
    await sendComposed(t.collective, th.lastId, t.member)
    return c.redirect(`${base}/thread/${th.lastId}?m=` + encodeURIComponent(`Sent to ${to.join(', ')} ✓`))
  } catch (err) {
    return c.redirect(`${base}/thread/${th.lastId}?m=` + encodeURIComponent(
      `Saved as draft — not sent: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

/** Update (and optionally send) the draft a compose created. */
app.post('/inbox/:addr/thread/:id/draft', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = senderBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread || thread.status !== 'draft') return c.notFound()
  const base = `/inbox/${t.collective.slug}`
  const body = await c.req.parseBody()
  const draft = await get<Message>(
    "SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' AND sent_at IS NULL ORDER BY id LIMIT 1", [thread.id])
  if (!draft) return c.notFound()

  const to = parseRecipients(body.to)
  const subject = String(body.subject || '').trim().slice(0, 200) || thread.subject
  await run('UPDATE messages SET to_json = ?, cc_json = ?, bcc_json = ?, body_text = ? WHERE id = ?',
    [JSON.stringify(to), JSON.stringify(parseRecipients(body.cc)), JSON.stringify(parseRecipients(body.bcc)),
     String(body.body || '').trim().slice(0, 50000), draft.id])
  await run('UPDATE threads SET subject = ?, counterpart_email = ?, updated_at = ? WHERE id = ?',
    [subject, to[0] ?? null, now(), thread.id])

  if (body.action !== 'send') {
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent('Draft updated ✓'))
  }
  try {
    await sendComposed(t.collective, thread.id, t.member)
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(`Sent to ${to.join(', ')} ✓`))
  } catch (err) {
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(
      `Still a draft — not sent: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

// ---------- typing presence ("X is drafting a response…") ----------
// Ephemeral, kv-backed, polled by open thread pages. (Vercel functions can't
// hold websockets; a 10s beacon + poll gives near-real-time without infra.)

const TYPING_TTL = 30 // seconds

app.post('/inbox/:addr/thread/:id/typing', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return c.json({ ok: false }, 401)
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  await kvSet(`typing:${thread.id}:${t.member.id}`, String(now()))
  return c.json({ ok: true })
})

app.get('/inbox/:addr/thread/:id/typing', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return c.json({ drafting: [] }, 401)
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const rows = await all<{ k: string; v: string }>('SELECT k, v FROM kv WHERE k LIKE ?', [`typing:${thread.id}:%`])
  const cutoff = now() - TYPING_TTL
  const staleKeys = rows.filter((r) => Number(r.v) < cutoff).map((r) => r.k)
  if (staleKeys.length) {
    await run(`DELETE FROM kv WHERE k IN (${staleKeys.map(() => '?').join(',')})`, staleKeys)
  }
  const members = await memberMap(t.collective.id)
  const drafting = rows
    .filter((r) => Number(r.v) >= cutoff)
    .map((r) => Number(r.k.split(':')[2]))
    .filter((id) => id !== t.member.id)
    .map((id) => memberName(members.get(id)))
  return c.json({ drafting })
})

app.post('/inbox/:addr/thread/:id/assign', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = readerBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  const raw = String(body.member_id || '')
  const target = raw === '' ? null : Number(raw)
  if (target !== null) {
    const tm = await getMember(target)
    if (!tm || tm.collective_id !== t.collective.id || tm.removed_at) return c.notFound()
  }
  await setAssignee(thread, target, t.member.id, target === t.member.id ? 'claim' : 'manual')
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

// Decide what an unrecognized answering address is: a teammate's other
// mailbox (link it — durable alias + attribution backfill) or an external
// party (flip the message back to inbound and remember the decision).
app.post('/inbox/:addr/thread/:id/sender', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.notFound()
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  if (!emailLooksValid(email)) return c.notFound()

  if (String(body.act) === 'link') {
    const target = Number(body.member_id)
    const tm = await getMember(target)
    if (!tm || tm.collective_id !== t.collective.id || tm.removed_at) return c.notFound()
    await run('INSERT INTO member_aliases (collective_id, member_id, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(collective_id, email) DO UPDATE SET member_id = excluded.member_id', [t.collective.id, tm.id, email, now()])
    await run(`UPDATE messages SET sent_by_member_id = ? WHERE sent_by_member_id IS NULL AND direction = 'outbound' AND from_email = ?
               AND thread_id IN (SELECT id FROM threads WHERE collective_id = ?)`, [tm.id, email, t.collective.id])
    await kvSet(`notteam:${t.collective.id}:${email}`, '') // clear any earlier "external" decision
    if (!thread.assignee_member_id) await setAssignee(thread, tm.id, t.member.id, 'manual')
    return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}?m=` + encodeURIComponent(`${email} is now linked to ${tm.name || tm.email} — past and future answers count as theirs.`))
  }

  if (String(body.act) === 'external') {
    await kvSet(`notteam:${t.collective.id}:${email}`, '1')
    await run("UPDATE messages SET direction = 'inbound' WHERE thread_id = ? AND from_email = ? AND direction = 'outbound' AND sent_by_member_id IS NULL", [thread.id, email])
    const last = await get<Message>('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1', [thread.id])
    if (last?.from_email === email) {
      await run("UPDATE threads SET last_direction = 'inbound', updated_at = ? WHERE id = ?", [now(), thread.id])
      await setStatus(thread.id, 'needs_reply', t.member.id)
    }
    return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}?m=` + encodeURIComponent(`Got it — ${email} is treated as an external correspondent.`))
  }
  return c.notFound()
})

app.post('/inbox/:addr/thread/:id/status', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = readerBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  const status = String(body.status || '')
  if (['needs_reply', 'answered', 'closed', 'spam'].includes(status)) {
    await setStatus(thread.id, status as Thread['status'], t.member.id)
  }
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

app.post('/inbox/:addr/thread/:id/tags', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = readerBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  await addTag(t.collective.id, thread.id, String(body.name || ''), t.member.id)
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

app.post('/inbox/:addr/thread/:id/tags/remove', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const blocked = readerBlock(c, t)
  if (blocked) return blocked
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  await removeTag(thread.id, Number(body.tag_id), t.member.id)
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

// Platform admin can add themselves to any collective (from the "wrong account" page)
app.post('/inbox/:addr/join-admin', async (c) => {
  const email = platformAdminAccount(c)
  if (!email) return c.notFound()
  const slug = slugFromAddr(c)
  const collective = slug ? await getCollectiveBySlug(slug) : undefined
  if (!collective) return c.notFound()
  const existing = await getMemberIn(collective.id, email!)
  if (existing) {
    await run("UPDATE members SET removed_at = NULL, role = 'admin' WHERE id = ?", [existing.id])
  } else {
    await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, email!, email!.split('@')[0], 'admin', 'every', now()])
  }
  return c.redirect(`/inbox/${collective.slug}?m=` + encodeURIComponent(`Added ${email} to ${collective.name}.`))
})


// ---------- tenant: members / notifications / billing ----------

const activeInvite = (collectiveId: number) =>
  get<Invite>('SELECT * FROM invites WHERE collective_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
    [collectiveId, now()])

const BackNav = ({ base }: { base: string }) => (
  <nav class="nav"><a class="nav-item" href={base}>← Back to inbox</a></nav>
)

// ---------- settings ----------

/** Settings is one place in the menu and three pages underneath. Domain and
 *  Billing keep their own URLs — they are linked from trial, credit and
 *  onboarding emails that are already in people's inboxes. */
const SETTINGS_TABS = [
  { key: 'settings', label: 'General', path: '/settings' },
  { key: 'data', label: 'Data', path: '/data' },
  { key: 'domain', label: 'Your domain', path: '/domain' },
  { key: 'billing', label: 'Billing', path: '/billing' },
] as const

const SettingsNav = ({ base, on }: { base: string; on: string }) => (
  <nav class="subnav">
    {SETTINGS_TABS.map((t) => (
      <a class={`subnav-item ${t.key === on ? 'on' : ''}`} href={`${base}${t.path}`}>{t.label}</a>
    ))}
  </nav>
)

app.get('/inbox/:addr/settings', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { member } = t
  const base = `/inbox/${t.collective.slug}`
  if (member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  const addr = receivingAddress(collective)
  const onOwnDomain = Boolean(collective.custom_domain && collective.custom_local)
  // The address can be changed until the first email arrives; after that it is
  // out in the world and moving it would drop mail on the floor.
  const inUse = await hasReceivedMail(collective.id)

  return c.html(
    <Shell member={member} collective={collective} title="Settings" active="settings" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Settings</h1>
        <SettingsNav base={base} on="settings" />

        <section class="card">
          <h2>Name</h2>
          <p class="muted">
            What your people see in the sidebar, in the digests, and on every notification we send
            on your behalf — “Marie Dupont via {collective.name}”. Changing it takes effect immediately;
            it does not affect your address or anything already delivered.
          </p>
          <form method="post" action={`${base}/settings`} class="btn-row" style="flex-wrap:wrap">
            <input class="input" name="name" value={collective.name} maxlength={80} required style="max-width:340px" />
            <button class="btn" type="submit" data-busy="Saving…">Save</button>
          </form>
        </section>

        <section class="card">
          <h2>Address</h2>
          <p class="muted">Where your mail arrives, and the web address of this inbox.</p>
          <p><code class="invite-url">{addr}</code></p>
          {onOwnDomain
            ? <p class="fineprint">Your own domain is set up. <a href={`${base}/domain`}>Manage it →</a></p>
            : <p class="fineprint">Want mail at your own domain instead? <a href={`${base}/domain`}>Set one up →</a></p>}
          {inUse ? (
            <p class="fineprint">
              Mail has arrived here, so the address is settled — people, mailing lists and forwarding
              rules point at it, and moving it would drop their mail. If you need a different one:
              {' '}<a href={`${base}/data`}>download your archive</a>, then email hello@collective.email
              {' '}to close this inbox and start a new one.
            </p>
          ) : (
            <div class="btn-row">
              <button class="btn small ghost" type="button" data-dialog="#rename-modal">Change address…</button>
            </div>
          )}
        </section>

        {/* Only rendered before the first email arrives, so the only thing worth
            saying is the one-way part: the old address stops existing. */}
        <dialog id="rename-modal" class="modal">
          <h2>Change this address?</h2>
          <p class="muted">
            Nothing is pointing at <b>{addr}</b> yet — no mail has arrived — so this is a free change.
            Afterwards the old address stops existing, and anything sent there will bounce.
          </p>
          <form method="post" action={`${base}/settings/address`} class="modal-form">
            <label class="lbl">New address</label>
            <span class="wl-addr">
              <input name="slug" value={collective.slug} minlength={6} maxlength={40} pattern="[a-z0-9]{6,40}" autocomplete="off" spellcheck={false} required />
              <span class="domain">@{cfg.emailDomain}</span>
            </span>
            <div class="btn-row">
              <button class="btn" type="submit" data-busy="Moving…">Change the address</button>
              <button class="btn ghost" type="button" data-close>Cancel</button>
            </div>
          </form>
        </dialog>
      </div>
    </Shell>,
  )
})

/** Has anything ever arrived here? The one thing that settles the address. */
const hasReceivedMail = async (collectiveId: number) => Boolean((await get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.collective_id = ? AND m.direction = 'inbound'",
  [collectiveId]))?.n)

/** Data lives on its own page: an archive is a different kind of decision from
 *  a subscription, and people look for it when they are considering leaving. */
app.get('/inbox/:addr/data', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  if (member.role !== 'admin') return c.redirect(base)
  const archived = collective.status === 'archived'
  const msgCount = await messageCount(collective.id)
  return c.html(
    <Shell member={member} collective={collective} title="Data" active="data" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Data</h1>
        <SettingsNav base={base} on="data" />
        <section class="card">
          <h2>Download everything</h2>
          <p class="muted">Everything your collective ever received or wrote — download it any time. The archive unzips into a folder with a browsable offline inbox (<code style="font-size:12px">inbox.html</code>), the raw data as JSON, and every attachment.</p>
          <a class="btn small ghost" href={`${base}/export`} download>⬇ Download archive (.zip)</a>
        </section>
        <section class="card">
          <h2>Where it lives</h2>
          <p class="muted">Your mail is stored in the EU (Dublin) and backed up nightly. Internal notes, assignments and attachments are included in the archive — it is the whole record, not a summary. No lock-in games.</p>
        </section>

        <section class="card">
          <h2>Close this inbox</h2>
          {archived ? (
            <>
              <p class="muted">
                Closed on {fmtDate(collective.archived_at!)}. Mail sent to <b>{receivingAddress(collective)}</b> is
                bouncing, and everything here is deleted for good on <b>{fmtDate(purgeDueAt(collective))}</b>.
                You can still download the archive until then.
              </p>
              <form method="post" action={`${base}/data/restore`} class="btn-row">
                <button class="btn" type="submit" data-busy="Reopening…">Reopen this inbox</button>
              </form>
            </>
          ) : (
            <>
              <p class="muted">
                Stops the address receiving straight away — anything sent to it bounces. Nothing is deleted for
                30 days, so you can change your mind; after that {msgCount ? `all ${msgCount} message${msgCount === 1 ? '' : 's'}` : 'everything'},
                {' '}the notes and the attachments are gone for good.
              </p>
              <div class="btn-row">
                <button class="btn ghost danger-btn" type="button" data-dialog="#close-modal">Close this inbox…</button>
              </div>
            </>
          )}
        </section>

        {archived ? null : (
          <dialog id="close-modal" class="modal">
            <h2>Close {collective.name}?</h2>
            <p class="muted">
              <b>{receivingAddress(collective)}</b> stops receiving immediately — mail sent there will bounce, so
              anyone still writing to you finds out right away. Everything is deleted on{' '}
              <b>{fmtDate(now() + PURGE_AFTER)}</b>. Until then you can reopen it from this page.
            </p>
            <form method="post" action={`${base}/data/archive`} class="modal-form">
              {/* the archive is one click away from here: asking someone to
                  cancel, hunt for the button, and start again is how you end up
                  with people closing an inbox without their data */}
              <a class="btn ghost" href={`${base}/export`} download>⬇ Download archive (.zip)</a>
              <label class="level-card">
                <input type="checkbox" name="downloaded" value="1" required />
                <span><b>I've downloaded the archive.</b>
                  <small>There is no copy to ask us for afterwards — take it first if you want it.</small></span>
              </label>
              <div class="btn-row">
                <button class="btn ghost danger-btn" type="submit" data-busy="Closing…">Close this inbox</button>
                <button class="btn ghost" type="button" data-close>Cancel</button>
              </div>
            </form>
          </dialog>
        )}
      </div>
    </Shell>,
  )
})

/** Archive: stop receiving now, delete in 30 days. */
app.post('/inbox/:addr/data/archive', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const body = await c.req.parseBody()
  // checked server-side too: `required` is only the browser being helpful
  if (body.downloaded !== '1') {
    return c.redirect(`${base}/data?m=` + encodeURIComponent('Download the archive first — then you can close the inbox.'))
  }
  const collective = (await getCollective(t.collective.id))!
  if (collective.status === 'archived') return c.redirect(`${base}/data`)
  await archiveCollective(collective)
  return c.redirect(`${base}/data?m=` + encodeURIComponent(
    `Inbox closed — ${receivingAddress(collective)} now bounces. Deleted for good on ${fmtDate(now() + PURGE_AFTER)}.`))
})

app.post('/inbox/:addr/data/restore', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (collective.status !== 'archived') return c.redirect(`${base}/data`)
  await restoreCollective(collective)
  return c.redirect(`${base}/data?m=` + encodeURIComponent(
    `Reopened — ${receivingAddress(collective)} is receiving again.`))
})

/** Change the address — only while the inbox has never received anything. */
app.post('/inbox/:addr/settings/address', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  const body = await c.req.parseBody()
  const slug = slugify(String(body.slug || ''))
  const back = (msg: string) => c.redirect(`${base}/settings?m=` + encodeURIComponent(msg))

  // the whole rule: once mail has arrived, the address belongs as much to the
  // people who wrote it down as to us, and we are not going to drop theirs
  if (await hasReceivedMail(collective.id)) {
    return back('This inbox has already received email, so its address is settled. Download your archive and email hello@collective.email to close it.')
  }
  if (slug === collective.slug) return c.redirect(`${base}/settings`)
  const invalid = validateClaimSlug(slug)
  if (invalid) return back(invalid)
  if (await slugAvailability(slug)) return back(`${slug}@${cfg.emailDomain} is already taken.`)

  const oldSlug = collective.slug
  await renameCollectiveSlug(collective, slug)
  return c.redirect(`/inbox/${slug}/settings?m=` + encodeURIComponent(
    `Address changed to ${slug}@${cfg.emailDomain} ✓ — mail to ${oldSlug}@${cfg.emailDomain} will bounce.`))
})

app.post('/inbox/:addr/settings', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!name) return c.redirect(`${base}/settings?m=` + encodeURIComponent('A name cannot be empty.'))
  if (name === t.collective.name) return c.redirect(`${base}/settings`)
  await run('UPDATE collectives SET name = ? WHERE id = ?', [name, t.collective.id])
  return c.redirect(`${base}/settings?m=` + encodeURIComponent(`Renamed to ${name} ✓`))
})

// ---------- rules ----------

app.get('/inbox/:addr/rules', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  if (member.role !== 'admin') return c.redirect(`/inbox/${collective.slug}`)
  const base = `/inbox/${collective.slug}`
  const [rules, activeList] = await Promise.all([listRules(collective.id), activeMembers(collective.id)])
  const names = new Map(activeList.map((m) => [m.id, m.name || m.email.split('@')[0]]))
  // prefill from the thread sidebar's "create a rule for similar messages"
  const preFrom = String(c.req.query('from') || '')
  const preSubject = String(c.req.query('subject') || '')
  const preThread = String(c.req.query('thread') || '')
  return c.html(
    <Shell member={member} collective={collective} title="Rules" active="rules" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h2>⚡ Rules</h2>
        <p class="muted">When a message matches, the rule tags it, assigns it (or leaves it unassigned), and can close it so it never asks for a reply. Closed mail is still forwarded to members — in full HTML — and stays open for internal notes.</p>
        {rules.length ? (
          <div class="rule-list">
            {rules.map((r) => {
              const d = describeRule(r, r.assign_member_id ? names.get(r.assign_member_id) : undefined)
              return (
                <div class="rule-row">
                  <span class="rule-match">{d.when}</span>
                  <span class="rule-then">→ {d.then}</span>
                  <form method="post" action={`${base}/rules/${r.id}/delete`} class="inline">
                    <button class="btn small ghost" type="submit" data-confirm={`Delete this rule (${d.when})? Future mail will land in the inbox normally.`}>Delete</button>
                  </form>
                </div>
              )
            })}
          </div>
        ) : <p class="muted">No rules yet. Create one below, or from any thread's sidebar.</p>}

        <h3 id="new">New rule</h3>
        <form method="post" action={`${base}/rules`} class="rule-editor">
          {preThread ? <input type="hidden" name="thread" value={preThread} /> : null}
          <span class="label">When a message arrives…</span>
          <label class="lbl" for="rule-from">From (address, or a whole domain like @news.example.com)</label>
          <input class="input" id="rule-from" name="from" placeholder="update@nws.example.com or @news.example.com" value={preFrom} />
          <label class="lbl" for="rule-subject">And / or the subject contains</label>
          <input class="input" id="rule-subject" name="subject" placeholder="weekly digest" value={preSubject} />
          <p class="fineprint">Fill either or both — both filled means both must match.</p>

          <span class="label">Then…</span>
          <label class="lbl" for="rule-tag">Tag it</label>
          <input class="input" id="rule-tag" name="tag" placeholder="newsletter" list="rule-tags" value={preFrom || preSubject ? 'newsletter' : ''} />
          <datalist id="rule-tags"><option value="newsletter" /><option value="updates" /></datalist>
          <label class="lbl" for="rule-assign">Assign it to</label>
          <select class="input" id="rule-assign" name="assign">
            <option value="">Nobody — leave unassigned</option>
            {activeList.map((m) => <option value={String(m.id)}>{m.name || m.email.split('@')[0]}</option>)}
          </select>
          <label class="check-row"><input type="checkbox" name="close" value="1" checked /> Close it — no reply needed (it won't show up as unanswered)</label>
          <div class="btn-row">
            <button class="btn small" type="submit" data-busy="Creating…">Create rule</button>
          </div>
          <p class="fineprint">The rule also applies immediately to everything already in the inbox that matches.</p>
        </form>
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/rules', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.redirect(`/inbox/${t.collective.slug}`)
  const body = await c.req.parseBody()
  const threadId = Number(body.thread) || 0
  const back = threadId ? `/inbox/${t.collective.slug}/thread/${threadId}` : `/inbox/${t.collective.slug}/rules`
  const assignId = Number(body.assign) || null
  if (assignId) {
    const tm = await getMember(assignId)
    if (!tm || tm.collective_id !== t.collective.id || tm.removed_at) return c.notFound()
  }
  try {
    const { rule, applied } = await createRule(t.collective, {
      from: String(body.from || ''),
      subject: String(body.subject || ''),
      tag: String(body.tag || ''),
      assignMemberId: assignId,
      close: body.close === '1',
    }, t.member.id)
    const d = describeRule(rule)
    return c.redirect(back + '?m=' + encodeURIComponent(`⚡ Rule created: ${d.when} → ${d.then}${applied ? ` — applied to ${applied} existing thread${applied === 1 ? '' : 's'}` : ''}.`))
  } catch (err) {
    return c.redirect(back + '?m=' + encodeURIComponent(err instanceof Error ? err.message : 'That rule could not be created.'))
  }
})

app.post('/inbox/:addr/rules/:id/delete', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.redirect(`/inbox/${t.collective.slug}`)
  await deleteRule(t.collective.id, Number(c.req.param('id')))
  return c.redirect(`/inbox/${t.collective.slug}/rules?m=` + encodeURIComponent('Rule deleted.'))
})

app.get('/inbox/:addr/members', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const isAdmin = member.role === 'admin'
  const [members, invite, replyCounts] = await Promise.all([
    activeMembers(collective.id),
    activeInvite(collective.id),
    all<{ mid: number; n: number }>(`
      SELECT m.sent_by_member_id AS mid, COUNT(*) AS n FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE t.collective_id = ? AND m.direction = 'outbound' AND m.sent_by_member_id IS NOT NULL
      GROUP BY m.sent_by_member_id
    `, [collective.id]),
  ])
  const inviteUrl = invite ? `${cfg.baseUrl}/join/${invite.token}` : null
  const inviteHoursLeft = invite ? Math.max(1, Math.ceil((invite.expires_at - now()) / 3600)) : 0
  const replies = (id: number) => replyCounts.find((r) => r.mid === id)?.n ?? 0
  const adminCount = members.filter((m) => m.role === 'admin').length

  return c.html(
    <Shell member={member} collective={collective} title="Members" active="members" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Members</h1>
        <p class="muted">Email sent to <b>{collective.slug}@{cfg.emailDomain}</b> lands here for the whole group. Readers follow along, commenters discuss internally, senders answer, admins run the place.</p>

        <section class="card">
          <h2>Invite someone</h2>
          {inviteUrl ? (
            <>
              <p class="muted">Whoever opens this link joins as <b>{ROLE_LABELS[(invite!.role || 'reader') as Member['role']]}</b> — they pick their own email and notification level. Share it anywhere in your community.</p>
              <div class="invite-row">
                <code class="invite-url">{inviteUrl}</code>
                <button class="btn small" type="button" data-copy={inviteUrl}>Copy link</button>
              </div>
              <p class="fineprint">Expires in {inviteHoursLeft}h.
                {isAdmin ? ' Generating a new link deactivates this one.' : ''}
              </p>
            </>
          ) : (
            <p class="muted">No active invite link.{isAdmin ? '' : ' Ask an admin to generate one.'}</p>
          )}
          {isAdmin ? (
            <form method="post" action={`${base}/members/invite`}>
              <div class="btn-row invite-form">
                <select name="role" class="role-select" aria-label="Role for people joining with this link">
                  <option value="reader" data-hint={ROLE_HINTS.reader}>Reader</option>
                  <option value="commenter" data-hint={ROLE_HINTS.commenter}>Commenter</option>
                  <option value="member" data-hint={ROLE_HINTS.member}>Sender</option>
                </select>
                <button class="btn small" type="submit">{invite ? '↻ New invite link' : '+ Create invite link'}</button>
              </div>
              <p class="fineprint role-hint">{ROLE_HINTS.reader}</p>
            </form>
          ) : null}
          {isAdmin && invite ? (
            <form method="post" action={`${base}/members/invite/revoke`} class="btn-row">
              <button class="btn small ghost" type="submit" data-confirm="Revoke the current invite link? Anyone holding it won't be able to join.">Revoke current link</button>
            </form>
          ) : null}
        </section>

        <section class="card">
          <h2>Members ({members.length})</h2>
          <div class="member-table">
            {members.map((m) => {
              const editable = isAdmin && m.id !== member.id
              return (
              <div class="member-row">
                <Avatar member={m} />
                <span class="m-name">
                  {memberName(m)}{m.id === member.id ? ' (you)' : ''}
                  <small>{m.email}</small>
                </span>
                <span class="m-role">
                  {editable ? (
                    <form method="post" action={`${base}/members/${m.id}/role`} class="inline role-form">
                      <select name="role" class="role-select" aria-label={`Role of ${memberName(m)}`} title={ROLE_HINTS[m.role]}>
                        <option value="reader" data-hint={ROLE_HINTS.reader} selected={m.role === 'reader'}>Reader</option>
                        <option value="commenter" data-hint={ROLE_HINTS.commenter} selected={m.role === 'commenter'}>Commenter</option>
                        <option value="member" data-hint={ROLE_HINTS.member} selected={m.role === 'member'}>Sender</option>
                        <option value="admin" data-hint={ROLE_HINTS.admin} selected={m.role === 'admin'}>Admin</option>
                      </select>
                    </form>
                  ) : (
                    <span class={m.role === 'admin' ? 'chip solid' : 'chip'} title={ROLE_HINTS[m.role]}>{ROLE_LABELS[m.role]}</span>
                  )}
                </span>
                <span class="m-meta">
                  {LEVELS.find((l) => l.value === m.notify_level)?.label}
                  <small>{replies(m.id)} replies · seen {relTime(m.last_seen_at)}</small>
                </span>
                <span class="m-remove">
                  {editable ? (
                    <form method="post" action={`${base}/members/${m.id}/remove`} class="inline">
                      <button class="linkish danger" type="submit" disabled={m.role === 'admin' && adminCount <= 1}
                        data-confirm={`Remove ${memberName(m)} from the collective? They lose access immediately; their past replies stay attributed.`}>Remove</button>
                    </form>
                  ) : null}
                </span>
              </div>
              )
            })}
          </div>
        </section>
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/members/invite', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.redirect(`/inbox/${t.collective.slug}/members`)
  const inviteBody = await c.req.parseBody()
  const inviteRole = ['reader', 'commenter', 'member'].includes(String(inviteBody.role)) ? String(inviteBody.role) : 'reader'
  await run('UPDATE invites SET revoked_at = ? WHERE collective_id = ? AND revoked_at IS NULL', [now(), t.collective.id])
  await run('INSERT INTO invites (collective_id, token, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [t.collective.id, randomToken(18), inviteRole, t.member.id, now(), now() + cfg.inviteHours * 3600])
  return c.redirect(`/inbox/${t.collective.slug}/members?m=` + encodeURIComponent('New invite link created — valid 24h.'))
})

app.post('/inbox/:addr/members/invite/revoke', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.redirect(`/inbox/${t.collective.slug}/members`)
  await run('UPDATE invites SET revoked_at = ? WHERE collective_id = ? AND revoked_at IS NULL', [now(), t.collective.id])
  return c.redirect(`/inbox/${t.collective.slug}/members?m=` + encodeURIComponent('Invite link revoked.'))
})

app.post('/inbox/:addr/members/:id/remove', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const back = `/inbox/${t.collective.slug}/members`
  if (t.member.role !== 'admin') return c.redirect(back)
  const target = await getMember(Number(c.req.param('id')))
  if (!target || target.collective_id !== t.collective.id || target.id === t.member.id) return c.redirect(back)
  const adminCount = (await activeMembers(t.collective.id)).filter((m) => m.role === 'admin').length
  if (target.role === 'admin' && adminCount <= 1) return c.redirect(back + '?m=' + encodeURIComponent('Cannot remove the last admin.'))
  await run('UPDATE members SET removed_at = ? WHERE id = ?', [now(), target.id])
  return c.redirect(back + '?m=' + encodeURIComponent(`${memberName(target)} was removed from the collective.`))
})

app.post('/inbox/:addr/members/:id/role', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const back = `/inbox/${t.collective.slug}/members`
  if (t.member.role !== 'admin') return c.redirect(back)
  const target = await getMember(Number(c.req.param('id')))
  if (!target || target.collective_id !== t.collective.id || target.id === t.member.id) return c.redirect(back)
  const body = await c.req.parseBody()
  const role = ['reader', 'commenter', 'member', 'admin'].includes(String(body.role)) ? (String(body.role) as Member['role']) : target.role
  if (role === target.role) return c.redirect(back)
  const members = await activeMembers(t.collective.id)
  const adminCount = members.filter((m) => m.role === 'admin').length
  if (target.role === 'admin' && adminCount <= 1) return c.redirect(back + '?m=' + encodeURIComponent('Cannot demote the last admin.'))
  // sending seats (can send + admin) are the paid dimension; readers and commenters are free
  if (!canSendRole(target.role) && canSendRole(role)) {
    const senders = members.filter((m) => canSendRole(m.role)).length
    const limit = planLimits(t.collective.plan).contributors
    if (senders >= limit) {
      return c.redirect(back + '?m=' + encodeURIComponent(`Sending-seat limit reached (${limit} on the ${t.collective.plan} plan). Change someone to “can comment” or upgrade.`))
    }
  }
  await run('UPDATE members SET role = ? WHERE id = ?', [role, target.id])
  return c.redirect(back + '?m=' + encodeURIComponent(`${memberName(target)} is now a ${ROLE_LABELS[role]} — ${ROLE_HINTS[role].charAt(0).toLowerCase()}${ROLE_HINTS[role].slice(1)}`))
})

app.get('/inbox/:addr/notifications', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const mutes = await all<{ id: number; match_from: string }>(
    'SELECT id, match_from FROM member_mutes WHERE collective_id = ? AND member_id = ? ORDER BY match_from',
    [collective.id, member.id])
  return c.html(
    <Shell member={member} collective={collective} title="Notifications" active="notifications" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Notifications</h1>
        <section class="card">
          <form method="post" action={`${base}/notifications`} class="me-form">
            <label class="lbl">Notifications about new requests</label>
            <div class="level-cards">
              {LEVELS.map((l) => (
                <label class="level-card">
                  <input type="radio" name="level" value={l.value} checked={member.notify_level === l.value} />
                  <span><b>{l.label}</b><small>{l.hint}</small></span>
                </label>
              ))}
            </div>
            <div class="btn-row">
              <button class="btn small" type="submit" data-busy="Saving…">Save</button>
            </div>
          </form>
          <p class="fineprint">Whatever the level, you're always notified immediately on threads assigned to you. Notification emails can be answered directly: replying sends your answer to the original sender as {collective.slug}@{cfg.emailDomain} and assigns the thread to you.</p>
        </section>

        {mutes.length ? (
          <section class="card">
            <h2>Muted senders</h2>
            <p class="muted">You're not emailed when these senders write in — their messages still arrive in the shared inbox for everyone.</p>
            {mutes.map((mu) => (
              <form method="post" action={`${base}/notifications/unmute`} class="mute-row">
                <input type="hidden" name="id" value={String(mu.id)} />
                <span class="mute-addr">{mu.match_from}</span>
                <button class="btn small ghost" type="submit" data-busy="Unmuting…">Unmute</button>
              </form>
            ))}
          </section>
        ) : null}
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/notifications/unmute', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const body = await c.req.parseBody()
  // scoped to the signed-in member: nobody can unmute for someone else
  await run('DELETE FROM member_mutes WHERE id = ? AND collective_id = ? AND member_id = ?',
    [Number(body.id), t.collective.id, t.member.id])
  return c.redirect(`/inbox/${t.collective.slug}/notifications?m=` + encodeURIComponent('Unmuted.'))
})

app.post('/inbox/:addr/notifications', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const body = await c.req.parseBody()
  const level = ['every', 'daily', 'weekly'].includes(String(body.level)) ? String(body.level) : t.member.notify_level
  await run('UPDATE members SET notify_level = ? WHERE id = ?', [level, t.member.id])
  return c.redirect(`/inbox/${t.collective.slug}/notifications?m=` + encodeURIComponent('Saved.'))
})

// ---------- profile (avatar, name, sign out, leave) ----------

app.get('/inbox/:addr/profile', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  const adminCount = (await activeMembers(collective.id)).filter((m) => m.role === 'admin').length
  const lastAdmin = member.role === 'admin' && adminCount <= 1
  return c.html(
    <Shell member={member} collective={collective} title="Your profile" active="profile" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Your profile</h1>
        <section class="card">
          <form method="post" action={`${base}/profile`} enctype="multipart/form-data" class="me-form">
            <div class="profile-avatar-row">
              <Avatar member={member} />
              <label class="file-label">🖼 Change avatar<input type="file" name="avatar" accept="image/*" class="file-input" /></label>
            </div>
            <label class="lbl">Display name</label>
            <input class="input" name="name" value={member.name} required />
            <label class="lbl">Signed in as</label>
            <p class="muted" style="margin:0">{member.email}</p>
            <div class="btn-row">
              <button class="btn small" type="submit" data-busy="Saving…">Save</button>
            </div>
          </form>
        </section>
        <section class="card">
          <div class="btn-row profile-exit">
            <form method="post" action="/logout">
              {/* this account only — any other signed-in account stays */}
              <input type="hidden" name="email" value={member.email} />
              <button class="btn small ghost" type="submit">Sign out {member.email}</button>
            </form>
            <form method="post" action={`${base}/leave`}>
              <button class="btn small ghost danger-btn" type="submit" disabled={lastAdmin}
                data-confirm={`Leave ${collective.name}? You'll lose access to ${collective.slug}@${cfg.emailDomain} until someone invites you back.`}>
                Leave this collective
              </button>
            </form>
          </div>
          {lastAdmin ? <p class="fineprint">You're the last admin — make another member admin before leaving.</p> : null}
        </section>
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/profile', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const body = await c.req.parseBody({ all: true })
  const name = String(body.name || '').trim().slice(0, 60)
  const avatar = body.avatar
  if (avatar instanceof File && avatar.size > 0) {
    if (!avatar.type.startsWith('image/')) {
      return c.redirect(`/inbox/${t.collective.slug}/profile?m=` + encodeURIComponent('Avatars must be an image.'))
    }
    if (avatar.size > 2 * 1024 * 1024) {
      return c.redirect(`/inbox/${t.collective.slug}/profile?m=` + encodeURIComponent('Avatar too large — keep it under 2 MB.'))
    }
    const locator = await saveBlob(`avatars/${t.member.id}/${Date.now()}-${avatar.name.replace(/[^\w.-]+/g, '_')}`,
      Buffer.from(await avatar.arrayBuffer()), avatar.type)
    await run('UPDATE members SET avatar_path = ? WHERE id = ?', [locator, t.member.id])
  }
  await run("UPDATE members SET name = COALESCE(NULLIF(?, ''), name) WHERE id = ?", [name, t.member.id])
  return c.redirect(`/inbox/${t.collective.slug}/profile?m=` + encodeURIComponent('Saved ✓'))
})

app.post('/inbox/:addr/leave', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const adminCount = (await activeMembers(t.collective.id)).filter((m) => m.role === 'admin').length
  if (t.member.role === 'admin' && adminCount <= 1) {
    return c.redirect(`/inbox/${t.collective.slug}/profile?m=` + encodeURIComponent("You're the last admin — promote someone first."))
  }
  await run('UPDATE members SET removed_at = ? WHERE id = ?', [now(), t.member.id])
  return c.redirect('/?m=' + encodeURIComponent(`You left ${t.collective.name}.`))
})

// avatar images, visible to fellow members of any shared collective
app.get('/avatar/:id', async (c) => {
  if (c.get('accounts').length === 0) return c.notFound()
  const target = await getMember(Number(c.req.param('id')))
  if (!target?.avatar_path) return c.notFound()
  if (!(await memberAmongAccounts(c, target.collective_id)) && !platformAdminAccount(c)) return c.notFound()
  const content = await readBlob(target.avatar_path)
  if (!content) return c.notFound()
  const ext = target.avatar_path.split('.').pop()?.toLowerCase() || ''
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png'
  return c.body(new Uint8Array(content), 200, {
    'Content-Type': type,
    'Cache-Control': 'private, max-age=3600',
  })
})

const PLAN_INFO: Record<string, { label: string; seats: number | null; price: (s: string) => string }> = {
  collective: { label: 'Collective', seats: 10, price: (s) => `${s}10 per month (or ${s}100/year — save ${s}20)` },
  pro: { label: 'Pro', seats: null, price: (s) => `${s}100 per month (or ${s}1,000/year — save ${s}200)` },
  duo: { label: 'Duo (legacy)', seats: 2, price: (s) => `${s}10 per month` },
}

const SUB_ACTIVE = new Set(['active', 'trialing', 'past_due'])

app.get('/inbox/:addr/billing', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { member } = t
  const base = `/inbox/${t.collective.slug}`
  if (member.role !== 'admin') return c.redirect(base)
  // tenant() carries a slim collective — billing needs the stripe columns
  const collective = (await getCollective(t.collective.id))!
  const seats = (await activeMembers(collective.id)).length
  const plan = PLAN_INFO[collective.plan] || PLAN_INFO.collective
  const currency = visitorCurrency(c) === 'EUR' ? 'eur' : 'usd'
  const sym = currency === 'eur' ? '€' : '$'
  const flash = c.req.query('success') ? 'Subscription active — thank you! 🎉'
    : c.req.query('canceled') ? 'Checkout canceled — nothing was charged.'
    : c.req.query('m')
  const state = billingState(collective)
  const subscribed = state === 'subscribed'
  const daysLeft = trialDaysLeft(collective)
  const used = await repliesThisMonth(collective.id)
  const limits = planLimits(collective.plan)
  const contributors = (await activeMembers(collective.id)).filter((m) => canSendRole(m.role)).length

  return c.html(
    <Shell member={member} collective={collective} title="Billing" active="billing" flash={flash} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Billing</h1>
        <SettingsNav base={base} on="billing" />
        <section class="card">
          <h2>{plan.label} plan</h2>
          <p class="muted">{plan.price(sym)}</p>
          <span class="kv"><span class="k">READERS</span> {seats - contributors} (always free, unlimited)</span>
          <span class="kv"><span class="k">CONTRIB.</span> {contributors}{plan.seats ? ` of ${plan.seats}` : ' (no limit)'}</span>
          <span class="kv"><span class="k">REPLIES</span> {used} of {limits.replies} this month</span>
          <span class="kv"><span class="k">ADDRESS</span> {collective.slug}@{cfg.emailDomain}</span>
          <span class="kv"><span class="k">STATUS</span> {
            state === 'subscribed' ? <span class="chip status-answered">subscribed{collective.billing_cycle ? ` · ${collective.billing_cycle}` : ''}</span>
            : state === 'comped' ? <span class="chip status-answered">free (courtesy of collective.email)</span>
            : state === 'trial' ? <span class="chip solid">free trial · {daysLeft} days left</span>
            : state === 'grace' ? <span class="chip unassigned">trial ended — read-only</span>
            : <span class="chip unassigned">expired — address inactive</span>
          }</span>
        </section>

        <section class="card">
          <h2>Credits</h2>
          <p class="muted"><b>{String(await creditBalance(collective.id))} credit{(await creditBalance(collective.id)) === 1 ? '' : 's'}</b> — 1 credit = 1 month of service, used automatically when a paid period or trial lapses.</p>
          <span class="kv"><span class="k">EARN</span> <span>Refer another collective: <code class="invite-url" style="padding:2px 8px">{referralUrl(collective.slug)}</code> <button class="btn small ghost" type="button" data-copy={referralUrl(collective.slug)}>Copy</button></span></span>
          <p class="fineprint">You earn 1 credit when a collective you referred has been active for a month and is really using its inbox.</p>
          {/* Contribute-to-earn-credits is hidden for now (POST /billing/contribute still exists). */}
          {(await creditsLedger(collective.id, 8)).length > 0 ? (
            <div class="admin-list">
              {(await creditsLedger(collective.id, 8)).map((l) => (
                <div class="admin-row">
                  <b>{l.delta > 0 ? `+${l.delta}` : String(l.delta)}</b>
                  <small>{l.reason.replace(/_/g, ' ')}{l.ref ? ` · ${l.ref}` : ''} · {relTime(l.created_at)}</small>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {!(await stripeUsable()) ? (
          <section class="card">
            <h2>Nothing to pay yet</h2>
            <p class="muted">Online payment isn't enabled in this environment yet. Your trial status above is accurate — we'll email the admins before anything changes.</p>
          </section>
        ) : subscribed ? (
          <section class="card">
            <h2>Manage your subscription</h2>
            <p class="muted">Update the card, switch plans, download invoices, or cancel — all in the secure Stripe portal.</p>
            <form method="post" action={`${base}/billing/portal`}>
              <button class="btn small" type="submit" data-busy="Opening…">Open billing portal →</button>
            </form>
          </section>
        ) : (
          <section class="card">
            <h2>Subscribe</h2>
            <p class="muted">{state === 'trial'
              ? `Your free trial runs for another ${daysLeft} days — subscribe any time and nothing changes except the peace of mind.`
              : state === 'grace'
                ? 'Your trial has ended: mail still arrives, but replies are paused. Subscribe to pick up right where you left off.'
                : state === 'expired'
                  ? 'This address is inactive. Subscribe to reactivate it — threads and history are still here.'
                  : 'Pick a plan — you finish on Stripe’s secure checkout page.'}</p>
            <form method="post" action={`${base}/billing/checkout`} class="me-form">
              <label class="lbl">Plan</label>
              <div class="level-cards">
                {Object.entries(PLAN_INFO).filter(([key]) => key !== 'duo').map(([key, p]) => (
                  <label class="level-card">
                    <input type="radio" name="plan" value={key} checked={key === collective.plan || (collective.plan === 'duo' && key === 'collective')} />
                    <span><b>{p.label}</b><small>{p.price(sym)}{p.seats ? ` · ${p.seats} contributors` : ' · your own domain · unlimited contributors'} · unlimited readers</small></span>
                  </label>
                ))}
              </div>
              <label class="lbl">Billing cycle</label>
              <div class="level-cards">
                <label class="level-card"><input type="radio" name="cycle" value="monthly" checked /><span><b>Monthly</b></span></label>
                <label class="level-card"><input type="radio" name="cycle" value="yearly" /><span><b>Yearly</b><small>2 months free</small></span></label>
              </div>
              <div class="btn-row">
                <button class="btn" type="submit" data-busy="Redirecting to Stripe…">Continue to checkout →</button>
              </div>
              <p class="fineprint">Billed in {currency === 'eur' ? 'euros (€)' : 'US dollars ($)'}.</p>
            </form>
          </section>
        )}
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/billing/checkout', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  if (!(await stripeUsable())) return c.redirect(`${base}/billing?m=` + encodeURIComponent('Online payment is not available right now.'))
  const body = await c.req.parseBody()
  const plan = ['duo', 'collective', 'pro'].includes(String(body.plan)) ? String(body.plan) : 'collective'
  const cycle = String(body.cycle) === 'yearly' ? 'yearly' as const : 'monthly' as const
  // never taken from the form: the visitor doesn't choose, we detect
  const currency = visitorCurrency(c) === 'EUR' ? 'eur' as const : 'usd' as const
  try {
    const collective = (await getCollective(t.collective.id))!
    const url = await createCheckoutSession(collective, t.member.email, plan, cycle, currency)
    return c.redirect(url)
  } catch (err) {
    return c.redirect(`${base}/billing?m=` + encodeURIComponent(`Checkout failed: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

// ---------- Pro: your own domain ----------

const DomainUpsell = (p: { base: string; balance: number; currency: 'eur' | 'usd'; canPay: boolean }) => {
  const s = p.currency === 'eur' ? '€' : '$'
  return (
    <div class="page">
      <h1>Your own domain</h1>
      <SettingsNav base={p.base} on="domain" />
      <p class="muted">Receive and answer as <b>hello@yourcollective.org</b> — same shared inbox, your identity. This is the Pro plan ({s}100 a month). Like everything here: pay, use a code, spend credits, or contribute.</p>

      {p.canPay ? (
      <section class="card">
        <h2>Subscribe to Pro</h2>
        <form method="post" action={`${p.base}/billing/checkout`} class="btn-row">
          <input type="hidden" name="plan" value="pro" />
          <button class="btn small" name="cycle" value="monthly" type="submit" data-busy="Opening…">{s}100 / month</button>
          <button class="btn small ghost" name="cycle" value="yearly" type="submit" data-busy="Opening…">{s}1,000 / year — 2 months free</button>
        </form>
      </section>
      ) : null}

      <section class="card">
        <h2>Have a discount code?</h2>
        <form method="post" action={`${p.base}/domain/discount`} class="assign-form">
          <input class="input" name="code" placeholder="yourslug-pro-xxxxxxxx" autocomplete="off" spellcheck={false} />
          <button class="btn small ghost" type="submit" data-busy="Checking…">Redeem</button>
        </form>
      </section>

      <section class="card">
        <h2>Use your credits</h2>
        <p class="muted">Credits are worth one Collective month ({s}10) each, so a Pro month is <b>{String(PRO_MONTH_CREDITS)} credits</b>. You have <b>{String(p.balance)}</b>.</p>
        {p.balance >= PRO_MONTH_CREDITS ? (
          <form method="post" action={`${p.base}/domain/credits`}>
            <button class="btn small" type="submit" data-busy="Redeeming…">Use {String(PRO_MONTH_CREDITS)} credits → 1 month of Pro</button>
          </form>
        ) : (
          <p class="fineprint">Earn more by referring collectives (see Billing).</p>
        )}
      </section>
      {/* Pay-by-contribution applications are hidden for now (POST /domain/apply still exists). */}
    </div>
  )
}

app.get('/inbox/:addr/domain', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { member } = t
  const base = `/inbox/${t.collective.slug}`
  if (member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  const currency = visitorCurrency(c) === 'EUR' ? 'eur' as const : 'usd' as const

  if (collective.plan !== 'pro') {
    return c.html(
      <Shell member={member} collective={collective} title="Your domain" active="domain" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
        <DomainUpsell base={base} balance={await creditBalance(collective.id)} currency={currency} canPay={await stripeUsable()} />
      </Shell>,
    )
  }

  const domain = collective.resend_domain_id ? await getResendDomain(collective.resend_domain_id) : null
  const customAddr = collective.custom_domain ? `${collective.custom_local}@${collective.custom_domain}` : null
  let verified = collective.domain_status === 'verified'
  if (!verified && domain?.status === 'verified') {
    // Resend finished its (asynchronous) check since we last looked — bank it
    // now, so no section of this page claims we're still waiting on DNS
    await run("UPDATE collectives SET domain_status = 'verified' WHERE id = ?", [collective.id])
    verified = true
  }
  return c.html(
    <Shell member={member} collective={collective} title="Your domain" active="domain" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Your own domain</h1>
        <SettingsNav base={base} on="domain" />
        {!customAddr ? (
          <section class="card">
            <h2>Which address should reach this inbox?</h2>
            <p class="muted">Usually <b>hello@</b> your collective's domain. Everything sent there will land here, and once your domain is verified, replies go out from it too.</p>
            <form method="post" action={`${base}/domain`} class="btn-row" style="flex-wrap:wrap">
              <input class="input" name="local" placeholder="hello" style="max-width:130px" required />
              <span style="align-self:center">@</span>
              <input class="input" name="domain" placeholder="yourcollective.org" style="max-width:240px" required />
              <button class="btn small" type="submit" data-busy="Setting up…">Set up</button>
            </form>
          </section>
        ) : (<>
          <p class="muted">Connecting <b>{customAddr}</b> to this inbox.</p>

          <section class="card">
            <h2>1 · Receiving {collective.receive_mode === 'mx' ? '' : '— forward your mail here'}</h2>
            {collective.receive_mode === 'mx' ? (
              <>
                <p class="muted">Your domain's mail (MX) points at us — every address at <b>{collective.custom_domain}</b> lands in this inbox. The MX record is in the table below with the sending records.</p>
                <p class="fineprint">⚠ MX takeover means personal mailboxes at this domain stop working. If anyone has one, switch to forwarding instead.</p>
              </>
            ) : (
              <>
                <p class="muted">Keep your current mailbox and add a forward from <b>{customAddr}</b> to <b>{collective.slug}@{cfg.emailDomain}</b>:</p>
                <ul class="muted" style="padding-left:20px;font-size:14px">
                  <li><b>Gmail / Google Workspace</b>: Settings → Forwarding → Add a forwarding address. Google then sends a confirmation — <b>it will appear right here in this inbox</b>; any admin clicks the link and you're done.</li>
                  <li><b>Registrar alias</b> (Gandi, OVH, Namecheap…): create a forward/alias for {collective.custom_local}@ pointing to {collective.slug}@{cfg.emailDomain}.</li>
                </ul>
                <form method="post" action={`${base}/domain/test`} class="btn-row">
                  <button class="btn small ghost" type="submit" data-busy="Sending…">Send a test email to {customAddr}</button>
                </form>
                <p class="fineprint">The test should appear in this inbox within a minute — that proves the forward works. Prefer a full takeover? <form method="post" action={`${base}/domain/mx`} class="inline"><button class="linkish" type="submit" data-confirm={`Point ALL mail for ${collective.custom_domain} here? Personal mailboxes at this domain will stop receiving. Use forwarding if anyone has one.`}>Switch to MX</button></form></p>
              </>
            )}
          </section>

          <section class="card">
            <h2>2 · Sending — verify your domain {verified ? '✓' : ''}</h2>
            {verified ? (
              <p class="muted">✓ <b>{collective.custom_domain}</b> is verified — replies now go out as <b>{customAddr}</b>.</p>
            ) : (
              <>
                <p class="muted">Add these DNS records where your domain lives. Being able to add them is the proof of ownership — the moment they're detected, replies switch from {collective.slug}@{cfg.emailDomain} to <b>{customAddr}</b>. Until then we send as <i>“{collective.name} · {customAddr}”</i>.</p>
                {domain && domain.records.length > 0 ? (
                  <div class="admin-list">
                    {domain.records.map((rec) => (
                      <div class="admin-row" style="align-items:center">
                        <b style="min-width:46px">{rec.type}</b>
                        <code style="font-size:11.5px">{rec.name}</code>
                        <code style="font-size:11.5px;overflow-wrap:anywhere;flex:1">{rec.value}</code>
                        <button class="btn small ghost" type="button" data-copy={rec.value}>Copy</button>
                        <small title={rec.status === 'verified' ? 'found in DNS' : 'being checked'}>{rec.status === 'verified' ? '✓' : '…'}</small>
                      </div>
                    ))}
                  </div>
                ) : <p class="fineprint">Could not load the DNS records — try “Check verification”.</p>}
                <p class="fineprint">✓ found in DNS · … still being checked — while a re-check runs, even records that were ✓ show as … for a minute. Nothing is lost.</p>
                <form method="post" action={`${base}/domain/verify`} class="btn-row">
                  <button class="btn small" type="submit" data-busy="Checking…">Check verification</button>
                </form>
              </>
            )}
          </section>

          <section class="card">
            <h2>Status</h2>
            <span class="kv"><span class="k">RECEIVING</span> <span>{collective.receive_mode === 'mx' ? 'MX → this inbox' : 'forwarding (managed by you)'}</span></span>
            <span class="kv"><span class="k">SENDING</span> <span>{verified ? `as ${customAddr} ✓` : `as ${collective.slug}@${cfg.emailDomain} (until DNS verifies)`}</span></span>
            <form method="post" action={`${base}/domain/remove`} class="btn-row">
              <button class="linkish danger" type="submit" data-confirm={`Disconnect ${customAddr}? Replies revert to ${collective.slug}@${cfg.emailDomain}; remember to remove your forward or MX records.`}>Disconnect this domain</button>
            </form>
          </section>
        </>)}
      </div>
    </Shell>,
  )
})

app.post('/inbox/:addr/domain', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (collective.plan !== 'pro') return c.redirect(`${base}/domain`)
  const body = await c.req.parseBody()
  const local = String(body.local || '').toLowerCase().trim()
  const domainName = String(body.domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!validLocalPart(local) || !validDomainName(domainName)) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent('That does not look like a valid address — check the local part and the domain.'))
  }
  const taken = await get<Collective>('SELECT * FROM collectives WHERE custom_domain = ? AND id != ?', [domainName, collective.id])
  if (taken) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(`${domainName} is already connected to another collective on collective.email. If that's yours and shouldn't be, email hello@collective.email.`))
  }
  try {
    const created = await createResendDomain(domainName)
    const status = created.status === 'verified' ? 'verified' : 'pending'
    await run("UPDATE collectives SET custom_domain = ?, custom_local = ?, resend_domain_id = ?, domain_status = ?, receive_mode = 'forwarding' WHERE id = ?",
      [domainName, local, created.id, status, collective.id])
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(status === 'verified'
      ? `${local}@${domainName} is set up — the domain was already verified, so replies go out as it right away. Just add the forward.`
      : `${local}@${domainName} is set up — add the forward and the DNS records.`))
  } catch (err) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(err instanceof Error ? err.message : 'Could not create the domain.'))
  }
})

app.post('/inbox/:addr/domain/verify', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (!collective.resend_domain_id) return c.redirect(`${base}/domain`)
  const done = () => c.redirect(`${base}/domain?m=` + encodeURIComponent(`✓ ${collective.custom_domain} verified — replies now go out as ${collective.custom_local}@${collective.custom_domain}.`))

  // Read BEFORE triggering: the trigger resets Resend's per-record statuses to
  // pending while its async check runs, which is exactly the "my checkmarks
  // disappeared" effect — and it threw away a finished verification to boot.
  let domain = await getResendDomain(collective.resend_domain_id)
  if (domain?.status === 'verified') {
    await run("UPDATE collectives SET domain_status = 'verified' WHERE id = ?", [collective.id])
    return done()
  }
  await verifyResendDomain(collective.resend_domain_id).catch(() => {})
  // fast checks often land within seconds — give it a short moment before
  // sending the user back to a page that says "pending"
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    domain = await getResendDomain(collective.resend_domain_id)
    if (domain?.status === 'verified') {
      await run("UPDATE collectives SET domain_status = 'verified' WHERE id = ?", [collective.id])
      return done()
    }
  }
  return c.redirect(`${base}/domain?m=` + encodeURIComponent('Re-check started — records already in DNS usually confirm within a minute or two. This page also re-checks itself every hour, so you can simply come back.'))
})

app.post('/inbox/:addr/domain/mx', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (!collective.resend_domain_id) return c.redirect(`${base}/domain`)
  try {
    await enableDomainReceiving(collective.resend_domain_id)
    await run("UPDATE collectives SET receive_mode = 'mx' WHERE id = ?", [collective.id])
    return c.redirect(`${base}/domain?m=` + encodeURIComponent('MX receiving enabled — the MX record to add is now in the DNS table.'))
  } catch (err) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(err instanceof Error ? err.message : 'Could not enable MX receiving.'))
  }
})

app.post('/inbox/:addr/domain/test', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (!collective.custom_domain) return c.redirect(`${base}/domain`)
  const addr = `${collective.custom_local}@${collective.custom_domain}`
  await sendAppEmail({
    to: addr,
    subject: `Forwarding test for ${addr} ✓`,
    text: `If you can read this in the ${collective.slug}@${cfg.emailDomain} inbox, the forward from ${addr} works. — collective.email`,
    html: `<p>If you can read this in the <b>${escapeHtml(collective.slug)}@${escapeHtml(cfg.emailDomain)}</b> inbox, the forward from <b>${escapeHtml(addr)}</b> works.</p><p>— collective.email</p>`,
  })
  return c.redirect(`${base}/domain?m=` + encodeURIComponent(`Test sent to ${addr} — it should appear in this inbox within a minute.`))
})

app.post('/inbox/:addr/domain/remove', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  if (collective.resend_domain_id) await deleteResendDomain(collective.resend_domain_id).catch(() => {})
  await run('UPDATE collectives SET custom_domain = NULL, custom_local = NULL, resend_domain_id = NULL, domain_status = NULL, receive_mode = NULL WHERE id = ?', [collective.id])
  return c.redirect(`${base}/domain?m=` + encodeURIComponent('Domain disconnected.'))
})

app.post('/inbox/:addr/domain/discount', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const redemption = checkDiscountCode(t.collective.slug, String((await c.req.parseBody()).code || ''))
  if (!redemption || redemption.plan !== 'pro') {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent('That code is not a Pro code for this address.'))
  }
  const collective = (await getCollective(t.collective.id))!
  if (redemption.duration === 'forever') {
    await run("UPDATE collectives SET plan = 'pro', comped = 1 WHERE id = ?", [collective.id])
  } else {
    await run("UPDATE collectives SET plan = 'pro', trial_ends_at = ? WHERE id = ?",
      [Math.max(collective.trial_ends_at || 0, now()) + redemption.duration * 30 * 86400, collective.id])
  }
  return c.redirect(`${base}/domain?m=` + encodeURIComponent(redemption.duration === 'forever' ? 'Welcome to Pro — forever. Set up your domain below.' : `Welcome to Pro — ${redemption.duration} months. Set up your domain below.`))
})

app.post('/inbox/:addr/domain/credits', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const collective = (await getCollective(t.collective.id))!
  const balance = await creditBalance(collective.id)
  if (balance < PRO_MONTH_CREDITS) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(`A Pro month costs ${PRO_MONTH_CREDITS} credits — you have ${balance}.`))
  }
  await mintCredits(collective.id, -PRO_MONTH_CREDITS, 'pro_month', 'admin', `member:${t.member.id}`)
  await run("UPDATE collectives SET plan = 'pro', trial_ends_at = ? WHERE id = ?",
    [Math.max(collective.trial_ends_at || 0, now()) + 30 * 86400, collective.id])
  return c.redirect(`${base}/domain?m=` + encodeURIComponent(`Welcome to Pro — 1 month (${balance - PRO_MONTH_CREDITS} credits left). Set up your domain below.`))
})

app.post('/inbox/:addr/domain/apply', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const body = await c.req.parseBody()
  const contribution = String(body.contribution || '').trim()
  const months = Math.min(12, Math.max(1, Number(body.months) || 2))
  if (contribution.length < 30) return c.redirect(`${base}/domain?m=` + encodeURIComponent('Tell us a bit more about what you would contribute.'))
  try {
    const collective = (await getCollective(t.collective.id))!
    await fileProApplication(collective, t.member.email, t.member.name || t.member.email, contribution.slice(0, 4000), months)
    return c.redirect(`${base}/domain?m=` + encodeURIComponent('Application sent — we usually answer within a day.'))
  } catch (err) {
    return c.redirect(`${base}/domain?m=` + encodeURIComponent(err instanceof Error ? err.message : 'Could not send the application.'))
  }
})

app.get('/inbox/:addr/export', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  if (t.member.role !== 'admin') return c.redirect(`/inbox/${t.collective.slug}/billing`)
  const collective = (await getCollective(t.collective.id))!
  const { buildArchive } = await import('../export.js')
  const zip = await buildArchive(collective)
  c.header('Content-Type', 'application/zip')
  c.header('Content-Disposition', `attachment; filename="${collective.slug}-collective.email-archive.zip"`)
  c.header('Cache-Control', 'no-store')
  return c.body(zip.slice().buffer as ArrayBuffer)
})

app.post('/inbox/:addr/billing/contribute', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  const body = await c.req.parseBody()
  const text = String(body.text || '').trim()
  if (text.length < 20) return c.redirect(`${base}/billing?m=` + encodeURIComponent('Tell us a bit more about the contribution.'))
  try {
    const collective = (await getCollective(t.collective.id))!
    await fileContribution(collective, t.member, text.slice(0, 4000))
    return c.redirect(`${base}/billing?m=` + encodeURIComponent('Contribution submitted — we usually answer within a day. Thank you! 🙌'))
  } catch (err) {
    return c.redirect(`${base}/billing?m=` + encodeURIComponent(err instanceof Error ? err.message : 'Could not submit.'))
  }
})

app.post('/inbox/:addr/billing/portal', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const base = `/inbox/${t.collective.slug}`
  if (t.member.role !== 'admin') return c.redirect(base)
  try {
    const collective = (await getCollective(t.collective.id))!
    if (!collective.stripe_customer_id) throw new Error('No Stripe customer yet.')
    const url = await createPortalSession(collective.stripe_customer_id, `${cfg.baseUrl}${base}/billing`)
    return c.redirect(url)
  } catch (err) {
    return c.redirect(`${base}/billing?m=` + encodeURIComponent(`Could not open the portal: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

// ---------- public claiming: verify email → pay / discount / apply ----------

/** Server-rendered OC state (progressive enhancement; the live script keeps it
 *  in sync as the slug is typed). `oc` present only after a submit that surfaced
 *  a contactable/uncontactable collective. */
/** Where you are in claiming an address: pick it, say who you are, invite the
 *  rest. Shown on every step so the end is always in sight. */
const Steps = ({ current }: { current: 1 | 2 | 3 }) => (
  <ol class="flow-steps" aria-label={`Step ${current} of 3`}>
    {['Claim address', 'Set first admin', 'Invite others'].map((label, i) => {
      const n = i + 1
      return (
        <li class={n === current ? 'on' : n < current ? 'done' : ''}>
          <span class="n">{n < current ? '✓' : String(n)}</span>
          <span class="t">{label}</span>
        </li>
      )
    })}
  </ol>
)

/** Step 1 — the address, checked live as it's typed.
 *
 *  A name that already exists on Open Collective is settled HERE: whether you
 *  may have this address is the question step 1 asks, so proving it (or picking
 *  another) happens before anyone is asked who the first admin is. */
const ClaimForm = (p: {
  address?: string; error?: string; slugError?: string; refSlug?: string
  oc?: { kind: 'contactable' | 'uncontactable'; name: string; admins?: string[] }
  /** a code is out with the collective's OC admins, waiting to be entered */
  ocCode?: { error?: string; resend?: boolean }
}) => {
  const gated = Boolean(p.oc)
  const ocUrl = `https://opencollective.com/${p.address}`
  const claimAddr = `${p.address}@${cfg.emailDomain}`
  const ref = p.refSlug ? `&ref=${encodeURIComponent(p.refSlug)}` : ''
  return (
    <AuthCard title="Claim your address" flash={p.error}>
      <Steps current={1} />
      <h1>Claim your address</h1>
      <p class="muted">Pick your collective's email address. You'll confirm it with a 6-digit code and it's reserved for you.</p>
      <form method="get" action="/claim">
        {p.refSlug ? <input type="hidden" name="ref" value={p.refSlug} /> : null}
        <label class="lbl">Your collective's address</label>
        <span class="wl-addr">
          <input id="claim-address" name="address" value={p.address || ''} placeholder="yourcollective" minlength={6} maxlength={40} pattern="[a-z0-9]{6,40}" autocomplete="off" spellcheck={false} autofocus={!gated} required />
          <span class="domain">@{cfg.emailDomain}</span>
        </span>
        {/* data-gated: the panel below already explains this exact name, so the
            live check stays quiet about it and only speaks up for a new one */}
        <p id="oc-status" class="oc-status" data-gated={gated ? p.address : ''}>
          {p.slugError ? (
            <span class="oc-bad">{p.slugError}</span>
          ) : gated ? (
            <span class="fineprint">Type another name to claim a different address.</span>
          ) : (
            <span class="fineprint">At least 6 characters — letters and numbers only.</span>
          )}
        </p>
        <button class={`btn ${gated ? 'ghost' : ''}`} id="claim-submit" type="submit">
          {gated ? 'Check this one instead' : 'Claim it →'}
        </button>
      </form>

      {p.ocCode ? (
        // the code is out with the collective's admins — entering it is what
        // proves ownership, and only then does step 2 open
        <div class="oc-gate">
          <p class="oc-status"><span class="oc-warn">📨 We sent a 6-digit code to the {p.oc?.admins?.length ?? ''} admin{p.oc?.admins?.length === 1 ? '' : 's'} of <b>{p.oc?.name}</b> on Open Collective{p.oc?.admins?.length ? ` (${p.oc.admins.join(', ')})` : ''}. Whoever receives it can enter it here.</span></p>
          {p.ocCode.error ? <p class="error">{p.ocCode.error}</p> : null}
          <form method="post" action={p.ocCode.resend ? '/claim/oc-send' : '/claim/oc-code'}>
            <input type="hidden" name="address" value={p.address} />
            {p.refSlug ? <input type="hidden" name="ref" value={p.refSlug} /> : null}
            {p.ocCode.resend ? null : (
              <input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder="······" autofocus required />
            )}
            <button class="btn" type="submit" data-busy={p.ocCode.resend ? 'Sending…' : 'Checking…'}>
              {p.ocCode.resend ? 'Send a new code' : 'Verify & continue →'}
            </button>
          </form>
          <p class="fineprint">Code expires in 10 minutes. Not your collective? Pick another address above.</p>
        </div>
      ) : p.oc?.kind === 'uncontactable' ? (
        <div class="oc-gate">
          <p class="oc-status"><span class="oc-warn">⚠ <b>{p.oc.name}</b> is already claimed on Open Collective (<a href={ocUrl} target="_blank" rel="noopener">{`opencollective.com/${p.address}`}</a>), and its contact form is off so we can't message its admins. If it's yours, prove you manage it: add <code>{claimAddr}</code> to the collective's description there — you'll want to advertise it anyway. Or email hello@collective.email.</span></p>
          <form method="post" action="/claim/oc-verify">
            <input type="hidden" name="address" value={p.address} />
            {p.refSlug ? <input type="hidden" name="ref" value={p.refSlug} /> : null}
            <button class="btn" type="submit" data-busy="Checking…">I've added it — verify &amp; continue</button>
          </form>
        </div>
      ) : p.oc?.kind === 'contactable' ? (
        <div class="oc-gate">
          <p class="oc-status"><span class="oc-warn">⚠ <b>{p.oc.name}</b> is already claimed on Open Collective (<a href={ocUrl} target="_blank" rel="noopener">{`opencollective.com/${p.address}`}</a>).
            {' '}If it's your collective and you're one of its admins, we can send a 6-digit code to
            {' '}its {p.oc.admins!.length} admin{p.oc.admins!.length === 1 ? '' : 's'} ({p.oc.admins!.join(', ')}) to confirm.
            {' '}Otherwise pick another address above.</span></p>
          <form method="post" action="/claim/oc-send">
            <input type="hidden" name="address" value={p.address} />
            {p.refSlug ? <input type="hidden" name="ref" value={p.refSlug} /> : null}
            <button class="btn" type="submit" data-busy="Sending…"
              data-confirm={`This messages the ${p.oc.admins!.length} admin${p.oc.admins!.length === 1 ? '' : 's'} of ${p.oc.name} on Open Collective. Continue?`}>
              Send a code to its admins
            </button>
          </form>
        </div>
      ) : null}
      <script dangerouslySetInnerHTML={{ __html: CLAIM_SCRIPT }} />
    </AuthCard>
  )
}

/** Step 2 — the address is settled (one line, editable); this page is about
 *  who the first admin is, since that's who receives the collective's mail. */
const AdminForm = (p: {
  address: string; name?: string; email?: string; error?: string; slugError?: string; refSlug?: string
  /** short-lived signature that step 1 settled ownership (OC code, or the
   *  address advertised in the collective's description) */
  proof?: string
}) => {
  const claimAddr = `${p.address}@${cfg.emailDomain}`
  return (
    <AuthCard title="Set the first admin" flash={p.error}>
      <Steps current={2} />
      {/* what step 1 settled — sits with that step, and reads as its result
          rather than as the answer to the question below */}
      <p class="claimed-addr">
        <span class="tick" aria-hidden="true">✓</span>
        <b>{claimAddr}</b>
        <a class="edit-link" href={`/claim?address=${encodeURIComponent(p.address)}&edit=1`}>edit</a>
      </p>
      <h1>Who's the first admin?</h1>
      <p class="muted">They receive everything sent to this address, and can invite the rest of the collective — as readers, commenters or senders.</p>
      <form method="post" action="/claim">
        <input type="hidden" name="address" value={p.address} />
        {p.refSlug ? <input type="hidden" name="ref" value={p.refSlug} /> : null}
        {p.proof ? <input type="hidden" name="proof" value={p.proof} /> : null}
        {p.slugError ? <p class="oc-status"><span class="oc-bad">{p.slugError}</span></p> : null}
        <label class="lbl">Their name</label>
        <input class="input" name="name" value={p.name || ''} placeholder="First name" autofocus required />
        <label class="lbl">Their personal email</label>
        <input class="input" type="email" name="email" value={p.email || ''} placeholder="you@example.com" required />
        <p class="fineprint">Personal, not the collective's — this is how they sign in and get notified.</p>
        {/* Always to this address: step 2 verifies the admin's own email.
            Whether the collective is theirs was settled back in step 1. */}
        <button class="btn" type="submit" data-busy="Sending code…">Send me a code</button>
      </form>
    </AuthCard>
  )
}

const CLAIM_SCRIPT = `
(function(){
  var addr=document.getElementById('claim-address');
  var submit=document.getElementById('claim-submit');
  var status=document.getElementById('oc-status');
  if(!addr) return;
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function slugify(v){return v.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,40);}
  var gated=status.getAttribute('data-gated')||'';
  function render(d,slug){
    submit.disabled=false;
    if(d.unavailable){status.innerHTML='<span class="oc-bad">'+esc(d.unavailable)+'</span>';submit.disabled=true;return;}
    var oc=d.oc||{kind:'none'};
    if(slug===gated&&oc.kind!=='none'){
      status.innerHTML='<span class="fineprint">Type another name to claim a different address.</span>';
      return;
    }
    if(oc.kind==='contactable'){
      status.innerHTML='<span class="oc-warn">⚠ <b>'+esc(oc.name)+'</b> is already claimed on Open Collective — if you are one of its admins you can confirm it on the next step.</span>';
    }else if(oc.kind==='uncontactable'){
      status.innerHTML='<span class="oc-warn">⚠ <b>'+esc(oc.name)+'</b> exists on Open Collective — one extra step to prove you manage it.</span>';
    }else{
      status.innerHTML='<span class="oc-ok">✓ '+esc(slug)+'@collective.email is available</span>';
    }
  }
  var timer;
  function check(){
    var slug=slugify(addr.value);
    if(slug.length<6){submit.disabled=false;status.innerHTML='<span class="fineprint">At least 6 characters — letters and numbers only.</span>';return;}
    // a failed check must never strand the button disabled — let the server decide
    fetch('/claim/oc?slug='+encodeURIComponent(slug)).then(function(r){return r.json();})
      .then(function(d){if(slugify(addr.value)===slug)render(d,slug);})
      .catch(function(){submit.disabled=false;});
  }
  // re-enable the moment the name changes: the refusal belonged to the old one,
  // and the check below (or the server) will say no again if it still applies
  addr.addEventListener('input',function(){submit.disabled=false;clearTimeout(timer);timer=setTimeout(check,400);});
  addr.addEventListener('blur',function(){clearTimeout(timer);check();});
  if(slugify(addr.value).length>=6) check();
})();
`

/** Proof that the step-1 description check passed, carried to step 2 so the
 *  claim isn't gated twice. Short-lived and signed — it only ever asserts
 *  "opencollective.com/<slug> advertised this address a moment ago". */
const OC_PROOF_TTL = 30 * 60
const ocProof = (slug: string) => signToken({ a: 'ocproof', s: slug }, OC_PROOF_TTL)
const ocProofValid = (token: string | undefined | null, slug: string) => {
  if (!token) return false
  const payload = verifyToken(token)
  return Boolean(payload && payload.a === 'ocproof' && payload.s === slug)
}

/** Step 1 with no address (or ?edit=1), and step 1 again while the address is
 *  still contested on Open Collective; step 2 only once it is settled. */
app.get('/claim', async (c) => {
  const address = slugify(c.req.query('address') || '')
  const refSlug = slugify(c.req.query('ref') || '') || undefined
  const error = c.req.query('m')
  if (!address || c.req.query('edit')) return c.html(<ClaimForm address={address} refSlug={refSlug} error={error} />)

  // the address arrived from elsewhere — re-check it before building on it
  const unavailable = await slugAvailability(address)
  if (unavailable) return c.html(<ClaimForm address={address} refSlug={refSlug} slugError={unavailable} error={error} />)
  const info = await ocCollectiveInfo(address)
  if (info.kind === 'unknown' && await ocSlugTaken(address)) {
    return c.html(<ClaimForm address={address} refSlug={refSlug} slugError={OC_TAKEN_MSG(address)} error={error} />)
  }

  const proof = c.req.query('p')
  const proven = ocProofValid(proof, address)
  // Whether this address can be yours is step 1's question — don't ask who the
  // first admin is until it has an answer.
  if (info.kind === 'uncontactable' && !proven) {
    return c.html(<ClaimForm address={address} refSlug={refSlug} error={error} oc={{ kind: 'uncontactable', name: info.name }} />)
  }
  if (info.kind === 'contactable' && !proven) {
    return c.html(<ClaimForm address={address} refSlug={refSlug} error={error} oc={{ kind: 'contactable', name: info.name, admins: info.admins }} />)
  }
  return c.html(<AdminForm address={address} refSlug={refSlug} error={error} proof={proven ? proof! : undefined} />)
})

/** Live check for the claim form: availability + Open Collective status. */
app.get('/claim/oc', async (c) => {
  const slug = slugify(c.req.query('slug') || '')
  const unavailable = await slugAvailability(slug)
  if (unavailable) return c.json({ unavailable, oc: { kind: 'none' } })
  const info = await ocCollectiveInfo(slug)
  if (info.kind === 'contactable') return c.json({ unavailable: null, oc: { kind: 'contactable', name: info.name, admins: info.admins } })
  if (info.kind === 'uncontactable') return c.json({ unavailable: null, oc: { kind: 'uncontactable', name: info.name } })
  if (info.kind === 'unknown' && await ocSlugTaken(slug)) {
    // Can't verify ownership (no OC token / API down) but the name exists there.
    return c.json({ unavailable: OC_TAKEN_MSG(slug), oc: { kind: 'none' } })
  }
  return c.json({ unavailable: null, oc: { kind: 'none' }, available: `${slug}@${cfg.emailDomain} is available` })
})

const emailLooksValid = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)

const OC_TAKEN_MSG = (slug: string) =>
  `"${slug}" belongs to a collective on opencollective.com — we couldn't verify ownership automatically. Email hello@collective.email and we'll sort it out.`

app.post('/claim', async (c) => {
  const body = await c.req.parseBody()
  const address = String(body.address || '').toLowerCase().trim()
  const name = String(body.name || '').trim().slice(0, 60)
  const email = String(body.email || '').toLowerCase().trim()
  const refSlug = slugify(String(body.ref || ''))
  // errors keep you on step 2 with what you typed; a bad address sends you back to step 1
  const form = (extra: Partial<Parameters<typeof AdminForm>[0]>) => <AdminForm address={address} name={name} email={email} refSlug={refSlug || undefined} {...extra} />

  const unavailable = await slugAvailability(address)
  if (unavailable) return c.html(<ClaimForm address={address} refSlug={refSlug || undefined} slugError={unavailable} />)
  if (!emailLooksValid(email)) return c.html(form({ error: "That email address doesn't look right." }))

  const info = await ocCollectiveInfo(address)
  // step 1 already settled ownership — otherwise send them back to settle it,
  // and never message Open Collective from here whatever we were handed
  if (!ocProofValid(String(body.proof || ''), address)) {
    if (info.kind === 'contactable' || info.kind === 'uncontactable') {
      return c.html(
        <ClaimForm address={address} refSlug={refSlug || undefined}
          oc={info.kind === 'contactable'
            ? { kind: 'contactable', name: info.name, admins: info.admins }
            : { kind: 'uncontactable', name: info.name }} />)
    }
  }
  if (info.kind === 'unknown' && await ocSlugTaken(address)) {
    // Can't verify ownership (no OC token / API down) but the name exists there — don't let it be squatted.
    return c.html(<ClaimForm address={address} refSlug={refSlug || undefined} slugError={OC_TAKEN_MSG(address)} />)
  }
  // none, or unknown-and-free → ordinary claim to the personal email
  await issueCode(email, 'claim', { name, claimSlug: address, claimRef: refSlug || undefined })
  return c.html(<CodeForm email={email} claiming />)
})

/** The one route that messages a collective's Open Collective admins, reached
 *  only from the explicit "send a code to its admins" button. Step 1: it
 *  proves the collective is yours, and mints nothing but that. */
app.post('/claim/oc-send', async (c) => {
  const body = await c.req.parseBody()
  const address = String(body.address || '').toLowerCase().trim()
  const refSlug = slugify(String(body.ref || ''))
  const step1 = (extra: Partial<Parameters<typeof ClaimForm>[0]>) =>
    <ClaimForm address={address} refSlug={refSlug || undefined} {...extra} />

  const unavailable = await slugAvailability(address)
  if (unavailable) return c.html(step1({ slugError: unavailable }))

  // re-check rather than trusting the form: the button was rendered a while ago
  const info = await ocCollectiveInfo(address)
  if (info.kind === 'uncontactable') return c.html(step1({ oc: { kind: 'uncontactable', name: info.name } }))
  if (info.kind !== 'contactable') {
    // nothing to prove any more — straight on to step 2
    return c.redirect(`/claim?address=${encodeURIComponent(address)}${refSlug ? `&ref=${encodeURIComponent(refSlug)}` : ''}`)
  }

  const oc = { kind: 'contactable' as const, name: info.name, admins: info.admins }
  const ok = await issueOcOwnershipCode(address, (code) => sendOcVerificationCode(address, code))
  if (!ok) return c.html(step1({ oc, error: "We couldn't reach the collective's admins just now — try again in a moment, or email hello@collective.email." }))
  return c.html(step1({ oc, ocCode: {} }))
})

/** Step 1: the code that went to the collective's OC admins, coming back.
 *  It can only unlock step 2 — it never signs anyone in. */
app.post('/claim/oc-code', async (c) => {
  const body = await c.req.parseBody()
  const address = String(body.address || '').toLowerCase().trim()
  const code = String(body.code || '').trim()
  const refSlug = slugify(String(body.ref || ''))
  const ref = refSlug ? `&ref=${encodeURIComponent(refSlug)}` : ''

  const unavailable = await slugAvailability(address)
  if (unavailable) return c.html(<ClaimForm address={address} refSlug={refSlug || undefined} slugError={unavailable} />)

  const info = await ocCollectiveInfo(address)
  const oc = info.kind === 'contactable'
    ? { kind: 'contactable' as const, name: info.name, admins: info.admins }
    : undefined
  const result = await checkOcOwnershipCode(address, code)
  if (!result.ok) {
    return c.html(<ClaimForm address={address} refSlug={refSlug || undefined} oc={oc} ocCode={{ error: result.error, resend: result.resend }} />)
  }
  return c.redirect(`/claim?address=${encodeURIComponent(address)}&p=${encodeURIComponent(ocProof(address))}${ref}`)
})

/** Ownership proof for a collective we can't message: the admin advertised the
 *  address in its OC description. This is a step-1 gate — it settles whether
 *  the address can be claimed, and unlocks step 2. No code is issued here. */
app.post('/claim/oc-verify', async (c) => {
  const body = await c.req.parseBody()
  const address = String(body.address || '').toLowerCase().trim()
  const refSlug = slugify(String(body.ref || ''))
  const ref = refSlug ? `&ref=${encodeURIComponent(refSlug)}` : ''
  const step1 = (extra: Partial<Parameters<typeof ClaimForm>[0]>) =>
    <ClaimForm address={address} refSlug={refSlug || undefined} {...extra} />

  const unavailable = await slugAvailability(address)
  if (unavailable) return c.html(step1({ slugError: unavailable }))

  const info = await ocCollectiveInfo(address)
  if (info.kind === 'contactable') {
    // became reachable in the meantime — offer that route, don't take it
    return c.html(step1({ oc: { kind: 'contactable', name: info.name, admins: info.admins } }))
  }
  if (info.kind !== 'uncontactable') {
    // no collective / can't check → nothing to prove, straight on to step 2
    return c.redirect(`/claim?address=${encodeURIComponent(address)}${ref}`)
  }
  const found = await ocDescriptionContains(address, `${address}@${cfg.emailDomain}`)
  if (!found) {
    return c.html(step1({
      oc: { kind: 'uncontactable', name: info.name },
      error: "We couldn't find that line in the collective's description yet. Save it on Open Collective (it can take a moment) and try again.",
    }))
  }
  // editing the profile proves admin control — carry that to step 2
  return c.redirect(`/claim?address=${encodeURIComponent(address)}&p=${encodeURIComponent(ocProof(address))}${ref}`)
})

/** Activation page for a reserved (pending/applied) address. */
app.get('/claim/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (c.get('accounts').length === 0) return c.redirect('/login?next=' + encodeURIComponent(`/claim/${slug}`))
  const collective = await getCollectiveBySlug(slug)
  const member = collective ? await memberAmongAccounts(c, collective.id) : undefined
  if (!collective || !member) return c.notFound()
  if (collective.status === 'active') return c.redirect(`/inbox/${slug}`)
  const currency = visitorCurrency(c) === 'EUR' ? 'eur' : 'usd'
  const s = currency === 'eur' ? '€' : '$'
  // With no working Stripe key the subscribe card would only dead-end people —
  // hide it and lead with the free trial instead.
  const canPay = await stripeUsable()
  return c.html(
    <AuthCard title={`Activate ${slug}`} flash={c.req.query('m')}>
      <Steps current={3} />
      <h1>{slug}@{cfg.emailDomain} is reserved for you</h1>
      <p class="muted">{collective.status === 'applied'
        ? 'Your free-trial application is being reviewed — we normally answer within a day. You can also activate right away:'
        : 'One last step — the reservation holds for 48 hours.'}</p>

      <section class="claim-option">
        <h2>Invite a teammate — free</h2>
        <p class="muted">A collective is at least two people. Share your invite link; the moment someone accepts, the address goes live with a month's trial — no card needed.</p>
        <a class="btn" href={`/claim/${slug}/invite`}>Get the invite link →</a>
      </section>

      {canPay ? (
      <section class="claim-option">
        <h2>Subscribe — {s}10/month</h2>
        <p class="muted">Unlimited readers, 10 contributors, 1,000 replies a month. Cancel anytime.</p>
        <form method="post" action={`/claim/${slug}/checkout`}>
          <div class="btn-row">
            <label class="level-card" style="flex:1"><input type="radio" name="cycle" value="monthly" checked /><span><b>{s}10 / month</b></span></label>
            <label class="level-card" style="flex:1"><input type="radio" name="cycle" value="yearly" /><span><b>{s}100 / year</b><small>save {s}20</small></span></label>
          </div>
          <button class="btn" type="submit" data-busy="Redirecting to Stripe…">Pay & activate →</button>
        </form>
      </section>
      ) : null}

      <section class="claim-option">
        <h2>Have a discount code?</h2>
        <form method="post" action={`/claim/${slug}/discount`} class="assign-form">
          <input class="input" name="code" placeholder={`${slug}-xxxxxxxx`} autocomplete="off" spellcheck={false} />
          <button class="btn small ghost" type="submit" data-busy="Checking…">Redeem</button>
        </form>
      </section>
    </AuthCard>,
  )
})

async function pendingClaim(c: Context<Env>): Promise<{ collective: Collective; member: Member } | Response> {
  const slug = c.req.param('slug') || ''
  if (c.get('accounts').length === 0) return c.redirect('/login?next=' + encodeURIComponent(`/claim/${slug}`))
  const collective = await getCollectiveBySlug(slug)
  const member = collective ? await memberAmongAccounts(c, collective.id) : undefined
  if (!collective || !member || !['pending', 'applied'].includes(collective.status)) return c.notFound()
  return { collective, member }
}

app.post('/claim/:slug/checkout', async (c) => {
  const t = await pendingClaim(c)
  if (t instanceof Response) return t
  if (!(await stripeUsable())) return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent('Online payment is not available right now — start with the free trial.'))
  const body = await c.req.parseBody()
  const cycle = String(body.cycle) === 'yearly' ? 'yearly' as const : 'monthly' as const
  const currency = visitorCurrency(c) === 'EUR' ? 'eur' as const : 'usd' as const
  try {
    const url = await createCheckoutSession(t.collective, t.member.email, 'collective', cycle, currency)
    return c.redirect(url)
  } catch (err) {
    return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent(`Checkout failed: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

app.post('/claim/:slug/discount', async (c) => {
  const t = await pendingClaim(c)
  if (t instanceof Response) return t
  const body = await c.req.parseBody()
  const redemption = checkDiscountCode(t.collective.slug, String(body.code || ''))
  if (redemption === null) {
    return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent('That code is not valid for this address.'))
  }
  if (redemption.duration === 'forever') {
    await run("UPDATE collectives SET status = 'active', comped = 1, plan = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ?", [redemption.plan, now(), t.collective.id])
  } else {
    await run("UPDATE collectives SET status = 'active', trial_ends_at = ?, plan = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ?", [now() + redemption.duration * 30 * 86400, redemption.plan, now(), t.collective.id])
  }
  await sendOnboarding((await getCollective(t.collective.id))!, t.member.email).catch(() => {})
  const planNote = redemption.plan === 'pro' ? ' (Pro — set up your own domain from the menu)' : ''
  return c.redirect(`/inbox/${t.collective.slug}?m=` + encodeURIComponent(
    redemption.duration === 'forever' ? `Welcome! ${t.collective.slug}@${cfg.emailDomain} is live${planNote}.` : `Welcome! ${t.collective.slug}@${cfg.emailDomain} is live — ${redemption.duration} months free${planNote}.`))
})

/** Self-serve free trial: one month, no card, no review. The reservation is
 *  already email-verified (and ownership-verified for OC names), and the
 *  status guard means a collective can only take it once. */
/** Step 3 — the address works; now bring the rest of the collective in. */
app.get('/claim/:slug/invite', async (c) => {
  const slug = c.req.param('slug')
  if (c.get('accounts').length === 0) return c.redirect('/login?next=' + encodeURIComponent(`/claim/${slug}/invite`))
  const collective = await getCollectiveBySlug(slug)
  const member = collective ? await memberAmongAccounts(c, collective.id) : undefined
  if (!collective || !member || member.role !== 'admin') return c.notFound()

  let invite = await get<Invite>(
    'SELECT * FROM invites WHERE collective_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
    [collective.id, now()])
  if (!invite) {
    const token = randomToken(18)
    await run('INSERT INTO invites (collective_id, token, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [collective.id, token, 'reader', member.id, now(), now() + cfg.inviteHours * 3600])
    invite = (await get<Invite>('SELECT * FROM invites WHERE token = ?', [token]))!
  }
  const url = `${cfg.baseUrl}/join/${invite.token}`
  const addr = `${collective.slug}@${cfg.emailDomain}`
  const reserved = collective.status !== 'active'
  return c.html(
    <AuthCard title="Invite your collective" flash={c.req.query('m')}>
      <Steps current={3} />
      <h1>{reserved ? `One teammate away` : `${addr} is live 🎉`}</h1>
      {reserved ? (
        <p class="muted"><b>{addr}</b> is reserved. Share this link — the moment someone accepts, the address goes live with a month's free trial. Everyone signs in with their own email; no shared password.</p>
      ) : (
        <p class="muted">Share this link with your collective. Everyone signs in with their own email — no shared password. You choose what each person can do; they join as readers by default and you can change that any time.</p>
      )}
      <p class="invite-url"><code>{url}</code></p>
      <div class="btn-row">
        <button class="btn" type="button" data-copy={url}>Copy invite link</button>
        <a class="btn ghost" href={`/inbox/${collective.slug}/members`}>Choose roles →</a>
      </div>
      <p class="fineprint">The link is valid for {String(cfg.inviteHours)} hours — you can always create a new one from Members, where you can also invite people as commenters or senders.</p>
      <p class="fineprint"><a href={`/inbox/${collective.slug}`}>Skip — open the inbox</a></p>
    </AuthCard>,
  )
})

// Kept but no longer linked: pay-by-contribution applications (hidden for now).
app.post('/claim/:slug/apply', async (c) => {
  const t = await pendingClaim(c)
  if (t instanceof Response) return t
  const body = await c.req.parseBody()
  const contribution = String(body.contribution || '').trim()
  const months = Math.min(12, Math.max(1, Number(body.months) || 2))
  if (contribution.length < 30) return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent('Tell us a bit more about what you would contribute — a couple of sentences helps us say yes.'))
  try {
    await fileApplication(t.collective, t.member.email, t.member.name, contribution.slice(0, 4000), months)
    return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent('Application sent — we usually answer within a day. We will email you!'))
  } catch (err) {
    return c.redirect(`/claim/${t.collective.slug}?m=` + encodeURIComponent(err instanceof Error ? err.message : 'Could not send the application.'))
  }
})

// ---------- machine-readable docs (llms.txt) ----------
// The whole app is plain forms over HTTP, which makes it drivable by any agent
// that can hold a cookie jar and read its principal's inbox for the 6-digit
// codes. This file tells them exactly which fields go where, so they don't
// have to scrape it out of the HTML.

app.get('/llms.txt', (c) => {
  const base = cfg.baseUrl
  return c.text(`# collective.email

A shared email inbox for communities: one address (you@${cfg.emailDomain}) that a whole
collective can read and answer, with assignments, internal notes and @mentions.

This site is plain HTML forms over HTTP — no JavaScript required. An agent acting for a
human can drive every flow below with form-encoded POSTs and a cookie jar. Email
verification codes (6 digits, 10-minute expiry) are sent to the human's inbox; reading
them requires their mailbox access, which is the intended human-in-the-loop.

## Create a collective address

1. Check availability (JSON):
   GET ${base}/claim/oc?slug=<name>
   → {"unavailable": null|string, "oc": {"kind": "none"|"contactable"|"uncontactable"}}
   Names are 6–40 chars, [a-z0-9] only. kind != "none" means the name belongs to a
   collective on opencollective.com and needs an ownership proof (see the /claim pages).

2. Reserve it (sends a 6-digit code to the human's personal email):
   POST ${base}/claim
   form fields: address=<name>, name=<first name>, email=<their personal email>

3. Verify the code (sets the session cookie; the reservation holds for 48 hours):
   POST ${base}/verify
   form fields: email=<same email>, code=<6 digits>
   → 302 to /claim/<name> (the activation page)

4. Get the invite link (requires the session cookie):
   GET ${base}/claim/<name>/invite
   The page contains one URL of the form ${base}/join/<token>, valid ${String(cfg.inviteHours)} hours.
   Share it with the human's collective.

5. Activation — one of:
   - A second person accepts the invite (any role). The address goes live
     immediately with a 30-day free trial. This is the normal path: a collective
     is at least two people, and reserved names that nobody joins expire.
   - Subscribe (Stripe) or redeem a discount code on ${base}/claim/<name>.

## Join a collective (invite link in hand)

GET ${base}/join/<token> shows the form. Then:
POST ${base}/join/<token>
  form fields: name=<first name>, level=every|daily|weekly, and EITHER
  account=<an email this cookie jar is already signed in as> (joins instantly, no code)
  OR account=other, email=<new personal email> (a 6-digit code is emailed; verify as above).

## Sign in / multiple accounts

POST ${base}/login   form fields: email=<member email>  → code emailed → POST /verify.
The cookie can hold up to five signed-in accounts (add one via ${base}/login?add=1);
each /inbox/<name>/… page acts as whichever account is a member there.
POST ${base}/logout  form field email=<address> signs out that account only.

## After activation

Inbox:        ${base}/inbox/<name>            (HTML; threads, assignment, notes)
Compose:      POST ${base}/inbox/<name>/compose
              form fields: to, cc, bcc (comma-separated), subject, body,
              action=send|draft. "draft" creates a thread with a shareable URL
              where teammates can discuss via internal notes before sending.
Members:      ${base}/inbox/<name>/members    (invite links per role: reader/commenter/sender)
Settings:     ${base}/inbox/<name>/settings   (rename collective; address changes only before first email)
Export:       ${base}/inbox/<name>/export     (full zip archive — admin only)
Docs:         ${base}/docs   Pricing & FAQ:   ${base}/faq
`)
})

app.get('/robots.txt', (c) => c.text(`User-agent: *
Allow: /

# Machine-readable guide for AI agents: ${cfg.baseUrl}/llms.txt
`))

// ---------- offline fallback (cached by the service worker) ----------

app.get('/offline', (c) =>
  c.html(
    <AuthCard title="Offline">
      <h1>You're offline</h1>
      <p class="muted">collective.email needs a connection for fresh mail. Pages you've already opened may still be available — go back, or retry once you're online.</p>
      <a class="btn" href="/">Retry</a>
    </AuthCard>,
  ))

// ---------- legacy /c/:slug/* links (old notification emails) ----------

app.get('/c/:slug', (c) => c.redirect(`/inbox/${c.req.param('slug')}`, 301))
app.get('/c/:slug/inbox', (c) => c.redirect(`/inbox/${c.req.param('slug')}`, 301))
app.get('/c/:slug/thread/:id', (c) => c.redirect(`/inbox/${c.req.param('slug')}/thread/${c.req.param('id')}`, 301))
app.get('/c/:slug/collective', (c) => c.redirect(`/inbox/${c.req.param('slug')}/members`, 301))
