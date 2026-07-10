# Requests — a shared inbox for communities

## Vision

Every community should have a single public email address (e.g. `hello@commonshub.brussels`) that any member of the community can help answer. Today that address is a Google Workspace group: mail fans out to a few inboxes, nobody knows who replied, threads fall through the cracks, and there's no way to tag, triage, or assign.

**Requests** turns that address into a shared, transparent inbox that lives where the community already coordinates: Discord.

Core promises:

1. **Nothing falls through the cracks** — every thread is visibly *needs reply*, *answered*, or *closed*.
2. **Anyone can answer** — any community member can read and reply from Discord, without sharing passwords.
3. **Attribution** — you can always see who replied to what, and who a thread is assigned to.
4. **Triage** — tags and simple rules (auto-tag, auto-assign, auto-archive newsletters).

## Architecture overview

```
                 ┌──────────────────────────────┐
  IMAP (IDLE)    │        requests daemon        │     discord.js
Gmail ◄────────► │  sync ▸ rules ▸ notify ▸ send │ ◄────────► Discord
  SMTP           │                               │
                 │        SQLite + .eml files    │
                 └──────────────────────────────┘
```

A single long-running Node.js/TypeScript process:

- **Mail sync** — IMAP connection to the mailbox (IDLE for push), writes messages into SQLite, stores raw `.eml` on disk.
- **Rules engine** — runs on each new inbound message before notification.
- **Discord bot** — mirrors each email thread as a **Discord forum post**; members reply, tag, and assign from there.
- **Sender** — outbound replies go through SMTP as `hello@…`, with correct `In-Reply-To`/`References` headers so recipients see a normal email thread.

No web UI in the MVP. Discord *is* the UI. A read-only web dashboard is Phase 3.

### Why IMAP (and not the Gmail API)?

- Provider-agnostic: any community with any mail host can plug in. Gmail is just the first backend.
- Gmail's IMAP extensions give us the hard parts for free when the host *is* Gmail: `X-GM-THRID` (server-side thread id, so we don't have to reconstruct threading from `References` headers) and `X-GM-LABELS`.
- For non-Gmail hosts we fall back to standard threading (`Message-ID` / `In-Reply-To` / `References`, then subject + participants heuristic).

We sync **All Mail** (or INBOX + Sent), not just INBOX. This matters: if someone replies directly from the Gmail web UI instead of through the bot, the thread still flips to *answered* — the tool observes reality rather than assuming it's the only actor.

### The Google Group problem

A Google Group is **not a mailbox** — it has no IMAP/SMTP endpoint. Two migration options:

| Option | How | Trade-offs |
|---|---|---|
| **A. Convert (recommended)** | Delete the group, create `hello@` as a real Workspace user. Tool connects to it directly. | Cleanest; costs one Workspace license; members lose direct-to-personal-inbox delivery (the bot replaces it). |
| **B. Shadow mailbox** | Keep the group. Create `inbox@…` as a real user, add it as a group member. Tool reads from `inbox@` and sends with "Send As `hello@`". | Zero disruption during trial; slightly messier (group footers, potential duplicates). |

Recommendation: start with **B** for a no-risk trial period, switch to **A** once the community trusts the tool.

Auth: Gmail requires OAuth2 or an **app password** (2FA account, admin can allow). MVP uses an app password — one env var, no OAuth dance. Phase 2 can add proper OAuth2/XOAUTH2.

## Data model (SQLite)

```sql
communities  (id, slug, name, email_address,
              discord_guild_id, discord_forum_channel_id,
              imap_host, imap_user, smtp_host, smtp_user,  -- secrets in env/keyring, not DB
              signature_template, created_at)

members      (id, community_id, discord_user_id, display_name,
              email, role,               -- 'admin' | 'member'
              created_at)

threads      (id, community_id, subject,
              gmail_thread_id,           -- X-GM-THRID when available
              status,                    -- 'needs_reply' | 'answered' | 'closed' | 'spam'
              assignee_member_id,
              discord_post_id,           -- forum post mirroring this thread
              first_message_at, last_message_at, last_direction,
              created_at, updated_at)

messages     (id, thread_id,
              rfc822_message_id, in_reply_to,
              direction,                 -- 'inbound' | 'outbound'
              from_email, from_name, to_json, cc_json,
              body_text, body_html_ref,  -- large HTML kept on disk
              raw_eml_path,
              sent_by_member_id,         -- set when sent via the bot
              imap_uid, sent_at, created_at)

attachments  (id, message_id, filename, mime_type, size_bytes, path)

tags         (id, community_id, name, color, discord_forum_tag_id)

thread_tags  (thread_id, tag_id)

rules        (id, community_id, priority, enabled,
              conditions_json,           -- see Rules below
              actions_json)

events       (id, thread_id, member_id, type,  -- 'replied','assigned','tagged','status_changed','note'
              data_json, created_at)     -- full audit trail: who did what, when
```

