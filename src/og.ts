import { Hono } from 'hono'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { get, getMember, getThread, type Member, type Message, type Thread } from './db.js'
import { relTime, verifyToken } from './util.js'
import { INTER_REGULAR, INTER_SEMIBOLD } from './og-fonts.js'

/** PNG rendering (satori → resvg, the same engine behind @vercel/og and
 *  Next.js ImageResponse) for things that must be images:
 *  - /aimg/:token — the live assignment badge embedded in notification
 *    emails, rendered at OPEN time so it always shows the current state.
 *    PNG because Gmail's image proxy won't display SVG.
 *  - /og/:card — social preview cards for the marketing pages.
 *  Deployed as its OWN Vercel function (api/og.js) so the WASM/font init
 *  never slows down the inbox function. */

export const ogApp = new Hono()

type El = { type: string; props: Record<string, unknown> }
const h = (type: string, style: Record<string, unknown>, ...children: (El | string)[]): El =>
  ({ type, props: { style, children: children.length <= 1 ? children[0] : children } })

async function png(el: El, width: number, height: number): Promise<Buffer> {
  const svg = await satori(el as never, {
    width,
    height,
    fonts: [
      { name: 'Inter', data: INTER_REGULAR, weight: 400, style: 'normal' },
      { name: 'Inter', data: INTER_SEMIBOLD, weight: 600, style: 'normal' },
    ],
  })
  return new Resvg(svg).render().asPng() as Buffer
}

const memberName = (m?: Member | null) => (m ? m.name || m.email.split('@')[0] : '')

/** Current human-readable state of a thread — separated from rendering so it's unit-testable. */
export async function badgeState(thread: Thread): Promise<{ line: string; who: string; color: string; bg: string }> {
  if (thread.last_direction === 'outbound') {
    const lastOut = await get<Message>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1", [thread.id])
    const by = lastOut?.sent_by_member_id ? await getMember(lastOut.sent_by_member_id) : null
    const who = by ? memberName(by) : ''
    return {
      line: `✓ Answered${who ? ` by ${who}` : ''}${lastOut?.sent_at ? ` · ${relTime(lastOut.sent_at)}` : ''}`,
      who, color: '#1a7f4f', bg: '#eef8f2',
    }
  }
  if (thread.assignee_member_id) {
    const assignee = await getMember(thread.assignee_member_id)
    const lastAssign = await get<{ created_at: number }>("SELECT created_at FROM events WHERE thread_id = ? AND type = 'assigned' ORDER BY id DESC LIMIT 1", [thread.id])
    const who = memberName(assignee)
    return {
      line: `Assigned to ${who}${lastAssign ? ` · ${relTime(lastAssign.created_at)}` : ''}`,
      who, color: '#0c2d66', bg: '#eef3fc',
    }
  }
  return { line: 'Nobody has this yet — first to claim it gets it', who: '', color: '#b45309', bg: '#fdf5ec' }
}

ogApp.get('/aimg/:token', async (c) => {
  const payload = verifyToken(c.req.param('token'))
  if (!payload || payload.a !== 'aimg') return c.notFound()
  const thread = await getThread(Number(payload.th))
  if (!thread) return c.notFound()
  const s = await badgeState(thread)
  const initials = s.who ? s.who.slice(0, 2).toUpperCase() : s.line.startsWith('✓') ? '✓' : '!'
  // 2x for retina; emails display it at 520×56
  const img = await png(
    h('div', { display: 'flex', width: '100%', height: '100%', alignItems: 'center', gap: 24, padding: '0 30px', backgroundColor: s.bg, border: `3px solid ${s.color}`, borderRadius: 26, fontFamily: 'Inter' },
      h('div', { display: 'flex', width: 62, height: 62, borderRadius: 31, backgroundColor: s.color, color: '#ffffff', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 600, flexShrink: 0 }, initials),
      h('div', { display: 'flex', fontSize: 31, fontWeight: 600, color: s.color }, s.line.replace(/^✓ /, ''))),
    1040, 112,
  )
  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate')
  return c.body(new Uint8Array(img))
})

// ---------- social preview cards ----------

const wordmark = h('div', { display: 'flex', fontSize: 34, fontWeight: 600 },
  h('span', { color: '#0c2d66' }, 'collective'),
  h('span', { color: '#1869f5' }, '.email'))

function card(title: string, subtitle: string, addr?: string): El {
  return h('div', { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#ffffff', padding: '64px 72px', fontFamily: 'Inter', justifyContent: 'space-between' },
    wordmark,
    h('div', { display: 'flex', flexDirection: 'column', gap: 26 },
      h('div', { display: 'flex', fontSize: title.length > 34 ? 58 : 68, fontWeight: 600, color: '#0c2d66', lineHeight: 1.1, letterSpacing: '-2px', maxWidth: 1000 }, title),
      ...(addr ? [h('div', { display: 'flex', alignSelf: 'flex-start', alignItems: 'center', border: '3px solid #e6e8eb', borderRadius: 100, padding: '16px 36px', fontSize: 38, fontWeight: 600, boxShadow: '0 10px 30px rgba(20,20,20,0.08)' },
        h('span', { color: '#141414' }, addr),
        h('span', { color: '#1869f5' }, '@collective.email'))] : []),
      h('div', { display: 'flex', fontSize: 28, color: '#4e5052', maxWidth: 950, lineHeight: 1.4 }, subtitle)))
}

const CARDS: Record<string, (slug?: string) => El> = {
  home: () => card('An email address for your collective.', 'Share the inbox, assign any conversation to any member, and talk about it internally — no shared passwords.', 'yourcollective'),
  claim: (slug) => card(slug ? 'This address is up for grabs.' : 'Claim your address.', 'One address outside, a whole collective inside. Claim it before someone else does.', slug || 'yourcollective'),
  faq: () => card('Frequently asked questions', 'How the shared inbox works, pricing, roles, your own domain, and what happens to your data.'),
  docs: () => card('Documentation', 'Everything you need to run your collective’s shared inbox. Five minutes of reading covers all of it.'),
  about: () => card('Every collective hits the same wall.', 'We need an email address — but how do we share the password? And who actually checks it?'),
}

ogApp.get('/og/:file', async (c) => {
  const kind = c.req.param('file').replace(/\.png$/, '')
  const make = CARDS[kind]
  if (!make) return c.notFound()
  const slugQ = (c.req.query('slug') || '').toLowerCase()
  const slug = /^[a-z0-9]{1,40}$/.test(slugQ) ? slugQ : undefined
  const img = await png(make(slug), 1200, 630)
  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  return c.body(new Uint8Array(img))
})
