# collective.email

**An email address for your collective.** `yourcollective@collective.email` — share the inbox within your group, assign a conversation to any member, and have the internal conversation right next to the email, invisible to the sender.

Multi-tenant service: one container hosts every collective. All mail flows through [Resend](https://resend.com) — inbound via webhook, outbound via API. No IMAP, no SMTP, no per-tenant DNS.

## How it works

```
sender ──► <slug>@collective.email ──► Resend inbound ──► POST /webhooks/resend
                                                              │  fetch full email + raw MIME
                                                              ▼
                                                    route by slug → collective
                                                    thread · store · auto-assign
                                                              │
              members' personal inboxes ◄── notifications (Reply-To: slug+r.<signed>@…)
                    │ reply
                    ▼
        webhook again → verified member → send to original sender as <slug>@… (Resend)
                        └─ someone already answered? block + bounce back to the member
```

- **Passwordless**: members sign in with their personal email + 6-digit code; 3-month sessions.
- **Self-serve joining**: each collective shares a 24h invite link; people pick their own email and notification level (as-they-arrive / daily / weekly).
- **Derived status**: last message inbound → *needs reply*; any reply → *answered*. Oldest waiting first.
- **Assignment provenance**: "Xavier assigned this to Leen", "Automatically assigned based on previous emails from this sender", "Assigned — replied via email notification".
- **Attachments**: inbound stored & downloadable, outbound from the web composer or forwarded from email replies.
- **Waiting list**: the homepage takes signups (`waitlist` table + email ping to `ADMIN_EMAIL`); the platform admin converts them into live collectives at `/admin` in one click — no billing yet.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
```

Without `RESEND_API_KEY`, every email (codes, notifications, outbound replies) is printed to stdout, and the webhook accepts test payloads with inline `text` — the whole flow works offline:

```bash
curl -X POST localhost:3000/webhooks/resend -H 'Content-Type: application/json' -d '{
  "type": "email.received",
  "data": { "email_id": "t1", "from": "Marie <marie@example.org>",
            "to": ["yourcollective@collective.email"],
            "subject": "Hello!", "message_id": "<m1@example.org>", "text": "Hi there" }
}'
```

## Production setup

### 1. Resend (mail plumbing)

1. Create an API key → `RESEND_API_KEY`.
2. **Domains → Add domain**: `collective.email`. Resend gives you DKIM/SPF DNS records (see Vercel step).
3. **Receiving**: enable inbound for `collective.email` — Resend gives you the MX record to add.
4. **Webhooks → Add endpoint**: `https://collective.email/webhooks/resend`, event `email.received`. Copy the signing secret → `RESEND_WEBHOOK_SECRET`.
5. Set `RESEND_FROM=collective.email <notifications@collective.email>`.

### 2. Deploy on Vercel (recommended)

The app runs as a single Vercel function (`api/index.js` wraps the Hono app; `vercel.json` rewrites everything to it). State lives in managed services:

| Concern | Service | Env vars |
|---|---|---|
| Database | [Turso](https://turso.tech) (libSQL — same SQLite dialect) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Attachments | Vercel Blob (private downloads proxied via `/attachment/:id`) | `BLOB_READ_WRITE_TOKEN` |
| Digests | Vercel Cron → `GET /cron/digest` hourly (see `vercel.json`) | `CRON_SECRET` |
| Signing | sessions & one-click links | `SECRET` (required — no disk to persist a generated one) |

Steps: `vercel link` → set all env vars from `.env.example` → `vercel deploy --prod` → point the `collective.email` domain at the project. In Vercel's DNS panel add Resend's **MX** record on `@` (all `<slug>@collective.email` mail → webhook) and Resend's DKIM/SPF TXT records. `x-vercel-ip-country` makes the homepage's EUR/USD detection work automatically.

### 3. Alternative: any Docker host

Without `TURSO_DATABASE_URL`/`BLOB_READ_WRITE_TOKEN`, the app falls back to a local SQLite file and attachment files under `/data` — the Dockerfile still works for Coolify/VPS deployments (port 3000, volume at `/data`, healthcheck `GET /health`). Same codebase, zero config divergence.

### 4. First run

Sign in with `ADMIN_EMAIL` → `/admin` → create your first collective (e.g. `commonshub`) with its admin's email. They get an onboarding email; from there everything is self-serve. Existing addresses (like `hello@commonshub.brussels`) can simply auto-forward to `commonshub@collective.email` until the Pro own-domain plan exists.

## Pricing (waitlist only, no billing yet)

Duo $/€10 (2 members) · Collective $/€25 (5 members) · Pro $/€100 (own domain) — monthly, or ×10 yearly (2 months free). The homepage shows EUR or USD based on visitor location (`x-vercel-ip-country`/`cf-ipcountry` headers, Accept-Language fallback). Stripe integration comes once the waiting list validates demand.

## Development notes

- `npm run typecheck` / `npm run build` / `npm start` (serves `dist/`).
- Stack: Hono (SSR JSX, no client framework), better-sqlite3, mailparser (parses raw MIME fetched from Resend), Resend HTTP API.
- Product history and design decisions: [SPECS.md](./SPECS.md).
