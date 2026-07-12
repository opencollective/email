/** @jsxImportSource hono/jsx */
import type { Child, FC } from 'hono/jsx'
import { cfg } from '../config.js'
import type { Collective, Member, Thread } from '../db.js'
import { initials, relTime } from '../util.js'
import { billingState, trialDaysLeft } from '../billing.js'

export const SCRIPT = `
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-confirm]');
  if (t && !confirm(t.getAttribute('data-confirm'))) { e.preventDefault(); e.stopPropagation(); }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const box = tab.closest('.composer');
    box.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === tab));
    box.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.getAttribute('data-pane') !== tab.getAttribute('data-tab')));
    box.classList.toggle('note-mode', tab.getAttribute('data-tab') === 'note');
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(() => {
      const old = copy.textContent; copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = old; }, 1500);
    });
  }
  if (e.target.closest('[data-drawer]')) document.body.classList.toggle('drawer-open');
  const dlgBtn = e.target.closest('[data-dialog]');
  if (dlgBtn) document.querySelector(dlgBtn.getAttribute('data-dialog'))?.showModal();
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) closeBtn.closest('dialog')?.close();
});
const wantedPane = new URLSearchParams(location.search).get('pane');
if (wantedPane === 'note') document.querySelector('[data-tab="note"]')?.click();
const code = document.querySelector('input[name=code]');
if (code) { code.focus(); code.addEventListener('input', () => { if (code.value.trim().length === 6) code.form.submit(); }); }
document.querySelectorAll('.file-input').forEach((inp) => {
  inp.addEventListener('change', () => {
    const label = inp.closest('.file-label');
    const n = inp.files.length;
    label.firstChild.textContent = n ? '📎 ' + n + ' file' + (n > 1 ? 's' : '') + ' ' : '📎 Attach';
  });
});

// Draft persistence: never lose a reply or note to a lost connection.
// Saved per thread+pane on every keystroke, restored on load, cleared only
// once the server confirms with a success flash.
const draftKey = (pane) => 'draft:' + location.pathname + ':' + pane;
document.querySelectorAll('textarea[data-draft]').forEach((t) => {
  const k = draftKey(t.dataset.draft);
  try {
    if (!t.value && localStorage.getItem(k)) t.value = localStorage.getItem(k);
    t.addEventListener('input', () => localStorage.setItem(k, t.value));
  } catch {}
});
const flashEl = document.querySelector('.flash');
if (flashEl) {
  try {
    if (flashEl.textContent.includes('Reply sent')) localStorage.removeItem(draftKey('reply'));
    if (flashEl.textContent.includes('Note added')) localStorage.removeItem(draftKey('note'));
  } catch {}
}

// Instant feedback on every submit: disable the button and show progress,
// so a slow network never invites a double tap.
document.addEventListener('submit', (e) => {
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn && !btn.disabled) {
    btn.dataset.label = btn.textContent;
    btn.textContent = btn.dataset.busy || btn.textContent.replace(/\\s*$/, '') + '…';
    btn.classList.add('busy');
    setTimeout(() => { btn.disabled = true; }, 0);
  }
});
window.addEventListener('pageshow', () => {
  document.querySelectorAll('button.busy').forEach((b) => {
    b.disabled = false; b.classList.remove('busy');
    if (b.dataset.label) b.textContent = b.dataset.label;
  });
});

// Typing presence: beacon while drafting, poll to show "X is drafting…"
const typingEl = document.getElementById('typing');
if (typingEl) {
  const url = typingEl.dataset.url;
  let lastBeacon = 0;
  document.querySelectorAll('.composer textarea').forEach((t) => t.addEventListener('input', () => {
    const nowT = Date.now();
    if (nowT - lastBeacon > 10000) { lastBeacon = nowT; fetch(url, { method: 'POST' }).catch(() => {}); }
  }));
  const poll = async () => {
    try {
      const d = await (await fetch(url)).json();
      typingEl.hidden = !d.drafting || d.drafting.length === 0;
      if (d.drafting && d.drafting.length) {
        typingEl.textContent = '✎ ' + d.drafting.join(', ') + (d.drafting.length > 1 ? ' are' : ' is') + ' drafting a response…';
      }
    } catch {}
  };
  poll();
  setInterval(poll, 12000);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
`

