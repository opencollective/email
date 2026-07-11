/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { cfg } from '../config.js'
import {
  activeMembers, addTag, all, allCollectives, attachmentsByMessage, batchAll, createCollective, get, getCollective,
  getCollectiveBySlug, getMember, getMemberIn, getThread, kvSet, lastMessageByThread, memberMap,
  membershipsByEmail, removeTag, run, setAssignee, setStatus, tagsByThread, threadMessages, threadTags,
  type Attachment, type Collective, type Invite, type Member, type Message, type Thread,
} from '../db.js'
import {
  checkCode, createSession, destroyEmailSessions, destroySession, emailFromSession, issueCode,
} from '../auth.js'
import { sendCollectiveReply } from '../outbound.js'
import { digestTick, sendOnboarding } from '../notify.js'
import { sendAppEmail } from '../appmail.js'
import { readBlob, saveBlob } from '../storage.js'
import { excerpt, fmtDateTime, now, randomToken, relTime, slugify, verifyToken, waitingFor } from '../util.js'
import { AssigneeChip, AuthCard, Avatar, eventText, Shell, StatusChip, TimeAgo } from './ui.js'
import { HomePage } from './home.js'

type Env = { Variables: { email: string | null } }
export const app = new Hono<Env>()

const SID = 'requests_sid'
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

function visitorCurrency(c: Context): 'USD' | 'EUR' {
  const country = (
    c.req.header('x-vercel-ip-country') ||
    c.req.header('cf-ipcountry') ||
    c.req.header('x-country-code') ||
    ''
  ).toUpperCase()
  if (country) return EUR_COUNTRIES.has(country) ? 'EUR' : 'USD'
  const langs = c.req.header('accept-language') || ''
  for (const m of langs.matchAll(/[a-z]{2,3}-([A-Z]{2})/g)) {
    if (EUR_COUNTRIES.has(m[1])) return 'EUR'
    return 'USD'
  }
  return 'USD'
}

// ---------- session middleware ----------

