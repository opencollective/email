/** @jsxImportSource hono/jsx */
import type { Child, FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { cfg } from '../config.js'
import type { Collective, Member, Thread } from '../db.js'
import { fmtDate, initials, relTime } from '../util.js'
import { billingState, trialDaysLeft } from '../billing.js'

/** Report this browser's time zone once (~1 year) so prices show in euros for
 *  European visitors even when the edge can't resolve the IP country. Included
 *  on every shell — marketing pages are where prices are first seen. */
export const TZ_SCRIPT = `
try {
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  if (tz && document.cookie.indexOf('tz=') === -1) {
    document.cookie = 'tz=' + encodeURIComponent(tz) + ';path=/;max-age=31536000;samesite=Lax' + (location.protocol === 'https:' ? ';secure' : '');
  }
} catch (e) {}
`

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
  // a link that also names a sheet: on a narrow screen open the sheet instead
  // of navigating to the full page; on desktop let the link do its thing
  const sheetLink = e.target.closest('[data-sheet]');
  if (sheetLink && window.matchMedia('(max-width: 900px)').matches) {
    e.preventDefault();
    document.querySelector(sheetLink.getAttribute('data-sheet'))?.showModal();
  }
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) closeBtn.closest('dialog')?.close();
  // click on a modal's backdrop (the dialog element itself) closes it
  if (e.target.tagName === 'DIALOG' && e.target.open) {
    const r = e.target.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) e.target.close();
  }
});
const wantedPane = new URLSearchParams(location.search).get('pane');
if (wantedPane === 'note') document.querySelector('[data-tab="note"]')?.click();
const code = document.querySelector('input.code-input');
// requestSubmit (not submit) so the once-only submit guard below applies —
// iOS OTP autofill can fire 'input' twice, which double-posted the code.
if (code) { code.focus(); code.addEventListener('input', () => { if (code.value.trim().length === 6) code.form.requestSubmit(); }); }
// Sandboxed email frames grow to fit their content (no scripts inside the
// frame, so the parent measures for it).
document.querySelectorAll('iframe.msg-frame').forEach((f) => {
  const fit = () => { try { f.style.height = Math.min(f.contentDocument.documentElement.scrollHeight + 24, 4000) + 'px'; } catch {} };
  f.addEventListener('load', fit);
  fit();
  setTimeout(fit, 400); // once more after images load enough to size
});
// Filter-as-you-type lists: the form still submits (and still works without
// JS), but typing hides non-matching rows straight away.
document.querySelectorAll('[data-filter]').forEach((form) => {
  const input = form.querySelector('input[name=q]');
  const sel = form.getAttribute('data-filter');
  if (!input) return;
  const empty = document.querySelector('[data-filter-empty]');
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(sel).forEach((row) => {
      const hit = !q || (row.getAttribute('data-find') || '').indexOf(q) !== -1;
      row.hidden = !hit;
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  };
  input.addEventListener('input', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
});

// Tag suggestions: the collective's own vocabulary, most-used first. Clicking
// one submits it; typing narrows the list so a near-match is easier to spot
// than to retype (which is how "follow-up" grows a twin called "followup").
document.querySelectorAll('[data-tagpop]').forEach((form) => {
  const input = form.querySelector('input[name=name]');
  const box = form.querySelector('.tag-sugs');
  const det = form.closest('details');
  if (det) det.addEventListener('toggle', () => { if (det.open && input) input.focus(); });
  if (!input) return;
  let at = -1; // which suggestion the arrow keys are on; -1 = the typed text
  const live = () => box ? [].slice.call(box.querySelectorAll('.tag-sug')).filter((b) => !b.hidden) : [];
  const mark = () => {
    const list = live();
    list.forEach((b, i) => b.classList.toggle('on', i === at));
    if (at >= 0 && list[at] && list[at].scrollIntoView) list[at].scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    // a leading # is how people write tags; we store them without it
    if (input.value.charAt(0) === '#') input.value = input.value.slice(1);
    const q = input.value.trim().toLowerCase();
    at = -1;
    let shown = 0;
    if (box) {
      box.querySelectorAll('.tag-sug').forEach((b) => {
        const hit = !q || (b.getAttribute('data-find') || '').indexOf(q) !== -1;
        b.hidden = !hit;
        b.classList.remove('on');
        if (hit) shown++;
      });
      box.hidden = shown === 0;
    }
  });
  input.addEventListener('keydown', (e) => {
    const list = live();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      e.preventDefault();
      at = e.key === 'ArrowDown'
        ? (at + 1 >= list.length ? -1 : at + 1)
        : (at - 1 < -1 ? list.length - 1 : at - 1);
      mark();
    } else if (e.key === 'Enter') {
      // on a highlighted suggestion, Enter takes it; otherwise the typed text
      // submits as usual, so a brand-new tag is one Enter away too
      if (at >= 0 && list[at]) { e.preventDefault(); list[at].click(); }
    } else if (e.key === 'Escape') {
      if (det) { det.open = false; input.blur(); }
    }
  });
});

