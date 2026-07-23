/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { MarketingPage } from './home.js'

const Q: FC<{ q: string; children?: unknown }> = (p) => (
  <details class="faq-item">
    <summary>{p.q}</summary>
    <div class="a">{p.children}</div>
  </details>
)

export const FaqPage: FC<{ currency?: 'USD' | 'EUR' }> = ({ currency = 'USD' }) => {
  const s = currency === 'EUR' ? '€' : '$'
  return (
  <MarketingPage
    title="FAQ — collective.email"
    og="faq"
    description="Frequently asked questions about collective.email: how the shared inbox works, pricing, roles, your own domain, and what happens to your data."
  >
    <h1>Frequently asked questions</h1>
    <p class="lede">The short version: one address for your collective, everyone signs in with their own email, and nothing falls through the cracks. The longer versions below.</p>

    <Q q="How does it work?">
      <p>You claim <code>yourcollective@collective.email</code>, confirm your own email with a 6-digit code, and share an invite link with your group. From then on, every email sent to that address lands in a shared inbox where any member can read it, claim it, discuss it internally, and answer it — the reply goes out as your collective's address, not a personal one.</p>
    </Q>

    <Q q="Do we need new passwords or a new email account?">
      <p>No — that's the whole point. There is no shared password, ever. Each member signs in with their <b>own personal email</b> and a 6-digit code we send them. Nobody can lock the group out by leaving, and nobody has to remember who holds the credentials.</p>
    </Q>

    <Q q="Can we use our own domain, like hello@ourcollective.org?">
      <p>Yes — that's the <b>Pro plan</b>, and it's self-serve from the <b>Your domain</b> page. Two ways to receive: keep your current mailbox and simply <b>add a forward</b> (Gmail's confirmation email lands right in your shared inbox — one click), or point your domain's MX records at us for a full takeover. To <b>send</b> as your domain you add a few DNS records (DKIM + SPF) — being able to add them is the ownership proof — and the moment they verify, replies go out as hello@ourcollective.org. Until then, replies are sent from your @collective.email address with your domain in the display name. Pay for Pro like everything here: subscribe, redeem a code, or spend credits.</p>
    </Q>

    <Q q="Who gets notified when an email arrives?">
      <p>Each member chooses: <b>as they arrive</b>, a <b>daily digest</b>, or a <b>weekly digest</b>. Instant notifications include one-click buttons to assign the conversation to yourself or a teammate, and a live status badge — so if you open the notification an hour late, you can see it's already being handled.</p>
    </Q>

    <Q q="Can I answer directly from my own mailbox?">
      <p>Yes. Just reply to the notification email — your answer goes to the original sender as <code>yourcollective@collective.email</code>, and the thread is assigned to you. If a teammate answered while you were typing, we stop your reply and tell you instead of double-answering the sender.</p>
    </Q>

    <Q q="What are the roles?">
      <p>Four, from lightest to heaviest: <b>readers</b> follow along and get the digests; <b>commenters</b> discuss internally — notes, assigning, tags — but can't email the outside world; <b>senders</b> answer on behalf of the collective; <b>admins</b> also manage members and billing. Readers and commenters are free and unlimited; senders and admins are the paid seats.</p>
    </Q>

    <Q q="How much does it cost? Is there a free plan?">
      <p>Every collective starts with a <b>free month</b> — no card needed. After that the Collective plan is {s}10 a month: up to 10 senders, 1,000 replies a month, unlimited readers and commenters. Pro is {s}100 a month with your own domain and room to grow. You can also earn credits by referring collectives that actually use it — one credit is one month of service.</p>
    </Q>

    <Q q="What happens if we stop paying?">
      <p>Nothing dramatic, and nothing silent either. Your inbox goes <b>read-only for 30 days</b> — everything is still there, nothing is deleted. If you have credits, one is used automatically to cover another month. After the grace period the address stops receiving, and lapsed addresses are eventually released so nobody can squat a name forever.</p>
    </Q>

    <Q q="Does it handle attachments and images?">
      <p>Yes — incoming attachments are stored privately and shown in the thread (images inline), and you can attach files to your replies from the web inbox.</p>
    </Q>

    <Q q="What about spam?">
      <p>One click marks a conversation as spam — from the inbox or straight from the notification email. Spam doesn't count as “needs a reply” and stops nagging everyone.</p>
    </Q>

    <Q q="Where is our data, and can we leave?">
      <p>Everything is hosted in the EU (Dublin), with nightly backups. And your conversations are yours, one click deep: any admin can <b>download a full archive</b> from the Billing page. The zip expands into a folder with a browsable offline inbox — open <code>inbox.html</code> and read your whole history, internal notes and attachments included, no server needed — plus the raw data as JSON for importing anywhere else. No lock-in games.</p>
    </Q>

    <Q q="Can one person be part of several collectives?">
      <p>Yes — one personal email, one sign-in, and a chooser for every collective you belong to. Roles are per collective, so you can be an admin in one and a reader in another.</p>
    </Q>

    <h2>Something else?</h2>
    <p>Email <a href="mailto:hello@collective.email">hello@collective.email</a> — it lands in our own shared inbox, obviously. Or read the <a href="/docs">documentation</a>.</p>
  </MarketingPage>
  )
}

export const DocsPage: FC<{ currency?: 'USD' | 'EUR' }> = ({ currency = 'USD' }) => {
  const s = currency === 'EUR' ? '€' : '$'
  return (
  <MarketingPage
    title="Documentation — collective.email"
    og="docs"
    description="Everything about running your collective's shared inbox: claiming an address, inviting members, roles, answering by email, notifications, billing, credits and custom domains."
  >
    <h1>Documentation</h1>
    <p class="lede">Everything you need to run <code>yourcollective@collective.email</code>. Five minutes of reading covers all of it.</p>

    <div class="doc-toc">
      <a href="#start">Getting started</a>
      <a href="#members">Members &amp; roles</a>
      <a href="#inbox">The inbox</a>
      <a href="#answering">Answering</a>
      <a href="#notifications">Notifications</a>
      <a href="#billing">Billing &amp; credits</a>
      <a href="#domain">Your own domain</a>
      <a href="#app">Install as an app</a>
    </div>

    <section id="start">
      <h2>Getting started</h2>
      <ol>
        <li><b>Claim your address</b> at <a href="/claim">/claim</a> — at least 6 characters, letters and numbers. We email you a 6-digit code to confirm; the address is then reserved for you for 48 hours.</li>
        <li><b>Activate it</b>: start your <b>free month</b> (one click, no card), subscribe ({s}10 a month), or redeem a discount code.</li>
        <li><b>Invite your collective</b> — share one link, no accounts to create for anyone.</li>
      </ol>
      <p>The address works immediately: put it on your website, flyers, anywhere.</p>
    </section>

    <section id="members">
      <h2>Members &amp; roles</h2>
      <p>From the menu, open <b>Members</b>. Create an invite link, pick what role joiners get, and share it — it's valid for 24 hours, and whoever opens it signs up with their own email and notification preference. No passwords are ever shared.</p>
      <table class="roles-table">
        <tr><th>Reader</th><td>Reads everything and gets the digests. Free, unlimited.</td></tr>
        <tr><th>Commenter</th><td>Discusses internally — notes, assigning, tags. Can't email the outside world. Free, unlimited.</td></tr>
        <tr><th>Sender</th><td>Answers senders as the collective. Paid seat.</td></tr>
        <tr><th>Admin</th><td>Everything a sender can, plus members, billing and settings. Paid seat.</td></tr>
      </table>
      <p>Admins change anyone's role from the Members page with one tap. Removing a member keeps their past replies attributed.</p>
    </section>

    <section id="inbox">
      <h2>The inbox</h2>
      <p><b>Inbox</b> shows every conversation; <b>Needs reply</b> is your zero-target — it counts every thread where the sender is waiting; <b>Mine</b> is what's assigned to you. Conversations move to <b>Answered</b> automatically when a reply goes out, and you can close or tag anything.</p>
      <ul>
        <li><b>Assignment</b> — claim a thread yourself or hand it to a teammate; the history shows who assigned what to whom, and when. If two people try, the first one wins and the second is told — no silent overrides.</li>
        <li><b>Internal notes</b> — a private conversation right next to the email, invisible to the sender. Ask a teammate, leave context, decide together.</li>
        <li><b>Tags</b> — freeform labels for filtering (<code>#press</code>, <code>#bookings</code>, …).</li>
        <li><b>Drafts</b> — what you type is kept locally until sent, even if you close the tab.</li>
      </ul>
    </section>

    <section id="answering">
      <h2>Answering</h2>
      <p>Two ways, same result — the sender gets a reply from your collective's address:</p>
      <ul>
        <li><b>From the web inbox</b>: open the thread, write, attach files if needed, send.</li>
        <li><b>From your own mailbox</b>: reply to the notification email. The thread is assigned to you when your answer goes out. If someone answered first, your reply is stopped and you're told — the sender never gets two answers.</li>
      </ul>
      <p>While you type in the web inbox, teammates see “…is drafting a response” live on the same thread.</p>
    </section>

    <section id="notifications">
      <h2>Notifications</h2>
      <p>Per member, three levels: <b>as they arrive</b>, <b>daily digest</b>, or <b>weekly digest</b>. Instant notifications carry one-click actions — assign to me, assign to a teammate, mark as spam — and a <b>live status badge</b> rendered the moment you open the email, so a notification opened an hour late shows whether the thread is already assigned or answered, and by whom.</p>
    </section>

    <section id="billing">
      <h2>Billing &amp; credits</h2>
      <p>The <b>Collective</b> plan ({s}10 a month) includes 10 sender seats and 1,000 replies a month; readers and commenters are always free and unlimited. <b>Pro</b> ({s}100) adds your own domain and room for big teams.</p>
      <p><b>Credits</b>: 1 credit = 1 month of service, and they're used automatically if a subscription or trial lapses (after which the inbox is read-only for a 30-day grace period). You earn credits by:</p>
      <ul>
        <li><b>Referring collectives</b> — share your referral link from the Billing page. You earn a credit once the collective you brought has been active for a month and is really using its inbox.</li>
      </ul>
      <p>After the free month, the tool is sustained by the collectives it serves rather than by ads or investors.</p>
    </section>

    <section id="domain">
      <h2>Your own domain (Pro)</h2>
      <p>Want <code>hello@ourcollective.org</code> instead of a <code>@collective.email</code> address? On the Pro plan, open <b>Your domain</b> from the menu and:</p>
      <ol>
        <li><b>Enter the address</b> you want at your domain.</li>
        <li><b>Receiving</b> — pick one: keep your current mailbox and <b>add a forward</b> to your @collective.email address (Gmail sends a confirmation that appears right in your shared inbox; there's a “send a test” button to prove the loop works), or point your domain's <b>MX records</b> at us for a full takeover. Careful with MX: personal mailboxes at the same domain stop working, so use forwarding if anyone has one.</li>
        <li><b>Sending</b> — add the DKIM and SPF records shown on the page wherever your DNS lives (Cloudflare, Gandi, OVH…). Adding them is the ownership proof. Hit “Check verification”; the moment it turns green, replies go out as your domain. Until then they're sent from your @collective.email address with your domain in the display name — honest and deliverable.</li>
      </ol>
      <p>Your website and everything else on the domain are untouched. Pro can be paid like everything here: subscription, discount code, or credits (a Pro month is 10 credits).</p>
    </section>

    <section id="app">
      <h2>Install as an app</h2>
      <p>The inbox is a PWA: on iPhone, open it in Safari → Share → <b>Add to Home Screen</b>; on Android, Chrome will offer to install it. You get a full-screen app with your collective's inbox one tap away.</p>
    </section>

    <h2>Still stuck?</h2>
    <p>Check the <a href="/faq">FAQ</a> or email <a href="mailto:hello@collective.email">hello@collective.email</a>.</p>
  </MarketingPage>
  )
}

export const AboutPage: FC<{ currency?: 'USD' | 'EUR' }> = ({ currency = 'USD' }) => {
  const s = currency === 'EUR' ? '€' : '$'
  return (
  <MarketingPage
    title="About — collective.email"
    og="about"
    description="Why collective.email exists: every collective needs an email address, and sharing a password never works. The backstory, by Xavier Damman."
  >
    <h1>Every collective hits the same wall.</h1>
    <p class="lede">collective.email exists because of a problem I've had over and over for twenty years.</p>

    <p>I've spent most of my life starting citizen initiatives and joining other people's — tech communities, neighborhood projects, open source collectives, and lately the <a href="https://commonshub.brussels" target="_blank" rel="noopener">Commons Hub</a> in Brussels. Different causes, different people, and the exact same week-one problem every single time:</p>

    <p><b>“We need an email address people can reach us at.”</b></p>

    <p>So someone creates <code>hello@ourcollective</code> on Gmail. It takes five minutes and feels solved. Then the real questions arrive. <b>How do we share the password?</b> You paste it in the group chat — now it's a security hole, and the day someone adds two-factor with their own phone number, everyone else is locked out. And even when access is sorted: <b>who actually checks it?</b> In practice, always the same person. They become the inbox. Every question flows through them, nobody else sees what was asked or answered, and when they're on holiday — or burned out, which is how these stories usually end — messages from real people go unanswered and the collective looks dead from the outside.</p>

    <p>The tools for this exist, but they're built for companies: helpdesks with agents, tickets and SLAs, priced per seat for support teams. A citizen initiative doesn't have agents. It has fifteen people who care, three of whom will answer email this month, and no budget line for “customer support software.”</p>

    <p>collective.email is the small tool I wished existed each of those times. You claim one address for the collective. Everyone signs in with their own email — <b>there is no password to share</b>. Any member can pick up a conversation, and everyone can see it's being handled. The internal discussion (“who knows this person?”, “can you take it?”) happens right next to the email, invisible to the sender. The inbox belongs to the collective, not to whoever created it.</p>

    <p>Two principles behind it:</p>
    <ul>
      <li><b>No ads, no investors.</b> Tools for communities should be sustained by the communities they serve. You get a free month to try it, then it's {s}10 a month — and referring other collectives earns you credits, one credit being one month of service.</li>
      <li><b>Built with its users.</b> This started as the shared inbox for the Commons Hub in Brussels and is shaped daily by the first collectives using it. If something's missing, <a href="mailto:hello@collective.email">tell us</a> — that address is, of course, a shared inbox.</li>
    </ul>

    <p class="about-sig">— Xavier Damman<br />(previously co-founder of <a href="https://opencollective.com" target="_blank" rel="noopener">Open Collective</a>, where collectives share their money the way they share their inbox here)</p>
  </MarketingPage>
  )
}