app.use('*', async (c, next) => {
  c.set('email', await emailFromSession(getCookie(c, SID)))
  await next()
})

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
  const email = c.get('email')
  if (!email) return c.redirect('/login?next=' + encodeURIComponent(c.req.path))
  const slug = slugFromAddr(c)
  // collective + membership resolved in a single round-trip
  const row = slug ? await get<any>(`
    SELECT c.id AS c_id, c.slug AS c_slug, c.name AS c_name, c.status AS c_status, c.plan AS c_plan, c.created_at AS c_created_at,
           m.id, m.collective_id, m.email, m.name, m.role, m.notify_level, m.avatar_path, m.created_at, m.last_seen_at, m.removed_at
    FROM collectives c LEFT JOIN members m ON m.collective_id = c.id AND m.email = ?
    WHERE c.slug = ?
  `, [email, slug]) : undefined
  if (!row || row.c_status !== 'active') return c.notFound()
  const collective: Collective = {
    id: row.c_id, slug: row.c_slug, name: row.c_name, status: row.c_status, plan: row.c_plan, created_at: row.c_created_at,
  }
  const member = (row.id != null ? (row as Member) : undefined) as Member | undefined
  if (!member || member.removed_at) {
    return c.html(
      <AuthCard title={collective.name}>
        <h1>Wrong account for {collective.name}</h1>
        <p class="muted">
          You're signed in as <b>{email}</b>, which isn't a member of {collective.name}.
          If you received an invite or onboarding email at another address, sign out and
          sign in with <b>that</b> address.
        </p>
        <form method="post" action="/logout">
          <button class="btn" type="submit">Sign out & use another email</button>
        </form>
        {isPlatformAdmin(email) ? (
          <form method="post" action={`/inbox/${collective.slug}/join-admin`}>
            <button class="btn ghost" type="submit">Add {email} as admin of this collective</button>
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

app.get('/health', (c) => c.json({ ok: true }))

// Vercel Cron (or any external scheduler) hits this hourly; digestTick decides who is due.
app.get('/cron/digest', async (c) => {
  const auth = c.req.header('authorization') || ''
  if (cfg.cronSecret && auth !== `Bearer ${cfg.cronSecret}`) return c.json({ error: 'unauthorized' }, 401)
  await digestTick()
  return c.json({ ok: true })
})

app.get('/', async (c) => {
  const email = c.get('email')
  if (!email) return c.html(<HomePage joined={c.req.query('joined') === '1'} currency={visitorCurrency(c)} />)
  const memberships = await membershipsByEmail(email)
  if (memberships.length === 1) return c.redirect(`/inbox/${memberships[0].collective_slug}`)
  if (memberships.length === 0 && isPlatformAdmin(email)) return c.redirect('/admin')
  return c.html(
    <AuthCard title="Your collectives" flash={c.req.query('m')}>
      <h1>Your collectives</h1>
      {memberships.length === 0 ? (
        <p class="muted">
          <b>{email}</b> isn't part of any collective yet. Ask your collective for an invite link,
          or <a href="/#waitlist">join the waiting list</a> to start your own.
        </p>
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
      {isPlatformAdmin(email) ? <p class="fineprint"><a href="/admin">Platform admin →</a></p> : null}
      <form method="post" action="/logout"><button class="linkish" type="submit">Sign out</button></form>
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

const CodeForm = (p: { email: string; error?: string; next?: string | null }) => (
  <AuthCard title="Enter code">
    <h1>Check your inbox</h1>
    <p class="muted">We sent a 6-digit code to <b>{p.email}</b>. <a href="/login">Wrong address?</a></p>
    {p.error ? <p class="error">{p.error}</p> : null}
    <form method="post" action="/verify">
      <input type="hidden" name="email" value={p.email} />
      {p.next ? <input type="hidden" name="next" value={p.next} /> : null}
      <input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder="······" required />
      <button class="btn" type="submit">Sign in</button>
    </form>
    <p class="fineprint">Code expires in 10 minutes. You'll stay signed in on this device for 3 months, unless you sign out.</p>
  </AuthCard>
)

app.get('/login', (c) => {
  const next = safeNext(c.req.query('next'))
  if (c.get('email')) return c.redirect(next || '/')
  return c.html(
    <AuthCard title="Sign in" flash={c.req.query('m')}>
      <h1>Sign in</h1>
      <p class="muted">Enter your personal email address. We'll send you a 6-digit code — no password needed.</p>
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
  if (!res.ok) return c.html(<CodeForm email={email} error={res.error} next={safeNext(body.next)} />)

  let redirect = safeNext(body.next) || '/'
  if (res.row.purpose === 'join' && res.row.invite_token) {
    const invite = await get<Invite>('SELECT * FROM invites WHERE token = ?', [res.row.invite_token])
    const collective = invite ? await getCollective(invite.collective_id) : undefined
    if (invite && collective && !invite.revoked_at && invite.expires_at >= now()) {
      const existing = await getMemberIn(collective.id, email)
      if (existing) {
        await run("UPDATE members SET removed_at = NULL, name = COALESCE(NULLIF(?, ''), name), notify_level = ? WHERE id = ?",
          [res.row.join_name || '', res.row.join_level || existing.notify_level, existing.id])
      } else {
        await run('INSERT INTO members (collective_id, email, name, role, notify_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [collective.id, email, res.row.join_name || email.split('@')[0], 'member', res.row.join_level || 'every', now()])
      }
      redirect = `/inbox/${collective.slug}?m=` + encodeURIComponent(`Welcome to ${collective.name}!`)
    }
  }

  setCookie(c, SID, await createSession(email), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: cfg.baseUrl.startsWith('https'),
    maxAge: cfg.sessionDays * 86400,
    path: '/',
  })
  return c.redirect(redirect)
})

app.post('/logout', async (c) => {
  const t = getCookie(c, SID)
  if (t) await destroySession(t)
  deleteCookie(c, SID, { path: '/' })
  return c.redirect('/login?m=' + encodeURIComponent('Signed out.'))
})

// ---------- join via invite ----------

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
  return c.html(
    <AuthCard title={`Join ${collective.name}`}>
      <h1>Join {collective.name}</h1>
      <p class="muted">
        {inviter ? `${memberName(inviter)} invited you to help answer` : 'You were invited to help answer'} email
        sent to <b>{collective.slug}@{cfg.emailDomain}</b>.
      </p>
      <form method="post" action={`/join/${token}`}>
        <label class="lbl">Your name</label>
        <input class="input" name="name" placeholder="First name (as teammates know you)" required />
        <label class="lbl">Your personal email</label>
        <input class="input" type="email" name="email" placeholder="you@example.com" required />
        <label class="lbl">How do you want to hear about new requests?</label>
        <div class="level-cards">
          {LEVELS.map((l, i) => (
            <label class="level-card">
              <input type="radio" name="level" value={l.value} checked={i === 0} />
              <span><b>{l.label}</b><small>{l.hint}</small></span>
            </label>
          ))}
        </div>
        <button class="btn" type="submit">Send me a code</button>
      </form>
      <p class="fineprint">We'll email you a 6-digit code to confirm this address. You can change the notification level any time.</p>
    </AuthCard>,
  )
})

app.post('/join/:token', async (c) => {
  const token = c.req.param('token')
  const invite = await get<Invite>('SELECT * FROM invites WHERE token = ?', [token])
  if (!invite || invite.revoked_at || invite.expires_at < now()) return c.redirect(`/join/${token}`)
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const name = String(body.name || '').trim().slice(0, 60)
  const level = ['every', 'daily', 'weekly'].includes(String(body.level)) ? String(body.level) : 'every'
  await issueCode(email, 'join', { inviteToken: token, name, level })
  return c.html(<CodeForm email={email} />)
})

// ---------- one-click action links (from notification emails) ----------

app.get('/a/:token', async (c) => {
  const payload = verifyToken(c.req.param('token'))
  if (!payload || payload.a !== 'assign') {
    return c.html(
      <AuthCard title="Link expired">
        <h1>This link has expired</h1>
        <p class="muted">Action links in notification emails are valid for 14 days. Open the app instead.</p>
        <a class="btn" href="/">Open collective.email</a>
      </AuthCard>,
    )
  }
  const thread = await getThread(Number(payload.th))
  const target = await getMember(Number(payload.tg))
  const actor = await getMember(Number(payload.by))
  const collective = thread ? await getCollective(thread.collective_id) : undefined
  if (!thread || !collective || !target || target.removed_at) return c.redirect('/')
  await setAssignee(thread, target.id, actor?.id ?? null, 'one_click')
  if (c.get('email')) return c.redirect(`/inbox/${collective.slug}/thread/${thread.id}${payload.r ? '#composer' : ''}`)
  return c.html(
    <AuthCard title="Assigned">
      <h1>✓ Assigned to {memberName(target)}</h1>
      <p class="muted">“{thread.subject}” is now {target.id === actor?.id ? 'yours' : `with ${memberName(target)}`}.</p>
      <a class="btn" href={`/inbox/${collective.slug}/thread/${thread.id}`}>Sign in to open the thread</a>
    </AuthCard>,
  )
})

// ---------- attachments (proxied: locators are never exposed) ----------

app.get('/attachment/:id', async (c) => {
  const email = c.get('email')
  if (!email) return c.redirect('/login')
  const att = await get<Attachment>('SELECT * FROM attachments WHERE id = ?', [Number(c.req.param('id'))])
  if (!att) return c.notFound()
  const msg = await get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', [att.message_id])
  const thread = msg ? await getThread(msg.thread_id) : undefined
  if (!thread || (!(await getMemberIn(thread.collective_id, email)) && !isPlatformAdmin(email))) return c.notFound()
  const content = await readBlob(att.path)
  if (!content) return c.notFound()
  return c.body(new Uint8Array(content), 200, {
    'Content-Type': att.content_type,
    'Content-Disposition': `attachment; filename="${att.filename.replace(/"/g, '')}"`,
  })
})

// ---------- platform admin ----------

app.get('/admin', async (c) => {
  const email = c.get('email')
  if (!email) return c.redirect('/login')
  if (!isPlatformAdmin(email)) return c.notFound()
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

app.post('/admin/collectives', async (c) => {
  const email = c.get('email')
  if (!isPlatformAdmin(email)) return c.notFound()
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
  needs_reply: { label: 'Needs reply', where: "t.status = 'needs_reply'" },
  mine: { label: 'Mine', where: "t.assignee_member_id = ? AND t.status IN ('needs_reply','answered')" },
  all: { label: 'All threads', where: "t.status != 'spam'" },
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
  const f = FILTERS[c.req.query('f') || 'needs_reply'] ? (c.req.query('f') || 'needs_reply') : 'needs_reply'
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
        <button class="icon-btn" type="button" data-dialog="#sort-modal" aria-label="Sorting options" title="Sorting">⇅</button>
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
              : 'No threads here.'}
          </div>
        ) : threads.map((th) => {
          const lastMsg = lastMsgs.get(th.id)
          const tags = tagsMap.get(th.id) || []
          const replier = lastMsg?.direction === 'outbound' && lastMsg.sent_by_member_id ? members.get(lastMsg.sent_by_member_id) : null
          const stale = th.status === 'needs_reply' && th.last_message_at && now() - th.last_message_at > 48 * 3600
          return (
            <a class={`row ${th.status === 'needs_reply' ? 'unread' : ''}`} href={`${base}/thread/${th.id}`}>
              <span class={`dot ${th.status === 'needs_reply' ? 'open' : 'done'}`} />
              <span class="from">
                {th.counterpart_name || th.counterpart_email || '—'}
                <small>{th.counterpart_email}</small>
              </span>
              <span class="subj">
                {th.subject} <span class="snippet">— {excerpt(lastMsg?.body_text || '', 90)}</span>
              </span>
              <span class="tags">{tags.slice(0, 2).map((tg) => <span class="chip">#{tg.name}</span>)}</span>
              <AssigneeChip thread={th} members={members} />
              <span class={`age ${stale ? 'hot' : ''}`}>
                {th.status === 'needs_reply'
                  ? `waiting ${waitingFor(th.last_message_at)}`
                  : replier ? `${memberName(replier)} replied · ${relTime(th.last_message_at)}` : relTime(th.last_message_at)}
              </span>
            </a>
          )
        })}
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
  ])
  const msgs = batch[0] as Message[]
  const notes = batch[1] as { id: number; member_id: number; body: string; created_at: number }[]
  const allEvents = batch[2] as { actor_member_id: number | null; type: string; data_json: string | null; created_at: number }[]
  const tags = batch[3] as { id: number; name: string }[]
  const members = new Map((batch[4] as Member[]).map((m) => [m.id, m]))
  const attsMap = await attachmentsByMessage(msgs.map((m) => m.id))
  const events = allEvents.filter((e) => e.type !== 'replied')
  const lastAssignEvent = [...allEvents].reverse().find((e) => e.type === 'assigned' || e.type === 'unassigned')
  const activeList = [...members.values()].filter((m) => !m.removed_at).sort((a, b) => memberName(a).localeCompare(memberName(b)))
  const assignee = thread.assignee_member_id ? members.get(thread.assignee_member_id) : null
  const counterpartFirst = (thread.counterpart_name || thread.counterpart_email || 'the sender').split(' ')[0]
  const collectiveAddr = `${collective.slug}@${cfg.emailDomain}`

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

  return c.html(
    <Shell member={member} collective={collective} active="inbox" flash={c.req.query('m')} sidebar={
      <nav class="nav"><a class="nav-item" href={`${base}`}>← Back to inbox</a></nav>
    }>
      <div class="thread-wrap">
        <div class="thread-main">
          <div class="thread-top">
            <h1>{thread.subject}</h1>
            <StatusChip status={thread.status} />
            <AssigneeChip thread={thread} members={members} />
            {tags.map((tg) => <span class="chip">#{tg.name}</span>)}
          </div>

          <div class="tl">
            {groups.map((g) =>
              Array.isArray(g) ? (
                <div class="internal">
                  <span class="internal-tag">⌁ Internal — not visible to {counterpartFirst}</span>
                  {g.map((item) =>
                    item.kind === 'note' ? (
                      <div class="note">
                        <div class="note-head">
                          <Avatar member={members.get(item.member_id)} />
                          <b>{memberName(members.get(item.member_id))}</b>
                          <span class="when">{fmtDateTime(item.ts)}</span>
                        </div>
                        <p>{item.body}</p>
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
                      <b>{g.direction === 'outbound' ? collective.name : g.from_name || g.from_email}</b>
                      <small>{g.from_email} → {JSON.parse(g.to_json || '[]').join(', ')}</small>
                    </span>
                    {g.direction === 'outbound' && g.sent_by_member_id ? (
                      <span class="sentby">✎ sent by {memberName(members.get(g.sent_by_member_id))} · members only</span>
                    ) : null}
                    <span class="when">{fmtDateTime(g.sent_at)}</span>
                  </div>
                  <div class="msg-body">{g.body_text || '(no text content)'}</div>
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
              ),
            )}
          </div>

          <div class="typing" id="typing" data-url={`${base}/thread/${thread.id}/typing`} hidden></div>

          <div class="composer" id="composer">
            <div class="tabs">
              <button class="tab on" data-tab="reply" type="button">✉ Reply to {counterpartFirst}</button>
              <button class="tab" data-tab="note" type="button">⌁ Internal note</button>
            </div>
            <form method="post" action={`${base}/thread/${thread.id}/reply`} data-pane="reply" enctype="multipart/form-data">
              <div class="to">From <b>{collectiveAddr}</b> · To <b>{thread.counterpart_email || 'unknown'}</b></div>
              <textarea name="body" rows={5} placeholder={`Write to ${counterpartFirst}…`} data-draft="reply" required></textarea>
              <div class="actions">
                <label class="file-label">📎 Attach<input type="file" name="files" multiple class="file-input" /></label>
                <button class="btn send-btn" type="submit" data-busy="Sending…">Send as {collective.slug}@ ➤</button>
              </div>
            </form>
            <form method="post" action={`${base}/thread/${thread.id}/note`} data-pane="note" class="hidden">
              <div class="to note-to">⌁ Only members of {collective.name} will see this</div>
              <textarea name="body" rows={4} placeholder="Add context, ask a teammate, leave a note…" data-draft="note" required></textarea>
              <div class="actions">
                <button class="btn send-btn" type="submit" data-busy="Saving…">Add internal note</button>
              </div>
            </form>
          </div>
        </div>

        <aside class="thread-side">
          <div class="side-block">
            <span class="label">Assignment</span>
            {assignee ? (
              <div class="assign-state assigned">
                <Avatar member={assignee} /> <b>{memberName(assignee)}</b>
                {lastAssignEvent ? <small>{eventText(lastAssignEvent, members)} · {relTime(lastAssignEvent.created_at)}</small> : null}
              </div>
            ) : (
              <div class="assign-state unassigned-box">
                <b>⚠ Nobody has this yet</b>
                <form method="post" action={`${base}/thread/${thread.id}/assign`}>
                  <input type="hidden" name="member_id" value={String(member.id)} />
                  <button class="btn small" type="submit">🙋 Claim it</button>
                </form>
              </div>
            )}
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
          </div>

          <div class="side-block">
            <span class="label">Details</span>
            <span class="kv"><span class="k">STATUS</span> <StatusChip status={thread.status} /></span>
            <span class="kv"><span class="k">FROM</span> {thread.counterpart_email || '—'}</span>
            <span class="kv"><span class="k">FIRST</span> {fmtDateTime(thread.first_message_at)}</span>
            <span class="kv"><span class="k">LAST</span> <TimeAgo ts={thread.last_message_at} /></span>
            {thread.status === 'needs_reply' ? <span class="kv"><span class="k">WAITING</span> <b>{waitingFor(thread.last_message_at)}</b></span> : null}
          </div>

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
        </aside>
      </div>
    </Shell>,
  )
})

const MAX_UPLOAD = 15 * 1024 * 1024 // total, per reply

app.post('/inbox/:addr/thread/:id/reply', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
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
    await sendCollectiveReply(t.collective, thread.id, String(body.body || ''), t.member, 'web', attachments)
    const fresh = (await getThread(thread.id))!
    if (!fresh.assignee_member_id) await setAssignee(fresh, t.member.id, t.member.id, 'claim')
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent('Reply sent ✓'))
  } catch (err) {
    return c.redirect(`${base}/thread/${thread.id}?m=` + encodeURIComponent(`Could not send: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
})

app.post('/inbox/:addr/thread/:id/note', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  const text = String(body.body || '').trim()
  if (text) {
    await run('INSERT INTO notes (thread_id, member_id, body, created_at) VALUES (?, ?, ?, ?)',
      [thread.id, t.member.id, text.slice(0, 10000), now()])
  }
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}?m=` + encodeURIComponent('Note added ✓'))
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

app.post('/inbox/:addr/thread/:id/status', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
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
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  await addTag(t.collective.id, thread.id, String(body.name || ''), t.member.id)
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

app.post('/inbox/:addr/thread/:id/tags/remove', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const thread = await threadOf(c, t)
  if (!thread) return c.notFound()
  const body = await c.req.parseBody()
  await removeTag(thread.id, Number(body.tag_id), t.member.id)
  return c.redirect(`/inbox/${t.collective.slug}/thread/${thread.id}`)
})

// Platform admin can add themselves to any collective (from the "wrong account" page)
app.post('/inbox/:addr/join-admin', async (c) => {
  const email = c.get('email')
  if (!isPlatformAdmin(email)) return c.notFound()
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
        <p class="muted">Everyone here can read and answer email sent to <b>{collective.slug}@{cfg.emailDomain}</b>.</p>

        <section class="card">
          <h2>Invite someone</h2>
          {inviteUrl ? (
            <>
              <p class="muted">Share this link anywhere in your community. Whoever opens it joins on their own — they pick their email and notification level, so they already know how to sign in next time.</p>
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
            <div class="btn-row">
              <form method="post" action={`${base}/members/invite`}>
                <button class="btn small" type="submit">{invite ? '↻ Generate new link' : '+ Create invite link'}</button>
              </form>
              {invite ? (
                <form method="post" action={`${base}/members/invite/revoke`}>
                  <button class="btn small ghost" type="submit" data-confirm="Revoke the current invite link? Anyone holding it won't be able to join.">Revoke</button>
                </form>
              ) : null}
            </div>
          ) : null}
        </section>

        <section class="card">
          <h2>Members ({members.length})</h2>
          <div class="member-table">
            {members.map((m) => (
              <div class="member-row">
                <Avatar member={m} />
                <span class="m-name">
                  {memberName(m)}{m.id === member.id ? ' (you)' : ''}
                  <small>{m.email}</small>
                </span>
                {m.role === 'admin' ? <span class="chip solid">admin</span> : <span class="chip">member</span>}
                <span class="m-meta">
                  {LEVELS.find((l) => l.value === m.notify_level)?.label}
                  <small>{replies(m.id)} replies · seen {relTime(m.last_seen_at)}</small>
                </span>
                {isAdmin && m.id !== member.id ? (
                  <span class="m-actions">
                    <form method="post" action={`${base}/members/${m.id}/role`} class="inline">
                      <button class="linkish" type="submit" disabled={m.role === 'admin' && adminCount <= 1}>
                        {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
                      </button>
                    </form>
                    <form method="post" action={`${base}/members/${m.id}/disconnect`} class="inline">
                      <button class="linkish" type="submit" data-confirm={`Sign ${memberName(m)} out of all devices? They can sign back in with a code.`}>Disconnect</button>
                    </form>
                    <form method="post" action={`${base}/members/${m.id}/remove`} class="inline">
                      <button class="linkish danger" type="submit" disabled={m.role === 'admin' && adminCount <= 1}
                        data-confirm={`Remove ${memberName(m)} from the collective? They lose access immediately; their past replies stay attributed.`}>Remove</button>
                    </form>
                  </span>
                ) : <span class="m-actions" />}
              </div>
            ))}
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
  await run('UPDATE invites SET revoked_at = ? WHERE collective_id = ? AND revoked_at IS NULL', [now(), t.collective.id])
  await run('INSERT INTO invites (collective_id, token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    [t.collective.id, randomToken(18), t.member.id, now(), now() + cfg.inviteHours * 3600])
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

app.post('/inbox/:addr/members/:id/disconnect', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const back = `/inbox/${t.collective.slug}/members`
  if (t.member.role !== 'admin') return c.redirect(back)
  const target = await getMember(Number(c.req.param('id')))
  if (!target || target.collective_id !== t.collective.id) return c.redirect(back)
  await destroyEmailSessions(target.email)
  return c.redirect(back + '?m=' + encodeURIComponent(`${memberName(target)} was signed out of all devices.`))
})

app.post('/inbox/:addr/members/:id/role', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const back = `/inbox/${t.collective.slug}/members`
  if (t.member.role !== 'admin') return c.redirect(back)
  const target = await getMember(Number(c.req.param('id')))
  if (!target || target.collective_id !== t.collective.id || target.id === t.member.id) return c.redirect(back)
  const adminCount = (await activeMembers(t.collective.id)).filter((m) => m.role === 'admin').length
  if (target.role === 'admin' && adminCount <= 1) return c.redirect(back + '?m=' + encodeURIComponent('Cannot demote the last admin.'))
  await run('UPDATE members SET role = ? WHERE id = ?', [target.role === 'admin' ? 'member' : 'admin', target.id])
  return c.redirect(back)
})

app.get('/inbox/:addr/notifications', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
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
      </div>
    </Shell>,
  )
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
              <button class="btn small ghost" type="submit">Sign out</button>
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
  const email = c.get('email')
  if (!email) return c.notFound()
  const target = await getMember(Number(c.req.param('id')))
  if (!target?.avatar_path) return c.notFound()
  if (!(await getMemberIn(target.collective_id, email)) && !isPlatformAdmin(email)) return c.notFound()
  const content = await readBlob(target.avatar_path)
  if (!content) return c.notFound()
  const ext = target.avatar_path.split('.').pop()?.toLowerCase() || ''
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png'
  return c.body(new Uint8Array(content), 200, {
    'Content-Type': type,
    'Cache-Control': 'private, max-age=3600',
  })
})

const PLAN_INFO: Record<string, { label: string; seats: number | null; price: string }> = {
  duo: { label: 'Duo', seats: 2, price: '$/€10 per month (or 100/year)' },
  collective: { label: 'Collective', seats: 5, price: '$/€25 per month (or 250/year)' },
  pro: { label: 'Pro', seats: null, price: '$/€100 per month (or 1,000/year)' },
}

app.get('/inbox/:addr/billing', async (c) => {
  const t = await tenant(c)
  if (t instanceof Response) return t
  const { collective, member } = t
  const base = `/inbox/${collective.slug}`
  if (member.role !== 'admin') return c.redirect(base)
  const seats = (await activeMembers(collective.id)).length
  const plan = PLAN_INFO[collective.plan] || PLAN_INFO.collective
  return c.html(
    <Shell member={member} collective={collective} title="Billing" active="billing" flash={c.req.query('m')} sidebar={<BackNav base={base} />}>
      <div class="page">
        <h1>Billing</h1>
        <section class="card">
          <h2>{plan.label} plan</h2>
          <p class="muted">{plan.price}</p>
          <span class="kv"><span class="k">SEATS</span> {seats}{plan.seats ? ` of ${plan.seats}` : ' (no limit)'}</span>
          <span class="kv"><span class="k">ADDRESS</span> {collective.slug}@{cfg.emailDomain}</span>
        </section>
        <section class="card">
          <h2>Nothing to pay yet</h2>
          <p class="muted">Billing isn't live — early collectives use collective.email <b>for free during the preview</b>. We'll email the admins well before anything is ever charged, and you'll choose monthly or yearly (2 months free) then.</p>
        </section>
      </div>
    </Shell>,
  )
})

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
