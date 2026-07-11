/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'

// Design language borrowed from opencollective.com: white ground, deep navy
// headings, Open Collective blue, pill buttons, generous whitespace, soft
// watercolor accents.
const CSS = `
:root {
  --bg: #ffffff;
  --bg-soft: #f5f7fa;
  --navy: #0c2d66;
  --ink: #141414;
  --body: #4e5052;
  --muted: #76777a;
  --line: #e6e8eb;
  --blue: #1869f5;
  --blue-dark: #1041a3;
  --blue-soft: #e8f0fe;
  --green-soft: #e2f5ea;
  --pink-soft: #fdeaf1;
  --amber: #b45309;
  --hatch: rgba(12, 45, 102, 0.05);
  --shadow: 0 1px 2px rgba(20, 20, 20, 0.04), 0 12px 32px rgba(20, 20, 20, 0.06);
  --sans: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #10141d; --bg-soft: #171c27; --navy: #dbe6f8; --ink: #e8eaef; --body: #b6bcc7;
    --muted: #8a919d; --line: #2a3140; --blue: #6ca2f8; --blue-dark: #97bffa;
    --blue-soft: #1c2839; --green-soft: #16281f; --pink-soft: #2c1e26; --amber: #d99a4e;
    --hatch: rgba(219, 230, 248, 0.06);
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"] {
  --bg: #10141d; --bg-soft: #171c27; --navy: #dbe6f8; --ink: #e8eaef; --body: #b6bcc7;
  --muted: #8a919d; --line: #2a3140; --blue: #6ca2f8; --blue-dark: #97bffa;
  --blue-soft: #1c2839; --green-soft: #16281f; --pink-soft: #2c1e26; --amber: #d99a4e;
  --hatch: rgba(219, 230, 248, 0.06);
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.35);
}
:root[data-theme="light"] {
  --bg: #ffffff; --bg-soft: #f5f7fa; --navy: #0c2d66; --ink: #141414; --body: #4e5052;
  --muted: #76777a; --line: #e6e8eb; --blue: #1869f5; --blue-dark: #1041a3;
  --blue-soft: #e8f0fe; --green-soft: #e2f5ea; --pink-soft: #fdeaf1; --amber: #b45309;
  --hatch: rgba(12, 45, 102, 0.05);
  --shadow: 0 1px 2px rgba(20, 20, 20, 0.04), 0 12px 32px rgba(20, 20, 20, 0.06);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0; background: var(--bg); color: var(--body);
  font-family: var(--sans); font-size: 16px; line-height: 1.6;
  overflow-x: clip; /* decorative hero blobs bleed past the viewport edge */
}
.wrap { max-width: 1060px; margin: 0 auto; padding: 0 20px; }
a { color: inherit; }
h1, h2, h3 { color: var(--navy); margin: 0; }
.btn {
  display: inline-block; border: 1.5px solid var(--blue); border-radius: 100px;
  background: var(--blue); color: #fff; font: inherit; font-weight: 600;
  padding: 12px 26px; cursor: pointer; text-decoration: none; text-align: center;
  transition: background .15s, border-color .15s;
}
.btn:hover { background: var(--blue-dark); border-color: var(--blue-dark); color: var(--bg); }
.btn.ghost { background: transparent; color: var(--navy); border-color: var(--line); font-weight: 500; }
.btn.ghost:hover { background: var(--bg-soft); }
.btn:focus-visible, input:focus-visible, .plan input:focus-visible + span { outline: 2.5px solid var(--blue); outline-offset: 2px; }

/* nav */
.nav { display: flex; align-items: center; gap: 20px; padding: 22px 0; }
.wordmark { font-weight: 800; font-size: 17px; text-decoration: none; color: var(--navy); letter-spacing: -0.3px; }
.wordmark .at { color: var(--blue); }
.nav .spacer { flex: 1; }
.nav a.plain { font-size: 14.5px; color: var(--body); text-decoration: none; }
.nav a.plain:hover { color: var(--navy); }

/* hero */
.hero { position: relative; padding: 72px 0 40px; }
.blob { position: absolute; border-radius: 50%; filter: blur(60px); z-index: -1; opacity: .8; }
.blob.b1 { width: 380px; height: 380px; background: var(--blue-soft); top: -60px; right: -80px; }
.blob.b2 { width: 260px; height: 260px; background: var(--green-soft); top: 180px; left: -120px; }
.blob.b3 { width: 200px; height: 200px; background: var(--pink-soft); top: 320px; right: 220px; }
.hero h1 {
  font-size: clamp(36px, 6vw, 60px); line-height: 1.08; letter-spacing: -1.8px;
  margin: 0 0 22px; max-width: 16ch; text-wrap: balance; font-weight: 800;
}
.hero p.lede { font-size: clamp(17px, 2.2vw, 20px); max-width: 54ch; margin: 0 0 36px; }
.hero p.lede b { color: var(--navy); font-weight: 650; }
.claim { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px; max-width: 660px; }
.claim .addr {
  flex: 1; min-width: 260px; display: flex; align-items: center;
  border: 1.5px solid var(--line); border-radius: 100px; background: var(--bg);
  font-family: var(--mono); font-size: clamp(15px, 2.4vw, 18px); box-shadow: var(--shadow);
  padding: 0 20px;
}
.claim input { border: none; background: none; color: var(--ink); font: inherit; padding: 15px 0; width: 100%; min-width: 40px; }
.claim input::placeholder { color: var(--muted); }
.claim .domain { color: var(--blue); font-weight: 700; white-space: nowrap; }
.claim-note { font-size: 13.5px; color: var(--muted); margin-top: 14px; }

/* sections */
section h2 { font-size: clamp(25px, 3.6vw, 36px); letter-spacing: -0.8px; margin: 0 0 12px; text-wrap: balance; font-weight: 800; }
.sub { max-width: 58ch; margin: 0 0 32px; font-size: 16.5px; }

/* demo */
.demo { padding: 64px 0 8px; }
.thread {
  border: 1px solid var(--line); border-radius: 20px; background: var(--bg);
  box-shadow: var(--shadow); padding: 24px; display: flex; flex-direction: column; gap: 13px;
  max-width: 720px;
}
.d-label { font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--muted); }
.d-msg { border: 1px solid var(--line); border-radius: 14px; padding: 13px 16px; }
.d-msg.out { border: 1.5px solid var(--blue); }
.d-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; margin-bottom: 5px; color: var(--muted); }
.d-head b { font-size: 13.5px; color: var(--navy); }
.d-head .addr2 { font-family: var(--mono); font-size: 10.5px; }
.d-body { font-size: 14.5px; margin: 0; color: var(--body); }
.d-int { margin-left: 34px; border-left: 3px dashed var(--line); padding-left: 15px; display: flex; flex-direction: column; gap: 9px; }
.d-note {
  background: repeating-linear-gradient(-45deg, var(--hatch) 0 4px, transparent 4px 9px), var(--bg-soft);
  border: 1.5px dashed var(--line); border-radius: 12px; padding: 10px 13px; font-size: 13.5px;
}
.d-note b { font-size: 13px; color: var(--navy); }
.d-event { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.d-chip {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  border: 1.5px dashed var(--line); border-radius: 100px; padding: 1.5px 9px; white-space: nowrap;
}
.d-ava {
  width: 22px; height: 22px; border-radius: 50%; flex: none;
  background: var(--bg-soft); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 8.5px; font-weight: 700; color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
}
.demo .aside { font-size: 14px; margin-top: 16px; max-width: 62ch; }
.demo .aside b { color: var(--navy); }

/* how it works */
.how { padding: 72px 0 10px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.step { border: 1px solid var(--line); border-radius: 20px; background: var(--bg); padding: 22px; box-shadow: var(--shadow); }
.step .n {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%; background: var(--blue-soft);
  color: var(--blue); font-size: 13px; font-weight: 700;
}
.step:nth-child(2) .n { background: var(--green-soft); color: #1d7a4f; }
.step:nth-child(3) .n { background: var(--pink-soft); color: #c2447c; }
:root[data-theme="dark"] .step:nth-child(2) .n { color: #7dd3a8; }
:root[data-theme="dark"] .step:nth-child(3) .n { color: #ef9fc4; }
.step h3 { font-size: 17px; margin: 12px 0 6px; }
.step p { font-size: 14.5px; margin: 0; }
.step p b { color: var(--navy); font-weight: 600; }

/* features */
.feats { padding: 44px 0 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 28px; }
.feat { font-size: 14.5px; padding: 10px 0; border-top: 1px solid var(--line); }
.feat b { color: var(--navy); font-weight: 650; display: block; }

/* pricing */
.pricing { padding: 80px 0 8px; }
.plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: stretch; }
.plan-card {
  border: 1px solid var(--line); border-radius: 20px; background: var(--bg);
  padding: 26px; display: flex; flex-direction: column; gap: 6px; box-shadow: var(--shadow);
}
.plan-card.hot { border: 2px solid var(--blue); position: relative; }
.plan-card.hot .tag {
  position: absolute; top: -13px; left: 22px; background: var(--blue); color: #fff;
  font-size: 11px; font-weight: 700; letter-spacing: 1px;
  padding: 3px 12px; border-radius: 100px; text-transform: uppercase;
}
.plan-card h3 { font-size: 18px; }
.plan-card .price { font-size: 36px; font-weight: 800; letter-spacing: -1.5px; margin: 4px 0 0; color: var(--navy); font-variant-numeric: tabular-nums; }
.plan-card .price small { font-size: 14px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
.plan-card .yearly { font-size: 12.5px; color: var(--blue); font-weight: 600; margin: 0 0 10px; }
.plan-card ul { margin: 0 0 18px; padding: 0; list-style: none; font-size: 14.5px; display: grid; gap: 7px; }
.plan-card ul b { color: var(--navy); font-weight: 600; }
.plan-card .btn { margin-top: auto; }
.pricing .foot { font-size: 13.5px; color: var(--muted); margin-top: 18px; }

/* waitlist */
.waitlist { padding: 80px 0 20px; }
.wl-card {
  border: 2px solid var(--blue); border-radius: 24px; background: var(--bg);
  box-shadow: var(--shadow); padding: 30px; max-width: 640px;
}
.wl-card p.sub { margin: 0 0 20px; }
.wl-card form { display: grid; gap: 13px; }
.wl-card label.lbl { font-size: 11px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); }
.wl-card .field {
  border: 1.5px solid var(--line); border-radius: 12px; background: var(--bg-soft);
  color: var(--ink); font: inherit; padding: 12px 15px; width: 100%;
}
.wl-addr { display: flex; align-items: center; border: 1.5px solid var(--line); border-radius: 12px; background: var(--bg-soft); font-family: var(--mono); padding: 0 15px; }
.wl-addr input { border: none; background: none; color: var(--ink); font: inherit; padding: 12px 0; width: 100%; }
.wl-addr .domain { color: var(--blue); font-weight: 700; }
.plan-picks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.plan { position: relative; }
.plan input { position: absolute; opacity: 0; }
.plan span {
  display: flex; flex-direction: column; gap: 1px; border: 1.5px solid var(--line);
  border-radius: 12px; padding: 10px 13px; font-size: 13px; cursor: pointer;
}
.plan span b { font-size: 13.5px; color: var(--navy); }
.plan span small { color: var(--muted); font-size: 11.5px; }
.plan input:checked + span { border-color: var(--blue); background: var(--blue-soft); }
.wl-ok {
  border: 2px solid #2a9d5e; background: var(--green-soft); border-radius: 14px;
  padding: 14px 18px; font-weight: 600; margin-bottom: 18px; color: var(--navy);
}

/* footer */
.footer {
  margin-top: 88px; border-top: 1px solid var(--line);
  padding: 28px 0 48px; font-size: 13.5px; color: var(--muted);
  display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: center;
}
.footer .spacer { flex: 1; }

@media (max-width: 820px) {
  .steps, .plans, .feats, .plan-picks { grid-template-columns: 1fr; }
  .plan-card.hot { order: -1; }
  .hero { padding-top: 44px; }
  .d-int { margin-left: 10px; padding-left: 10px; }
  .claim .btn { width: 100%; }
  .blob { display: none; }
  .nav { gap: 14px; }
  .nav .btn { display: none; } /* the hero + waitlist section carry the CTA on mobile */
}
`