export const Avatar: FC<{ member?: Member | null; empty?: boolean }> = ({ member, empty }) => {
  if (empty || !member) return <span class="avatar empty" title="Unassigned">–</span>
  if (member.avatar_path) return <img class="avatar avatar-img" src={`/avatar/${member.id}`} alt={member.name || member.email} title={member.name || member.email} />
  return <span class="avatar" title={member.name || member.email}>{initials(member.name, member.email)}</span>
}

export const StatusChip: FC<{ status: Thread['status'] }> = ({ status }) => {
  const label = { needs_reply: 'needs reply', answered: 'answered', closed: 'closed', spam: 'spam' }[status]
  return <span class={`chip status-${status}`}><span class="dot" />{label}</span>
}

export const AssigneeChip: FC<{ thread: Thread; members: Map<number, Member> }> = ({ thread, members }) => {
  const m = thread.assignee_member_id ? members.get(thread.assignee_member_id) : null
  if (!m) return <span class="chip unassigned">⚠ unassigned</span>
  return (
    <span class="chip assignee">
      <Avatar member={m} /> {m.name || m.email.split('@')[0]}
    </span>
  )
}

/** Human sentence for an event row — assignment provenance lives here. */
export function eventText(
  ev: { actor_member_id: number | null; type: string; data_json: string | null },
  members: Map<number, Member>,
): string {
  const data = ev.data_json ? JSON.parse(ev.data_json) : {}
  const actor = ev.actor_member_id ? members.get(ev.actor_member_id) : null
  const name = (id: number | null | undefined) => {
    if (!id) return 'someone'
    const m = members.get(id)
    return m ? (m.name || m.email.split('@')[0]) : 'a former member'
  }
  const a = actor ? (actor.name || actor.email.split('@')[0]) : null
  switch (ev.type) {
    case 'assigned': {
      const to = name(data.to)
      switch (data.reason) {
        case 'auto_sender': return `Automatically assigned to ${to} based on previous emails from this sender`
        case 'email_reply': return `Assigned to ${to} — replied via email notification`
        case 'one_click': return a === to ? `${to} claimed this from a notification email` : `${a} assigned this to ${to} from a notification email`
        case 'claim': return `${a} claimed this thread`
        default: return a === to ? `${to} claimed this thread` : `${a ?? 'Someone'} assigned this to ${to}`
      }
    }
    case 'unassigned': return `${a ?? 'Someone'} unassigned ${name(data.from)}`
    case 'status': {
      if (data.to === 'needs_reply' && data.auto) return 'Reopened — new message from the sender'
      if (data.to === 'answered' && data.auto) return 'Marked answered'
      return `${a ?? 'Someone'} marked this ${String(data.to).replace('_', ' ')}`
    }
    case 'tag_added': return data.auto ? `Automatically tagged #${data.tag}` : `${a ?? 'Someone'} added #${data.tag}`
    case 'tag_removed': return `${a ?? 'Someone'} removed #${data.tag}`
    case 'replied': return data.via === 'email' ? `${a} replied by email to their notification` : `${a} replied`
    case 'reply_blocked': return `${a} tried to reply by email, but ${name(data.answered_by)} had already answered — reply not sent`
    default: return ev.type
  }
}

export const Page: FC<{ title?: string; flash?: string; children?: Child }> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {/* maximum-scale=1 stops iOS auto-zoom on input focus (pinch zoom still works on iOS) */}
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f7f7f4" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#17181b" media="(prefers-color-scheme: dark)" />
      <title>{props.title ? `${props.title} · ` : ''}collective.email</title>
      <link rel="stylesheet" href="/static/style.css?v=6" />
      {/* Chromium prerenders links on hover/press → clicking a thread is instant.
          GET routes with side effects (/a one-click actions, downloads) are excluded. */}
      <script
        type="speculationrules"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            prerender: [{
              where: {
                and: [
                  { href_matches: '/*' },
                  { not: { href_matches: '/a/*' } },
                  { not: { href_matches: '/attachment/*' } },
                  { not: { href_matches: '/avatar/*' } },
                  { not: { href_matches: '/logout' } },
                ],
              },
              eagerness: 'moderate',
            }],
          }),
        }}
      />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/static/icon-192.png" type="image/png" />
      <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    </head>
    <body>
      {props.flash ? <div class="flash">{props.flash}</div> : null}
      {props.children}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </body>
  </html>
)