// Folding a message: instant here, remembered on the server. Without JS the
// same control is a form post that reloads the thread.
document.querySelectorAll('[data-msg]').forEach((msg) => {
  const form = msg.querySelector('.msg-fold');
  if (!form) return;
  const flag = form.querySelector('input[name=collapsed]');
  const btn = form.querySelector('[data-fold]');
  const toggle = (e) => {
    e.preventDefault();
    const folded = !msg.classList.contains('folded');
    msg.classList.toggle('folded', folded);
    flag.value = folded ? '0' : '1'; // the value posted is the NEXT state
    if (btn) btn.textContent = folded ? 'Expand' : 'Collapse';
    const menu = msg.querySelector('.msg-menu');
    if (menu) menu.open = false;
    fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fold': '1' },
      body: 'message_id=' + encodeURIComponent(form.querySelector('input[name=message_id]').value)
        + '&collapsed=' + (folded ? '1' : '0'),
    }).catch(() => {});
  };
  form.addEventListener('submit', toggle);
  const peek = msg.querySelector('[data-peek]');
  if (peek) peek.addEventListener('click', toggle);
  // the whole head is the fold control — except the sender, which opens their
  // card, and the message menu, which does its own thing
  const head = msg.querySelector('.msg-head');
  if (head) head.addEventListener('click', (e) => {
    if (e.target.closest('.person, .msg-menu, a, button, input, select, textarea, label')) return;
    toggle(e);
  });
});
// one message menu open at a time; any click elsewhere closes it
document.addEventListener('click', (e) => {
  document.querySelectorAll('.msg-menu[open]').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

// Sender cards: CSS opens them on hover where there is a pointer; on a
// touchscreen the first tap opens the card instead of following the link.
document.querySelectorAll('[data-person]').forEach((p) => {
  const hit = p.querySelector('.person-hit');
  if (!hit) return;
  hit.addEventListener('click', (e) => {
    if (!matchMedia('(hover: none)').matches) return;
    e.preventDefault();
    const wasOpen = p.classList.contains('open');
    document.querySelectorAll('[data-person].open').forEach((o) => o.classList.remove('open'));
    if (!wasOpen) p.classList.add('open');
  });
});
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-person]')) return;
  document.querySelectorAll('[data-person].open').forEach((o) => o.classList.remove('open'));
});
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const done = () => {
      b.classList.add('copied');
      b.title = 'Copied';
      setTimeout(() => { b.classList.remove('copied'); b.title = 'Copy address'; }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(b.getAttribute('data-copy')).then(() => {
      done();
      if (b.classList.contains('menu-item')) {
        const t = b.textContent;
        b.textContent = 'Copied ✓';
        setTimeout(() => { b.textContent = t; const d = b.closest('details'); if (d) d.open = false; }, 700);
      }
    }, () => {});
  });
});

document.querySelectorAll('.file-input').forEach((inp) => {
  inp.addEventListener('change', () => {
    const label = inp.closest('.file-label');
    const txt = label && label.querySelector('.file-text');
    if (!txt) return;
    const n = inp.files.length;
    txt.textContent = n === 0 ? (txt.dataset.idle || 'Attach')
      : n === 1 ? (inp.files[0].name.length > 22 ? inp.files[0].name.slice(0, 21) + '…' : inp.files[0].name)
      : n + ' files';
  });
});

