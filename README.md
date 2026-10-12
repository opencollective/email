# collective.email

**A shared inbox for collectives.** One address (`yourcollective@collective.email`, or `hello@yourdomain.org`) that the whole group can read and answer: every member signs in with their own email, any conversation is assigned to someone in one tap, and the internal discussion sits right next to the email, invisible to the sender.

This repository is the code that runs [collective.email](https://collective.email). It is open source under the [AGPL-3.0](./LICENSE): use the hosted service, or run your own instance and move your inbox between the two whenever you like.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Local development](#local-development)
- [Run your own instance](#run-your-own-instance)
- [Move an inbox to your instance (import a backup)](#move-an-inbox-to-your-instance-import-a-backup)
- [Configuration reference](#configuration-reference)
- [Project layout](#project-layout)
- [License](#license)

## What it does

- **One address, no shared password.** Members sign in with their personal email and a 6-digit code. A person can belong to several collectives and switch between them.
- **Roles.** Readers follow along, commenters discuss internally, senders answer as the collective, admins manage members. Guests see only the threads shared with them.
- **Assignments.** Every thread has an owner, set in one click on the web or one tap from a notification email. A live badge in each notification shows who has the thread now.
- **Internal notes and @mentions.** Next to the email, never sent to the sender.
- **Works from any mailbox.** Notifications as they arrive or as daily/weekly digests. Reply to a notification and the answer goes out as the collective. If a teammate answered first, your reply is held back and you are told.
- **Drafts.** Prepare a new email or a reply, share it for review, send when it's right.
- **AI agents as members.** Invite an agent with a link; it reads, leaves notes and proposes replies through a plain HTTP API ([`/llms.txt`](https://collective.email/llms.txt)). It can never send email by itself.
- **Your own domain.** Receive by forwarding or MX, send from `hello@yourdomain.org` once DKIM/SPF verify.
- **Rules, tags, contacts, spam, attachments, keyboard shortcuts.**
- **Full export.** Any admin downloads a zip with a browsable offline `inbox.html`, the data as JSON and every attachment, and it imports into another instance (see below).

## How it works

All mail flows through [Resend](https://resend.com): inbound via a webhook, outbound via its API. There is no IMAP or SMTP server to run.

```
sender ──► <slug>@your-domain ──► Resend inbound ──► POST /webhooks/resend
                                                         │  fetch the full email + raw MIME
                                                         ▼
                                              route by address → collective
                                              thread · store · rules · auto-assign
                                                         │
         members' own mailboxes ◄── notifications (Reply-To: a signed per-member address)
                 │ reply
                 ▼
     webhook again → verified member → sent to the original sender as the collective
                     └─ someone already answered? held back, the member is told
```

Stack: Node 22, [Hono](https://hono.dev) with server-rendered JSX (no client framework, except a small React/Tiptap bundle for the reply editor), [libSQL](https://github.com/tursodatabase/libsql) (a local SQLite file, or Turso), mailparser, sanitize-html, satori + resvg for the generated images. Product decisions and history: [SPECS.md](./SPECS.md).

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # node:test, ~300 tests, no network
```

Without `RESEND_API_KEY`, every email (login codes, notifications, outbound replies) is printed to stdout instead of being sent, so the whole flow works offline. Sign-in codes appear in the terminal. To simulate an incoming email:

```bash
curl -X POST localhost:3000/webhooks/resend -H 'Content-Type: application/json' -d '{
  "type": "email.received",
  "data": { "email_id": "t1", "from": "Marie <marie@example.org>",
            "to": ["yourcollective@collective.email"],
            "subject": "Hello!", "message_id": "<m1@example.org>", "text": "Hi there" }
}'
```

`scripts/seed-dev.ts` creates a collective with a member and prints a session token.

## Run your own instance

You need:

- a **domain or subdomain** for the addresses, e.g. `mail.example.org` (collectives become `name@mail.example.org`), plus a hostname for the web app, e.g. `inbox.example.org`;
- a **[Resend](https://resend.com) account** (the free tier is enough to start);
- somewhere to run it: **any Docker host** (one container, one volume), or **Vercel** with Turso and Vercel Blob.

### 1. Resend

1. Create an API key with full access → `RESEND_API_KEY`.
2. **Domains → Add domain**: your mail domain (`mail.example.org`). Add the DKIM/SPF records Resend shows you at your DNS provider.
3. **Receiving**: enable inbound for that domain and add the **MX** record Resend gives you. From then on, mail to any `<anything>@mail.example.org` reaches the webhook.
4. **Webhooks → Add endpoint**: `https://inbox.example.org/webhooks/resend`, event `email.received`. Copy the signing secret → `RESEND_WEBHOOK_SECRET`.

### 2a. Docker (any VPS, Coolify, Fly, …)

The image keeps everything (SQLite database, attachments, generated secret) in the `/data` volume.

```bash
git clone https://github.com/opencollective/email.git collective-email && cd collective-email
docker build -t collective-email .
docker run -d --name collective-email -p 3000:3000 -v collective-email-data:/data \
  -e BASE_URL=https://inbox.example.org \
  -e EMAIL_DOMAIN=mail.example.org \
  -e ADMIN_EMAIL=you@example.org \
  -e BILLING=off \
  -e RESEND_API_KEY=re_xxx \
  -e RESEND_WEBHOOK_SECRET=whsec_xxx \
  -e RESEND_FROM="Inbox <notifications@mail.example.org>" \
  collective-email
```

Put it behind any HTTPS reverse proxy (Caddy, Traefik, nginx) on `BASE_URL`. The container has a healthcheck on `GET /health` and sends digests on its own; no cron needed.

Back up the `/data` volume (it holds `requests.db`, `attachments/` and `.secret`).

### 2b. Vercel

The app runs as a Vercel function (`api/index.js` wraps the Hono app, `api/og.js` serves the generated images; `vercel.json` routes everything). A function has no persistent disk, so state lives in managed services:

| Concern | Service | Env vars |
|---|---|---|
| Database | [Turso](https://turso.tech) (libSQL) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Attachments | Vercel Blob, private store | `BLOB_READ_WRITE_TOKEN` |
| Digests | Vercel Cron → `GET /cron/digest` hourly (already in `vercel.json`) | `CRON_SECRET` |
| Signing | sessions and one-click links | `SECRET` (required, 32+ random characters) |

`vercel link`, set the variables from [`.env.example`](./.env.example), `vercel deploy --prod`, then point `BASE_URL`'s hostname at the project.

### 3. First collective

Open `BASE_URL`, go to **/claim**, pick an address and confirm your email with the code. The collective is live immediately and you are its admin; invite the others from the banner in the inbox. With `BILLING=off` every collective has every feature (own domain included) and nothing ever expires. The accounts in `ADMIN_EMAIL` also get the **/admin** dashboard.

To use an address on another domain for a collective (`hello@example.org`), open **Settings → Your domain** in that inbox: it detects your MX records and tells you whether to forward from your current provider or point MX at Resend.

## Move an inbox to your instance (import a backup)

You can leave collective.email (or move between any two instances) at any time, without losing anything.

1. **Export.** In the inbox, an admin opens **Settings → Data → Download archive (.zip)**. The zip contains `inbox.html` (open it in a browser to read everything offline), `data/*.json` and `attachments/`.
2. **Import** on your instance, with the same environment variables as the server:

   ```bash
   # from a checkout
   npm run import -- ~/Downloads/yourcollective.zip
   # or inside the Docker container
   docker cp yourcollective.zip collective-email:/data/
   docker exec collective-email node dist/cli-import.js /data/yourcollective.zip
   ```

   Options: `--slug newaddress` to import under another address, `--name "New name"`.

   The importer creates the collective and brings over members (with their roles and notification settings), threads, messages, drafts, internal notes, tags, assignment history and attachments. All ids are remapped, so it works on an instance that already has other collectives. It refuses to merge into an address that already exists. Agents are not imported: their API tokens belong to the old instance, so invite them again.
3. **Sign in.** Members sign in with the same email address as before. No new invitations are needed.
4. **Move the mail.**
   - **Your own domain** (`hello@example.org`): set up the domain on the new instance (Settings → Your domain) and point your forward or MX records there. The people writing to you notice nothing.
   - **An `@collective.email` address**: that domain stays with the hosted service. Tell your contacts the new address, and write to [hello@collective.email](mailto:hello@collective.email) to arrange forwarding while they update.
5. **Close the old inbox** from Settings → Data once you're done. It can be reopened for 30 days, then it is deleted.

The same archive format imports into collective.email, so moving back works the same way.

## Configuration reference

All configuration is environment variables; see [`.env.example`](./.env.example) for a commented template.

| Variable | Required | Purpose |
|---|---|---|
| `BASE_URL` | yes | Public URL of the web app, used in every link and email |
| `EMAIL_DOMAIN` | yes | Domain of the collective addresses (`<slug>@EMAIL_DOMAIN`) |
| `ADMIN_EMAIL` | yes | Comma-separated platform admins (the `/admin` dashboard) |
| `RESEND_API_KEY` | yes | Sending, receiving (fetching inbound emails) and custom domains |
| `RESEND_WEBHOOK_SECRET` | yes | Verifies inbound webhook signatures |
| `RESEND_FROM` | | Sender of app emails (codes, notifications). Default `collective.email <notifications@EMAIL_DOMAIN>` |
| `SECRET` | on Vercel | Signs sessions and links. Generated into `DATA_DIR/.secret` when unset elsewhere |
| `BILLING` | | `off` for a self-hosted instance: no trials, plans or payments |
| `DATA_DIR` | | Local database, attachments and secret. Default `./data` (`/data` in Docker) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | | Use Turso instead of the local SQLite file |
| `BLOB_READ_WRITE_TOKEN` | | Store attachments in Vercel Blob instead of `DATA_DIR` |
| `CRON_SECRET` | | Protects `/cron/digest` (Vercel sends it automatically) |
| `TZ`, `DIGEST_HOUR` | | Timezone and local hour of the daily/weekly digests (default 8) |
| `SIGN_REPLIES` | | `false` to stop appending "— Name, for Collective" to replies |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | | Only for running a paid service like collective.email |
| `OPENCOLLECTIVE_TOKEN` | | collective.email only: verifies owners of opencollective.com names |

## Project layout

```
src/
  index.ts          Node/Docker entry (serves static files, runs the digest timer)
  app.ts            the Hono app (also used by api/index.js on Vercel)
  web/              routes and server-rendered pages
  client/           the reply editor (bundled to public/static/composer.js)
  ingest.ts         inbound email: threading, rules, auto-assign
  outbound.ts       replies, forwards, composed emails
  notify.ts         notification emails and digests
  agents.ts         the agent API
  export.ts         the archive zip;  import.ts + cli-import.ts read it back
  db.ts             schema (additive migrations at startup) and queries
test/               node:test suites (npm test)
scripts/            development and maintenance scripts
api/                Vercel function entries
video/              the Remotion promo video
```

Contributions are welcome: open an issue or a pull request. Run `npm run typecheck && npm test` before submitting.

## License

[GNU Affero General Public License v3.0](./LICENSE) or later. You may run, modify and redistribute it; if you offer a modified version as a network service, you must make its source available to its users.
