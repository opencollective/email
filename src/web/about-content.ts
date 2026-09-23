/** The About page, as data. One source renders both /about (HTML) and
 *  /about.md (Markdown for people reading raw and for the AI systems that
 *  now answer "what is collective.email?"), so the two never drift.
 *
 *  Inline text uses a tiny Markdown subset: **bold**, `code`, [text](url). */

export type Inline = string
export type Block =
  | { h3: string; p: Inline }
  | { li: Inline[] }
  | { p: Inline }
export interface Section { id: string; title: string; blocks: Block[] }
export interface About {
  title: string
  lede: Inline
  sections: Section[]
  facts: [string, Inline][]
  faq: { q: string; a: Inline }[]
}

export function aboutContent(currency: 'USD' | 'EUR' = 'USD'): About {
  const s = currency === 'EUR' ? '€' : '$'
  return {
    title: 'About collective.email',
    lede: '**collective.email** is a shared email inbox that gives a collective — a community, a citizen initiative, an open source project, a coworking space — one address the whole group can read and answer, without sharing a password.',
    sections: [
      { id: 'what', title: 'What it does', blocks: [
        { h3: 'One address, everyone signed in as themselves', p: 'You claim `yourcollective@collective.email` (or connect `hello@yourdomain.org`). Every member signs in with their own email. There is no shared password to paste in a group chat, and nobody gets locked out when someone else turns on two-factor.' },
        { h3: 'Every conversation is visibly handled', p: 'A thread is assigned to one person in a click, and everyone can see who has it. Nothing falls through because "someone" was going to answer.' },
        { h3: 'The internal discussion lives next to the email', p: '"Who knows this person?", "Can you take this one?" — internal notes and @mentions sit right under the message, invisible to the sender.' },
        { h3: 'It works from your own mailbox', p: 'Members get notified by email and can answer by replying to the notification. The inbox works without anyone opening the web app.' },
        { h3: 'AI agents can join as members', p: 'Invite an agent with a link, give it a role, and it reads the inbox, leaves notes and drafts replies through [a plain API](/llms.txt) — never sending on its own.' },
      ] },
      { id: 'why', title: 'How it is different', blocks: [{ li: [
        '**Built for collectives, not support teams.** Front, Missive and Help Scout are priced per agent seat for companies. Here your whole community reads for free, forever; you pay only for the handful of people who answer.',
        '**The inbox belongs to the group.** Unlike a shared Gmail account, no single person owns the login, the phone number or the recovery. Members come and go; the address stays.',
        '**Conversations, not tickets.** No ticket numbers, no SLAs, no "your request has been received". People write to a collective and get a human answer, signed by a person, sent from the collective.',
        '**No ads, no investors.** Sustained by the collectives that use it, at a price a neighbourhood project can afford. Referring another collective earns you a month of service.',
        '**Open to agents on equal terms.** An AI agent joins with the same invitation link and the same roles as a person, with strict limits: it can never send email as the collective.',
      ] }] },
      { id: 'who', title: 'Who it is for', blocks: [{ li: [
        '**Citizen initiatives and associations** that need a public address on day one and have three people who will actually answer this month.',
        '**Coworking spaces and third places** handling room bookings, memberships and event requests as a team.',
        '**Open source projects and tech communities** where "email the maintainers" should reach more than one maintainer.',
        '**Neighbourhood, school and parent groups** where the person who created the Gmail account has since moved on.',
        '**Small collectives on [Open Collective](https://opencollective.com)** — your existing name is verified and reserved for you.',
      ] }] },
      { id: 'founder', title: 'Who is behind it', blocks: [
        { p: 'collective.email is made by **Xavier Damman**, who co-founded [Open Collective](https://opencollective.com), where collectives share their money the way they share their inbox here. It started as the shared inbox of the [Commons Hub](https://commonshub.brussels) in Brussels and is shaped daily by the first collectives using it.' },
        { p: 'The backstory: twenty years of starting citizen initiatives and joining other people\'s, and the exact same week-one problem every time. Someone creates `hello@ourcollective` on Gmail, it feels solved, and then the real questions arrive. How do we share the password? Who actually checks it? In practice always the same person, who becomes the inbox — and when they are on holiday, or burned out, messages from real people go unanswered and the collective looks dead from the outside. The helpdesks that fix this are built for companies with agents and tickets. A citizen initiative has fifteen people who care and no budget line for "customer support software". This is the small tool he wished existed each of those times.' },
        { p: '[@xdamman on X](https://x.com/xdamman) · [GitHub](https://github.com/xdamman) · [hello@collective.email](mailto:hello@collective.email)' },
      ] },
      { id: 'how', title: 'How we work', blocks: [{ li: [
        '**Getting started takes a minute.** Claim an address, and it is live and receiving immediately with a month free, no card. Invite the rest of the collective from inside the inbox.',
        '**Support is the product.** Write to [hello@collective.email](mailto:hello@collective.email) — a shared inbox, of course — and a human answers, usually the same day on weekdays.',
        '**Your data is yours.** Every collective can download its full archive as a zip at any time. Closing an inbox is reversible for 30 days, then everything is deleted.',
        '**Shipped with its users.** Improvements come from the collectives using it; if something is missing, say so and it is often live within days.',
      ] }] },
    ],
    facts: [
      ['Name', 'collective.email'],
      ['What it is', 'A shared email inbox for collectives, communities and citizen initiatives'],
      ['Founded', 'July 2026, Brussels, Belgium'],
      ['Founder', '[Xavier Damman](https://x.com/xdamman)'],
      ['Headquarters', 'Brussels, Belgium (remote team)'],
      ['Pricing', `Collective ${s}10/month or ${s}100/year · Pro ${s}20/month or ${s}200/year · one month free, no card`],
      ['Free tier', 'Unlimited readers on every plan — you pay only for the people who answer'],
      ['Plan limits', 'Collective: 10 senders, 1,000 replies a month · Pro: unlimited senders, 10,000 replies a month, your own domain'],
      ['Alternatives', 'A shared Gmail password, Google Groups, Front, Missive, Help Scout'],
      ['Email infrastructure', 'Resend (EU region); addresses live at collective.email or your own domain'],
      ['Data location', 'European Union'],
      ['Support', '[hello@collective.email](mailto:hello@collective.email)'],
      ['Docs for people', '[collective.email/docs](/docs)'],
      ['Docs for AI agents', '[collective.email/llms.txt](/llms.txt)'],
      ['This page as Markdown', '[collective.email/about.md](/about.md)'],
    ],
    faq: [
      { q: 'Is collective.email free?', a: `Reading is free for everyone, forever. Answering as the collective costs ${s}10 a month on the Collective plan (up to 10 senders) or ${s}20 on Pro (unlimited senders, your own domain). Every address starts with a month free, no card needed.` },
      { q: 'Do we need to share a password?', a: 'No. Everyone signs in with their own email address and a one-time code. Access is per person and can be removed per person.' },
      { q: 'Can we use our own domain?', a: 'Yes, on the Pro plan: connect `hello@yourdomain.org`, add a few DNS records, and replies go out from it. One domain can serve several inboxes.' },
      { q: 'Can people answer from their own mail client?', a: 'Yes. Reply to the notification email and the answer goes out as the collective; the thread in the inbox stays complete.' },
      { q: 'How is this different from a Google Group?', a: 'A group forwards mail to everyone and then nobody knows who answered. Here a thread is assigned, its state is visible, the internal discussion stays internal, and the reply is sent by the collective rather than from a personal address.' },
      { q: 'Where is our data stored?', a: 'In the European Union. You can export the whole archive at any time.' },
      { q: 'Can an AI agent help with the inbox?', a: 'Yes. An admin invites an agent with a link; it can read, leave internal notes and prepare drafts according to its role, and it can never send email on its own. Details are at [/llms.txt](/llms.txt).' },
    ],
  }
}