Multi-community from day one at the schema level (it's one extra column), even though the MVP runs a single community.

### Thread status — the core invariant

Status is mostly **derived**, so it can't drift from reality:

- Inbound message arrives on a thread → `needs_reply` (unless closed/spam, which reopens it to `needs_reply`).
- Outbound message observed (via bot *or* seen in Sent) → `answered`.
- `closed` / `spam` are manual (button or rule) and stick until a new inbound message arrives.

"Unanswered" is then just: `status = 'needs_reply' ORDER BY last_message_at ASC`.

## Discord UX

We use a **forum channel** (e.g. `#📬-requests`), gated to the community member role. The mapping is 1:1 and native:

| Email concept | Discord concept |
|---|---|
| Thread | Forum post |
| Tag | Forum tag (synced both ways) |
| New inbound message | Message in the post (rendered as embed: sender, date, body as markdown) |
| Needs-reply | Forum tag `🔴 needs reply` (auto-managed) |
| Assignment | Post mentions assignee + `👤 assigned` state in the header embed |

### Interactions

- **Header embed with buttons** on every forum post: `✉️ Reply` · `🙋 Claim` · `👤 Assign` · `🏷 Tag` · `✅ Close` · `🚫 Spam`.
- **`✉️ Reply`** opens a modal; on submit the email is sent as `hello@…` and echoed into the post as an outbound embed labeled *"replied by @xavier"*. A configurable signature is appended, e.g. `— Xavier, for Commons Hub Brussels`.
- **Plain messages typed in the forum post are internal notes** — never emailed. Sending is always explicit (button/modal). This makes accidental sends impossible and gives the team a private discussion space per thread.
- **Slash commands** for everything button-accessible plus: `/requests unanswered` (list, oldest first), `/requests mine`, `/requests stats`.
- **Daily digest** posted to the forum channel (or a mods channel): unanswered count, oldest unanswered threads with links, per-assignee outstanding items. Ping assignees on threads stale > 48h.

### Rendering constraints

- HTML email → markdown (`turndown` or similar), truncated to ~3900 chars with the full message attached as a file when longer.
- Attachments ≤ Discord's upload limit are re-uploaded to the post; larger ones are listed by name (kept on disk, served later by the Phase 3 web UI).
- Quoted reply history is collapsed (strip below `On … wrote:` markers), full text always in the attached original.

## Rules engine

Runs on every new inbound message, ordered by `priority`, first match can `stop` or fall through.

```jsonc
// conditions_json — all listed conditions must match (AND);
// a condition value may be a list (OR within the field)
{
  "from":        "*@newsletter.example.com",   // glob on address
  "subject":     ["contains:invoice", "regex:^\\[ticket\\]"],
  "to":          "hello+events@commonshub.brussels",  // plus-addressing routing!
  "body":        "contains:unsubscribe",
  "has_attachment": true,
  "is_first_message": true                     // only new threads
}

// actions_json
{
  "add_tags":   ["events"],
  "assign_to":  "discord:123456789",
  "set_status": "closed",        // e.g. auto-archive newsletters
  "skip_notification": true,     // don't create/bump the Discord post
  "stop": true
}
```

Plus-addressing (`hello+events@`) is free routing on Gmail — worth advertising to communities as a triage trick.

Rules are managed via `/requests rules` slash commands in the MVP (admin role only); JSON stored as-is. A friendlier builder comes with the web UI.

## Sending & deliverability

- SMTP via the mailbox's own submission server (`smtp.gmail.com` for Workspace) so SPF/DKIM/DMARC are Google's problem, not ours.
- `From: Commons Hub Brussels <hello@…>`; member attribution lives in the signature, not the From header.
- Outbound sets `In-Reply-To` + `References` from the thread's latest inbound message → recipients keep a clean thread.
- **Loop safety**: never trigger rules-with-replies or notifications for messages with `Auto-Submitted != no`, `Precedence: bulk/junk/list`, or our own `Message-ID`s; hard rate-limit outbound per thread.

## Security & privacy

- Mailbox credentials (app password) live in env vars only — never in SQLite, never in Discord.
- The forum channel is role-gated; joining the Discord server alone must not expose the inbox.
- `events` table gives a complete audit trail (who sent/closed/tagged what).
- Raw `.eml` files + SQLite in one data directory → trivial backup, and full re-render/re-import is always possible.

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22 + TypeScript, single process |
| IMAP | `imapflow` (IDLE, Gmail extensions) |
| Parsing | `mailparser`, `turndown` for HTML→md |
| SMTP | `nodemailer` |
| Discord | `discord.js` v14 (forum channels, modals, buttons) |
| DB | `better-sqlite3` (+ Drizzle ORM if desired), WAL mode |
| Deploy | Docker container + volume; runs on a €5 VPS or fly.io |

## Roadmap

**Phase 1 — MVP (the trust-builder)**
- Shadow-mailbox setup (Option B), IMAP sync incl. Sent, SQLite storage
- Forum post per thread, inbound messages rendered, internal notes
- Reply modal (send as `hello@`), Claim/Assign, Close/Spam buttons
- Derived `needs_reply` status + `/requests unanswered`
- Backfill: import the last N months on first run so history is searchable

**Phase 2 — Triage**
- Tags ↔ Discord forum tags (two-way sync)
- Rules engine + plus-addressing routing
- Daily digest + stale-thread pings
- OAuth2 (XOAUTH2) replacing app passwords

**Phase 3 — Beyond one community**
- Read-only web dashboard (stats: response time, volume, per-member replies; attachment browsing)
- Multi-community: one daemon, N mailboxes, N Discord servers
- Other mail hosts (generic IMAP already works; test Fastmail/Migadu)
- Maybe: Matrix/Slack adapters, public "email us" form

## Open questions

1. **Group migration** — comfortable creating one extra Workspace user (`inbox@`) for the trial, or go straight to converting `hello@` to a real mailbox?
2. **Attribution in outbound email** — signature says who replied ("— Xavier, for Commons Hub Brussels"). Always, opt-in per member, or never (anonymous "The Commons Hub team")?
3. **Who is a "member"?** — everyone with a given Discord role, or an explicit allowlist managed by admins?
4. **History** — how far back to backfill on first import? (Suggest: 6 months.)

---

# Revision 2 — web-first (implemented)

Discord is dropped as the interface. Requests is a standalone web app; members' **personal email inboxes** become the second interface. Key decisions, as built:

## Identity & access
- **Passwordless sign-in**: personal email + 6-digit code (sent via Resend). Session lasts **3 months** unless the member explicitly signs out.
- **Self-serve joining**: an admin generates a unique **invite link, valid 24h**, shared anywhere in the community. Whoever opens it enters their name, the email they want to use, and their **notification level** — then verifies with a code and is signed in. Since they joined themselves, they already know how to get back in.
- **Collective page** (the team is called *the collective*): member list with role, notification level, reply count, last seen; admins can generate/revoke invite links, promote/demote admins, **disconnect** someone (kill all their sessions), or **remove** them (access revoked instantly, past attribution preserved). Last-admin removal is blocked. Members edit their own name and notification level here.

## Notifications (proxied by the app, via Resend)
- Levels: **as they arrive** / **daily digest** (max 1/day, at `DIGEST_HOUR`) / **weekly digest** (max 1/week, Mondays). The thread's assignee is always notified immediately regardless of level.
- Each notification carries one-click signed action links: **Assign to me & reply**, and *assign to &lt;each other member&gt;*.
- **Reply-to-answer**: the notification's Reply-To is a signed plus-address (`hello+r.<thread>.<member>.<msg>.<exp>.<sig>@…`). Replying sends the (quote-stripped) answer to the original sender as the collective address, assigns the thread to the replier, and emails back a confirmation.
- **Collision detection**: if someone else answered after the notified message, the emailed reply is **not sent** — the member gets their draft back with "X already replied at T", and the attempt is logged on the thread's internal rail.

## Assignment provenance
Unassigned threads are loudly marked (amber "⚠ unassigned" chip in the inbox, warning box with a Claim button on the thread). Every assignment records **who did it and how**, rendered as events: "Xavier assigned this to Leen", "Leen claimed this thread", "Automatically assigned to Leen based on previous emails from this sender", "Assigned to Leen — replied via email notification", "Xavier assigned this to Leen from a notification email".

## Scope simplifications vs v1
- **One community per instance** (env-configured); multi-community = multiple containers.
- Rules engine reduced to auto-assign-by-sender-history; the generic JSON rules engine stays on the roadmap.
- Gmail `X-GM-THRID` used when offered; fallback threading via References/In-Reply-To, then subject+counterpart.

## Deployment
Single Docker container (Node 22, Hono SSR, better-sqlite3). All state in one `/data` volume (SQLite, attachments, signing secret). Built for Coolify: Dockerfile deploy, port 3000, `/health` healthcheck, config via env (`RESEND_API_KEY`, `IMAP_*`, `SMTP_*`, …) — see `.env.example` and README.

---

# Revision 3 — multi-tenant on Resend (implemented)

The product is now **collective.email**: `<slug>@collective.email`, one container hosting all collectives.

- **Mail**: IMAP/SMTP removed. Inbound: Resend receiving → `email.received` webhook (svix-verified) → fetch full email via `GET /emails/receiving/{id}` → download raw MIME → mailparser → route by recipient slug. Outbound: Resend API as `<slug>@collective.email` with proper threading headers.
- **Tenancy**: `collectives` table; members/threads/tags/invites scoped by `collective_id`; sessions carry the verified email, memberships resolved per collective (one person can be in several); app routes under `/c/<slug>/…` with a chooser page.
- **Reply-by-email** unchanged in spirit: `Reply-To: <slug>+r.<thread>.<member>.<msg>.<exp>.<sig>@collective.email`, collision detection, auto-responder guard.
- **Platform admin** (`ADMIN_EMAIL`): `/admin` lists the waiting list and creates collectives (slug + name + admin email → onboarding email). This is the manual "billing" gate until Stripe.
- **Homepage**: Open Collective-inspired design (white, navy, OC blue, pill buttons, watercolor accents), USD/EUR by visitor geo, working waiting list.
- **Migration path for BYO addresses** (e.g. hello@commonshub.brussels): auto-forward to `<slug>@collective.email`; own-domain sending is the Pro plan (customer domain verified in Resend), replacing the old IMAP design.