// Draft persistence: never lose a reply or note to a lost connection.
// Saved per thread+pane on every keystroke, restored on load, cleared only
// once the server confirms with a success flash.
const draftKey = (pane) => 'draft:' + location.pathname + ':' + pane;
// Clear sent drafts BEFORE restoring — otherwise the just-sent text is put
// back into the textarea and looks like the send didn't take.
const flashEl = document.querySelector('.flash');
if (flashEl) {
  try {
    if (flashEl.textContent.includes('Reply sent')) localStorage.removeItem(draftKey('reply'));
    if (flashEl.textContent.includes('Note added')) localStorage.removeItem(draftKey('note'));
  } catch {}
}
document.querySelectorAll('textarea[data-draft]').forEach((t) => {
  const k = draftKey(t.dataset.draft);
  const pristine = t.value; // the server-rendered starting point (e.g. the signature)
  try {
    const saved = localStorage.getItem(k);
    if (saved && saved !== pristine) t.value = saved;
    t.addEventListener('input', () => {
      if (t.value === pristine) localStorage.removeItem(k); else localStorage.setItem(k, t.value);
    });
  } catch {}
  // start writing above the signature, not after it
  if (t.dataset.signature && t.value.trim() === t.dataset.signature.trim()) {
    t.addEventListener('focus', () => { if (t.selectionStart === t.value.length) t.setSelectionRange(0, 0); }, { once: true });
  }
});

// Address inputs grow with the slug so the full address stays visible —
// the @domain part wraps to its own line when the two no longer fit.
const sizeAddr = (a) => { a.style.width = Math.max(8, (a.value || a.placeholder || '').length + 1) + 'ch'; };
document.addEventListener('input', (e) => {
  const a = e.target.closest && e.target.closest('.wl-addr input, .claim .addr input');
  if (a) sizeAddr(a);
});
document.querySelectorAll('.wl-addr input, .claim .addr input').forEach((a) => { if (a.value) sizeAddr(a); });

// Instant feedback on every submit: disable the button and show progress,
// so a slow network never invites a double tap.
document.addEventListener('change', (e) => {
  const rs = e.target.closest && e.target.closest('.role-select');
  if (!rs) return;
  const hint = rs.form && rs.form.querySelector('.role-hint');
  if (hint) hint.textContent = (rs.selectedOptions[0] && rs.selectedOptions[0].dataset.hint) || '';
  if (rs.form && rs.form.classList.contains('role-form')) rs.form.requestSubmit();
});