export const AuthCard: FC<{ title?: string; flash?: string; children?: Child }> = (props) => (
  <Page title={props.title} flash={props.flash}>
    <div class="auth-wrap">
      <div class="auth-card">
        <a class="wordmark" href="/">✉ collective<span class="at">.email</span></a>
        {props.children}
      </div>
    </div>
  </Page>
)

const Menu: FC<{ base: string; active: string; isAdmin: boolean }> = ({ base, active, isAdmin }) => (
  <nav class="nav">
    <a class={`nav-item ${active === 'inbox' ? 'active' : ''}`} href={base}>📥 Inbox</a>
    <a class={`nav-item ${active === 'members' ? 'active' : ''}`} href={`${base}/members`}>☺ Members</a>
    <a class={`nav-item ${active === 'notifications' ? 'active' : ''}`} href={`${base}/notifications`}>🔔 Notifications</a>
    {isAdmin ? <a class={`nav-item ${active === 'billing' ? 'active' : ''}`} href={`${base}/billing`}>💳 Billing</a> : null}
  </nav>
)

export const Shell: FC<{
  member: Member
  collective: Collective
  title?: string
  active: string
  flash?: string
  sidebar?: Child
  children?: Child
}> = (props) => {
  const base = `/inbox/${props.collective.slug}`
  const addr = `${props.collective.slug}@${cfg.emailDomain}`
  const isAdmin = props.member.role === 'admin'
  const userBlock = (
    <a class="me" href={`${base}/profile`} title="Your profile">
      <Avatar member={props.member} />
      <span class="me-id">
        {props.member.name || props.member.email.split('@')[0]}
        <small>{props.member.email}</small>
      </span>
      <span class="me-chevron">›</span>
    </a>
  )
  return (
    <Page title={props.title ? `${props.title} · ${props.collective.name}` : props.collective.name} flash={props.flash}>
      <div class="app">
        {/* desktop sidebar */}
        <aside class="side">
          <a class="org" href={base}>
            <span class="mark">{initials(props.collective.name)}</span>
            <div>
              <span class="org-name">{props.collective.name}</span>
              <small>{addr}</small>
            </div>
          </a>
          {props.sidebar}
          <div class="label">Menu</div>
          <Menu base={base} active={props.active} isAdmin={isAdmin} />
          <div class="side-foot">{userBlock}</div>
        </aside>

        {/* mobile header: hamburger + address, then swipeable page nav */}
        <div class="m-head">
          <div class="m-row">
            <button class="hamburger" data-drawer type="button" aria-label="Menu">☰</button>
            <a class="m-addr" href={base}>{addr}</a>
          </div>
          {props.sidebar ? <div class="m-pills">{props.sidebar}</div> : null}
        </div>

        {/* drawer (mobile menu) */}
        <div class="drawer" aria-hidden="true">
          <div class="drawer-backdrop" data-drawer />
          <div class="drawer-panel">
            <div class="org">
              <span class="mark">{initials(props.collective.name)}</span>
              <div>
                <span class="org-name">{props.collective.name}</span>
                <small>{addr}</small>
              </div>
            </div>
            <Menu base={base} active={props.active} isAdmin={isAdmin} />
            <div class="drawer-foot">{userBlock}</div>
          </div>
        </div>

        <main class="main">
          {(() => {
            const state = billingState(props.collective)
            if (state === 'grace') return (
              <div class="billing-banner">
                ⏸ The free trial has ended — the inbox is <b>read-only</b>. Mail still arrives; nothing is lost.
                {isAdmin ? <a href={`${base}/billing`}> Subscribe to reply again →</a> : ' An admin can reactivate it from Billing.'}
              </div>
            )
            if (state === 'expired') return (
              <div class="billing-banner danger">
                ✖ This address is inactive — it no longer receives email.
                {isAdmin ? <a href={`${base}/billing`}> Subscribe to reactivate →</a> : ' An admin can reactivate it from Billing.'}
              </div>
            )
            const days = state === 'trial' ? trialDaysLeft(props.collective) : null
            if (isAdmin && days !== null && days <= 15) return (
              <div class="billing-banner soft">
                ⏳ {days} day{days === 1 ? '' : 's'} left in the free trial. <a href={`${base}/billing`}>Subscribe →</a>
              </div>
            )
            return null
          })()}
          {props.children}
        </main>
      </div>
    </Page>
  )
}

export const TimeAgo: FC<{ ts: number | null }> = ({ ts }) => <span class="time" title={ts ? new Date(ts * 1000).toISOString() : ''}>{relTime(ts)}</span>