const SCRIPT = `
const slug = (v) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const hero = document.getElementById('hero-name');
const wl = document.getElementById('wl-name');
if (hero) {
  hero.addEventListener('input', () => { wl.value = slug(hero.value) || ''; });
  hero.form && hero.form.addEventListener('submit', (e) => e.preventDefault());
}
document.getElementById('claim-btn').addEventListener('click', () => { wl.value = slug(hero.value); });
if (wl) wl.addEventListener('blur', () => { wl.value = slug(wl.value); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
`

export const HomePage: FC<{ joined?: boolean; currency?: 'USD' | 'EUR' }> = ({ joined, currency = 'USD' }) => {
  const s = currency === 'EUR' ? '€' : '$'
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#10141d" media="(prefers-color-scheme: dark)" />
        <title>collective.email — an email address for your collective</title>
        <meta name="description" content="Share one inbox within your group, assign any conversation to any member, and have the internal conversation right next to the email. yourcollective@collective.email" />
        <link rel="icon" href="/static/icon-192.png" type="image/png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="wrap">
          <nav class="nav">
            <a class="wordmark" href="/">✉ collective<span class="at">.email</span></a>
            <span class="spacer" />
            <a class="plain" href="#pricing">Pricing</a>
            <a class="plain" href="/login">Sign in</a>
            <a class="btn ghost" href="#waitlist" style="padding:9px 18px">Join the waiting list</a>
          </nav>

          <header class="hero">
            <span class="blob b1" /><span class="blob b2" /><span class="blob b3" />
            <h1>An email address for your collective.</h1>
            <p class="lede">
              <b>Share the inbox</b> within your group, <b>assign a conversation</b> to any member,
              and <b>talk about it internally</b> — right next to the email, invisible to the sender.
              No shared passwords, no forwarding spaghetti, no “did anyone answer this?”
            </p>
            <form class="claim">
              <span class="addr">
                <input id="hero-name" placeholder="yourcollective" aria-label="Your collective's name" maxlength={40} autocomplete="off" spellcheck={false} />
                <span class="domain">@collective.email</span>
              </span>
              <a class="btn" id="claim-btn" href="#waitlist">Claim it →</a>
            </form>
            <p class="claim-note">Works the minute you sign up — no DNS, no mail server, no IT person.</p>
          </header>

          <section class="demo">
            <h2>One address outside. A whole collective inside.</h2>
            <p class="sub">Marie writes to one clean address and gets one clear answer. Your collective sees the whole story — who's on it, what was said, and everything discussed along the way.</p>
            <div class="thread" role="img" aria-label="Example conversation showing an incoming email, internal notes between members, and the reply sent by the collective">
              <div class="d-msg">
                <div class="d-head"><span class="d-ava">MV</span><b>Marie Vandenberghe</b><span class="addr2">→ lacooperative@collective.email · Tue 10:42</span></div>
                <p class="d-body">Hi! Could we host our general assembly at your space on Sept 12? We'd be around 35 people.</p>
              </div>
              <div class="d-int">
                <span class="d-label">⌁ Internal — Marie never sees this</span>
                <div class="d-event">⚙ Automatically assigned to <b>Xavier</b> based on previous emails from this sender</div>
                <div class="d-note"><b>Leen</b> — @xavier Sept 12 is free in the calendar. Member rate would be €120 👍</div>
              </div>
              <div class="d-msg out">
                <div class="d-head"><span class="d-ava">LC</span><b>La Coopérative</b><span class="addr2">lacooperative@collective.email → marie@… · Tue 14:20</span><span class="d-chip">✎ sent by Xavier · members only</span></div>
                <p class="d-body">Hi Marie! Great news — the space is free on Sept 12, and the member rate is €120. Shall I pencil you in?</p>
              </div>
            </div>
            <p class="aside"><b>Answer without opening the app:</b> new requests land in each member's personal inbox. Reply to the notification and your answer goes out as the collective — the thread is assigned to you. If a teammate answered first, we stop your reply and tell you who got there.</p>
          </section>

          <section class="how">
            <h2>Up and running in three steps</h2>
            <p class="sub">Built for groups where everyone pitches in — coworking spaces, co-ops, associations, clubs, neighborhood collectives.</p>
            <div class="steps">
              <div class="step">
                <span class="n">1</span>
                <h3>Claim your address</h3>
                <p><b>yourcollective@collective.email</b> is live immediately. Point people to it from your website, flyers, anywhere.</p>
              </div>
              <div class="step">
                <span class="n">2</span>
                <h3>Invite your people</h3>
                <p>Share one invite link in your group chat. Everyone joins with their <b>own email</b> — no shared passwords, sign in with a 6-digit code.</p>
              </div>
              <div class="step">
                <span class="n">3</span>
                <h3>Never drop a thread</h3>
                <p>Every conversation is <b>needs reply</b> or <b>answered</b> — automatically. The oldest waiting thread is always on top, with a name next to it.</p>
              </div>
            </div>
            <div class="feats">
              <div class="feat"><b>Assign with a paper trail</b>“Xavier assigned this to Leen” — every handoff is recorded.</div>
              <div class="feat"><b>Internal notes</b>Discuss the answer next to the email, invisible to the sender.</div>
              <div class="feat"><b>Reply from your inbox</b>Answer notifications directly; duplicates are caught before they send.</div>
              <div class="feat"><b>Your pace of notifications</b>Every email as it comes, a daily digest, or weekly. Each member chooses.</div>
              <div class="feat"><b>Tags &amp; search</b>#bookings, #invoices, #press — triage that the whole group shares.</div>
              <div class="feat"><b>Attachments included</b>Send and receive files, on the web or straight from your inbox.</div>
            </div>
          </section>

          <section class="pricing" id="pricing">
            <h2>Simple pricing</h2>
            <p class="sub">Pay monthly, or yearly with two months free. We're onboarding collectives gradually — join the waiting list and you'll get your invite when your spot opens. No payment until then.</p>
            <div class="plans">
              <div class="plan-card">
                <h3>Duo</h3>
                <p class="price">{s}10<small> / month</small></p>
                <p class="yearly">or {s}100 / year — 2 months free</p>
                <ul>
                  <li><b>Up to 2 members</b></li>
                  <li>yourcollective@collective.email</li>
                  <li>Shared inbox, assignments, internal notes</li>
                  <li>Notifications &amp; reply-by-email</li>
                </ul>
                <a class="btn ghost" href="#waitlist">Join the waiting list</a>
              </div>
              <div class="plan-card hot">
                <span class="tag">Most collectives</span>
                <h3>Collective</h3>
                <p class="price">{s}25<small> / month</small></p>
                <p class="yearly">or {s}250 / year — 2 months free</p>
                <ul>
                  <li><b>Up to 5 members</b></li>
                  <li>Everything in Duo</li>
                  <li>Tags &amp; auto-assignment</li>
                  <li>Daily &amp; weekly digests</li>
                </ul>
                <a class="btn" href="#waitlist">Join the waiting list</a>
              </div>
              <div class="plan-card">
                <h3>Pro</h3>
                <p class="price">{s}100<small> / month</small></p>
                <p class="yearly">or {s}1,000 / year — 2 months free</p>
                <ul>
                  <li><b>Your own domain</b> — hello@yourcollective.org</li>
                  <li>Everything in Collective</li>
                  <li>More members</li>
                  <li>Priority support</li>
                </ul>
                <a class="btn ghost" href="#waitlist">Join the waiting list</a>
              </div>
            </div>
            <p class="foot">Prices are the same in USD and EUR — you're seeing {currency === 'EUR' ? 'euros' : 'dollars'} based on your location. Need more seats or something special? Join the waiting list and tell us — we're building this with the first collectives.</p>
          </section>

          <section class="waitlist" id="waitlist">
            <h2>Join the waiting list</h2>
            <div class="wl-card">
              {joined ? (
                <p class="wl-ok">✓ You're on the list! We'll email you when your spot opens — no payment until then.</p>
              ) : null}
              <p class="sub">Tell us who you are and we'll reserve your address. First come, first served.</p>
              <form method="post" action="/waitlist">
                <label class="lbl" for="wl-name">Your collective's address</label>
                <span class="wl-addr">
                  <input id="wl-name" name="collective_name" placeholder="yourcollective" maxlength={40} autocomplete="off" spellcheck={false} />
                  <span class="domain">@collective.email</span>
                </span>
                <label class="lbl" for="wl-email">Your email</label>
                <input class="field" id="wl-email" type="email" name="email" placeholder="you@example.com" required />
                <label class="lbl">Plan you're interested in</label>
                <div class="plan-picks">
                  <label class="plan"><input type="radio" name="plan" value="duo" /><span><b>Duo</b><small>{s}10 · 2 people</small></span></label>
                  <label class="plan"><input type="radio" name="plan" value="collective" checked /><span><b>Collective</b><small>{s}25 · 5 people</small></span></label>
                  <label class="plan"><input type="radio" name="plan" value="pro" /><span><b>Pro</b><small>{s}100 · own domain</small></span></label>
                </div>
                <button class="btn" type="submit">Put me on the list</button>
              </form>
            </div>
          </section>

          <footer class="footer">
            <span class="wordmark">✉ collective<span class="at">.email</span></span>
            <span>An email address for your collective.</span>
            <span class="spacer" />
            <a href="#pricing">Pricing</a>
            <a href="/login">Sign in</a>
            <a href="mailto:hello@collective.email">hello@collective.email</a>
          </footer>
        </div>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
      </body>
    </html>
  )
}
