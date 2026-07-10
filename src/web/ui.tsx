/** @jsxImportSource hono/jsx */
import type { Child, FC } from 'hono/jsx'
import { cfg } from '../config.js'
import type { Collective, Member, Thread } from '../db.js'
import { initials, relTime } from '../util.js'

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
});
const code = document.querySelector('input[name=code]');
if (code) { code.focus(); code.addEventListener('input', () => { if (code.value.trim().length === 6) code.form.submit(); }); }
document.querySelectorAll('.file-input').forEach((inp) => {
  inp.addEventListener('change', () => {
    const label = inp.closest('.file-label');
    const n = inp.files.length;
    label.firstChild.textContent = n ? '📎 ' + n + ' file' + (n > 1 ? 's' : '') + ' ' : '📎 Attach';
  });
});
`

export const Avatar: FC<{ member?: Member | null; empty?: boolean }> = ({ member, empty }) => {
  if (empty || !member) return <span class="avatar empty" title="Unassigned">–</span>
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
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f7f7f4" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#17181b" media="(prefers-color-scheme: dark)" />
      <title>{props.title ? `${props.title} · ` : ''}collective.email</title>
      <link rel="stylesheet" href="/static/style.css" />
      <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>✉️</text></svg>" />
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

export const Shell: FC<{
  member: Member
  collective: Collective
  title?: string
  active: string
  flash?: string
  sidebar?: Child
  children?: Child
}> = (props) => {
  const base = `/c/${props.collective.slug}`
  return (
    <Page title={props.title ? `${props.title} · ${props.collective.name}` : props.collective.name} flash={props.flash}>
      <div class="app">
        <aside class="side">
          <div class="org">
            <span class="mark">{initials(props.collective.name)}</span>
            <div>
              <span class="org-name">{props.collective.name}</span>
              <small>{props.collective.slug}@{cfg.emailDomain}</small>
            </div>
          </div>
          {props.sidebar}
          <div class="side-foot">
            <a class={`nav-item ${props.active === 'collective' ? 'active' : ''}`} href={`${base}/collective`}>
              ☺ Collective
            </a>
            <div class="me">
              <Avatar member={props.member} />
              <span>{props.member.name || props.member.email.split('@')[0]}</span>
              <form method="post" action="/logout"><button class="linkish" type="submit">Sign out</button></form>
            </div>
          </div>
        </aside>
        <main class="main">{props.children}</main>
      </div>
    </Page>
  )
}

export const TimeAgo: FC<{ ts: number | null }> = ({ ts }) => <span class="time" title={ts ? new Date(ts * 1000).toISOString() : ''}>{relTime(ts)}</span>