document.addEventListener('submit', (e) => {
  if (e.target.dataset.sent) { e.preventDefault(); return; } // a form only submits once
  e.target.dataset.sent = '1';
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn && !btn.disabled) {
    btn.dataset.label = btn.textContent;
    btn.textContent = btn.dataset.busy || btn.textContent.replace(/\\s*$/, '') + '…';
    btn.classList.add('busy');
    setTimeout(() => { btn.disabled = true; }, 0);
  }
});
window.addEventListener('pageshow', () => {
  document.querySelectorAll('form[data-sent]').forEach((f) => { delete f.dataset.sent; });
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

// Apple-Mail Cc/Bcc line: the expanded rows fold back as soon as attention
// moves on — to the body, the To line or the subject — unless a Cc/Bcc was
// actually typed, in which case hiding it would hide a real recipient.
document.querySelectorAll('form .ccb').forEach((d) => {
  const form = d.closest('form');
  if (!form) return;
  const fold = () => {
    const cc = form.querySelector('input[name="cc"]');
    const bcc = form.querySelector('input[name="bcc"]');
    if (!(cc && cc.value.trim()) && !(bcc && bcc.value.trim())) d.open = false;
  };
  form.querySelectorAll('textarea, input[name="to"], input[name="subject"]')
    .forEach((el) => el.addEventListener('focus', fold));
});

// Open a thread where you left off: jump to the first thing you haven't seen.
const firstNew = document.getElementById('first-new');
if (firstNew) firstNew.scrollIntoView({ block: 'start' });

// Popovers (forward, add-tag) close when you click anywhere else.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details[open].fwd, details[open].tag-add').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
`


/** Monochrome inline icons (feather-style, stroke = currentColor) — one
 *  consistent set instead of the emoji grab-bag, recolorable on hover/press. */
const ICON_PATHS: Record<string, string> = {
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  pencil: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  forward: '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  clip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  rotate: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
}

export const Icon: FC<{ name: keyof typeof ICON_PATHS }> = ({ name }) => (
  // hono/jsx refuses dangerouslySetInnerHTML on <svg>; raw() renders the same
  <>{raw(`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`)}</>
)

export const Avatar: FC<{ member?: Member | null; empty?: boolean }> = ({ member, empty }) => {
  if (empty || !member) return <span class="avatar empty" title="Unassigned">–</span>
  if (member.avatar_path) return <img class="avatar avatar-img" src={`/avatar/${member.id}`} alt={member.name || member.email} title={member.name || member.email} />
  return <span class="avatar" title={member.name || member.email}>{initials(member.name, member.email)}</span>
}

export const StatusChip: FC<{ status: Thread['status'] }> = ({ status }) => {
  const label = { needs_reply: 'needs reply', answered: 'answered', closed: 'closed', spam: 'spam', draft: 'draft' }[status]
  return <span class={`chip status-${status}`}><span class="dot" />{label}</span>
}

export const AssigneeChip: FC<{ thread: Thread; members: Map<number, Member> }> = ({ thread, members }) => {
  const m = thread.assignee_member_id ? members.get(thread.assignee_member_id) : null
  // only warn where it matters: an unanswered thread with no owner
  if (!m) return thread.status === 'needs_reply' ? <span class="chip unassigned"><Icon name="warn" /> unassigned</span> : null
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
        case 'solo': return `Assigned to ${to} — the only member`
        case 'email_reply': return `Assigned to ${to} — replied via email notification`
        case 'one_click': return a === to ? `${to} claimed this from a notification email` : `${a} assigned this to ${to} from a notification email`
        case 'claim': return `${a} claimed this thread`
        default: return a === to ? `${to} claimed this thread` : `${a ?? 'Someone'} assigned this to ${to}`
      }
    }
    case 'unassigned': return `${a ?? 'Someone'} unassigned ${name(data.from)}`
    case 'forwarded': {
      // name the message being forwarded — "a message" is useless on a long thread
      const who = data.from ? `${data.from}'s message` : 'a message'
      const when = data.at ? ` of ${new Date(Number(data.at) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''
      const files = Number(data.files) > 0 ? ` with ${data.files} attachment${Number(data.files) === 1 ? '' : 's'}` : ''
      return `${a ?? 'Someone'} forwarded ${who}${when}${files} to ${data.to}`
    }
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

/** Pages opt into a client bundle by name — only the thread page pays for the
 *  note editor. `defer` keeps it after the inline SCRIPT, so a draft is already
 *  restored into the textarea by the time the island reads it. */
/** One version for every static asset reference. With /static cached as
 *  immutable, this bump is what makes browsers fetch the new css/js — raise it
 *  whenever style.css or a client bundle changes. */
export const ASSET_V = '68'

export const Page: FC<{ title?: string; flash?: string; bundle?: string; children?: Child }> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {/* maximum-scale=1 stops iOS auto-zoom on input focus (pinch zoom still works on iOS) */}
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f7f7f4" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#17181b" media="(prefers-color-scheme: dark)" />
      <title>{props.title ? `${props.title} · ` : ''}collective.email</title>
      <link rel="stylesheet" href={`/static/style.css?v=${ASSET_V}`} />
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
      <script dangerouslySetInnerHTML={{ __html: TZ_SCRIPT + SCRIPT }} />
      {props.bundle ? <script defer src={`/static/${props.bundle}?v=${ASSET_V}`}></script> : null}
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

/** The one navigation. `filters` (the inbox's Needs reply / Mine / …) nests
 *  directly under Inbox, because that is what it filters. */
const Menu: FC<{ base: string; active: string; isAdmin: boolean; canSend: boolean; filters?: Child; inboxCount?: number; inboxOn?: boolean }> = ({ base, active, isAdmin, canSend, filters, inboxCount, inboxOn }) => (
  <nav class="nav">
    {canSend ? <a class={`nav-item ${active === 'compose' ? 'active' : ''}`} href={`${base}/compose`}><Icon name="pencil" /> New email</a> : null}
    <a class={`nav-item ${active === 'inbox' && inboxOn !== false ? 'active' : ''}`} href={base}>
      <Icon name="inbox" /> Inbox {inboxCount ? <span class="count">{inboxCount}</span> : null}
    </a>
    {filters}
    <a class={`nav-item ${active === 'contacts' ? 'active' : ''}`} href={`${base}/contacts`}><Icon name="book" /> Contacts</a>
    <a class={`nav-item ${active === 'members' ? 'active' : ''}`} href={`${base}/members`}><Icon name="users" /> Collective</a>
    <a class={`nav-item ${active === 'notifications' ? 'active' : ''}`} href={`${base}/notifications`}><Icon name="bell" /> Notifications</a>
    {isAdmin ? <a class={`nav-item ${active === 'rules' ? 'active' : ''}`} href={`${base}/rules`}><Icon name="zap" /> Rules</a> : null}
    {/* one entry for the three admin config pages: name, domain, billing */}
    {isAdmin ? (
      <a class={`nav-item ${['settings', 'domain', 'billing'].includes(active) ? 'active' : ''}`} href={`${base}/settings`}><Icon name="gear" /> Settings</a>
    ) : null}
  </nav>
)

export const Shell: FC<{
  member: Member
  collective: Collective
  title?: string
  active: string
  flash?: string
  bundle?: string
  sidebar?: Child
  /** total in the inbox, shown on the Inbox item itself */
  inboxCount?: number
  /** false when a sub-filter is the active one, so Inbox doesn't also light up */
  inboxOn?: boolean
  /** where "back" leads; on mobile the hamburger morphs into a left arrow */
  back?: { href: string; label: string }
  children?: Child
}> = (props) => {
  const base = `/inbox/${props.collective.slug}`
  const addr = `${props.collective.slug}@${cfg.emailDomain}`
  const isAdmin = props.member.role === 'admin'
  const canSend = props.member.role === 'admin' || props.member.role === 'member'
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
    <Page title={props.title ? `${props.title} · ${props.collective.name}` : props.collective.name} flash={props.flash} bundle={props.bundle}>
      <div class="app">
        {/* desktop sidebar */}
        <aside class="side">
          <div class="org-wrap">
            <a class="org" href={base} data-org data-slug={props.collective.slug}>
              <span class="mark">{initials(props.collective.name)}</span>
              <div>
                <span class="org-name">{props.collective.name}</span>
                <small>{addr}</small>
              </div>
              <span class="org-caret" hidden aria-hidden="true">⌄</span>
            </a>
            <div class="org-menu" hidden />
          </div>
          {props.back ? <nav class="nav"><a class="nav-item" href={props.back.href}>← {props.back.label}</a></nav> : null}
          <Menu base={base} active={props.active} isAdmin={isAdmin} canSend={canSend} filters={props.sidebar} inboxCount={props.inboxCount} inboxOn={props.inboxOn} />
          <div class="side-foot">{userBlock}</div>
        </aside>

        {/* mobile header: hamburger (or a back arrow, morphing between the
            two shapes on load) + the address. The inbox filters are NOT
            repeated here — they're in the drawer, under Inbox. */}
        <div class="m-head">
          <div class="m-row">
            {props.back ? (
              <a class="hamburger to-arrow" href={props.back.href} aria-label={props.back.label}>
                <span class="hl hl-1" /><span class="hl hl-2" /><span class="hl hl-3" />
              </a>
            ) : (
              <button class="hamburger to-burger" data-drawer type="button" aria-label="Menu">
                <span class="hl hl-1" /><span class="hl hl-2" /><span class="hl hl-3" />
              </button>
            )}
            <a class="m-addr" href={base}>{addr}</a>
          </div>
        </div>

        {/* drawer (mobile menu) */}
        <div class="drawer" aria-hidden="true">
          <div class="drawer-backdrop" data-drawer />
          <div class="drawer-panel">
            <div class="org-wrap">
              <a class="org" href={base} data-org data-slug={props.collective.slug}>
                <span class="mark">{initials(props.collective.name)}</span>
                <div>
                  <span class="org-name">{props.collective.name}</span>
                  <small>{addr}</small>
                </div>
                <span class="org-caret" hidden aria-hidden="true">⌄</span>
              </a>
              <div class="org-menu" hidden />
            </div>
            <Menu base={base} active={props.active} isAdmin={isAdmin} canSend={canSend} filters={props.sidebar} inboxCount={props.inboxCount} inboxOn={props.inboxOn} />
            <div class="drawer-foot">{userBlock}</div>
          </div>
        </div>

        <main class="main">
          {(() => {
            // a closed inbox says so on every page: it is bouncing mail right
            // now, and there is a deadline attached
            if (props.collective.status === 'archived') return (
              <div class="billing-banner danger">
                ✖ This inbox is closed — mail sent to it bounces, and everything is deleted on {' '}
                {fmtDate((props.collective.archived_at ?? 0) + 30 * 86400)}.
                {isAdmin ? <a href={`${base}/data`}> Reopen or download →</a> : ' An admin can reopen it.'}
              </div>
            )
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
                <Icon name="clock" /> {days} day{days === 1 ? '' : 's'} left in the free trial. <a href={`${base}/billing`}>Subscribe →</a>
              </div>
            )
            return null
          })()}
          {props.children}
        </main>
      </div>
      <script dangerouslySetInnerHTML={{ __html: SWITCHER_SCRIPT }} />
    </Page>
  )
}

/** Collective switcher: upgrades the org block into a dropdown when the user
 *  belongs to more than one mailbox. Progressive enhancement — without JS the
 *  org block stays a plain link to the current inbox. */
const SWITCHER_SCRIPT = `
(function(){
  fetch('/mailboxes').then(function(r){return r.json();}).then(function(d){
    var boxes=(d&&d.mailboxes)||[];
    var multi=(d&&d.accounts||0)>1;
    if(boxes.length<2&&!multi) return;
    function esc(s){var e=document.createElement('div');e.textContent=s==null?'':s;return e.innerHTML;}
    document.querySelectorAll('[data-org]').forEach(function(org){
      var current=org.getAttribute('data-slug');
      var caret=org.querySelector('.org-caret');
      var menu=org.parentElement.querySelector('.org-menu');
      if(caret) caret.hidden=false;
      menu.innerHTML=boxes.map(function(b){
        var badges='';
        if(b.needsReply>0) badges+='<span class="ob-badge ob-wait" title="conversations waiting for a reply">'+b.needsReply+' waiting</span>';
        if(b.mine>0) badges+='<span class="ob-badge ob-mine" title="assigned to you">'+b.mine+' yours</span>';
        return '<a class="org-item'+(b.slug===current?' on':'')+'" href="/inbox/'+encodeURIComponent(b.slug)+'">'+
          '<span class="oi-main"><b>'+esc(b.name)+'</b><small>'+esc(b.slug)+'@collective.email</small>'+
          (multi?'<small class="oi-acct">'+esc(b.email||'')+'</small>':'')+'</span>'+
          '<span class="oi-badges">'+badges+'</span></a>';
      }).join('')+
      '<a class="org-item org-item-foot" href="/">'+(multi?'Accounts & inboxes':'All inboxes')+' →</a>';
      org.addEventListener('click',function(e){
        e.preventDefault();
        var open=!menu.hidden;
        document.querySelectorAll('.org-menu').forEach(function(m){m.hidden=true;});
        menu.hidden=open;
      });
    });
    document.addEventListener('click',function(e){
      if(e.target.closest('[data-org]')||e.target.closest('.org-menu')) return;
      document.querySelectorAll('.org-menu').forEach(function(m){m.hidden=true;});
    });
  }).catch(function(){});
})();
`

export const TimeAgo: FC<{ ts: number | null }> = ({ ts }) => <span class="time" title={ts ? new Date(ts * 1000).toISOString() : ''}>{relTime(ts)}</span>