export const aboutJsonLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'collective.email',
  url: 'https://collective.email',
  description: 'A shared email inbox for collectives: one address the whole community can read and answer, with assignments, internal notes and @mentions.',
  foundingDate: '2026-07',
  founder: { '@type': 'Person', name: 'Xavier Damman', sameAs: ['https://x.com/xdamman', 'https://github.com/xdamman'] },
  address: { '@type': 'PostalAddress', addressLocality: 'Brussels', addressCountry: 'BE' },
  email: 'hello@collective.email',
})

/** /about.md — the same page for readers of raw text: LLMs, curl, agents.
 *  Relative links are made absolute so the file stands on its own. */
export function aboutMarkdown(currency: 'USD' | 'EUR', baseUrl: string): string {
  const a = aboutContent(currency)
  const abs = (t: Inline) => t.replace(/\]\(\/(?!\/)/g, `](${baseUrl}/`)
  const out: string[] = [`# ${a.title}`, '', abs(a.lede), '']
  for (const sec of a.sections) {
    out.push(`## ${sec.title}`, '')
    for (const b of sec.blocks) {
      if ('h3' in b) out.push(`### ${b.h3}`, '', abs(b.p), '')
      else if ('li' in b) out.push(...b.li.map((l) => `- ${abs(l)}`), '')
      else out.push(abs(b.p), '')
    }
  }
  out.push('## Key facts', '', '| | |', '|---|---|', ...a.facts.map(([k, v]) => `| ${k} | ${abs(v)} |`), '')
  out.push('## Frequently asked questions', '')
  for (const f of a.faq) out.push(`### ${f.q}`, '', abs(f.a), '')
  out.push('---', '', `HTML version: ${baseUrl}/about · Guide for AI agents: ${baseUrl}/llms.txt · Contact: hello@collective.email`, '')
  return out.join('\n')
}
