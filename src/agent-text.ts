import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element } from 'domhandler'
import { htmlToText } from './util.js'

/** What an agent reads of an email is what a human reader sees — nothing
 *  more. Prompt injection hides instructions where people don't look but
 *  models do: HTML comments, text styled invisible, encoded payloads,
 *  invisible characters, or a text/plain part that says something other than
 *  the HTML everyone reads. Each is cut here, and what was cut is reported:
 *  hidden content in an email is itself a signal worth a note. */

export type Removed = 'comments' | 'hidden_html' | 'invisible_chars' | 'encoded_text'

// ---------- colours, just enough to tell "can't be read" ----------

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], snow: [255, 250, 250], ivory: [255, 255, 240],
  whitesmoke: [245, 245, 245], ghostwhite: [248, 248, 255], azure: [240, 255, 255], mintcream: [245, 255, 250],
  floralwhite: [255, 250, 240], seashell: [255, 245, 238], linen: [250, 240, 230], aliceblue: [240, 248, 255],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], gainsboro: [220, 220, 220], silver: [192, 192, 192],
  gray: [128, 128, 128], grey: [128, 128, 128], red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0],
  yellow: [255, 255, 0], navy: [0, 0, 128],
}

/** rgb, or 'clear' for a fully transparent colour, or null when unknown. */
function parseColor(v: string): [number, number, number] | 'clear' | null {
  const s = v.trim().toLowerCase().replace(/\s*!important$/, '')
  if (s === 'transparent') return 'clear'
  if (NAMED[s]) return NAMED[s]
  let m = s.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    const h = m[1]
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === '0') return 'clear'
      return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as [number, number, number]
    }
    if (h.length === 6 || h.length === 8) {
      if (h.length === 8 && parseInt(h.slice(6), 16) < 26) return 'clear'
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
    }
    return null
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
  if (m) {
    if (m[4] !== undefined) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      if (a < 0.1) return 'clear'
    }
    return [+m[1], +m[2], +m[3]]
  }
  return null
}

const lum = ([r, g, b]: [number, number, number]) => {
  const ch = (x: number) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// ---------- hidden elements ----------

const styleOf = (el: Element): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const decl of (el.attribs.style || '').split(';')) {
    const i = decl.indexOf(':')
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim().toLowerCase()
  }
  return out
}

/** A length that renders nothing: 0, 0px, 0.5px, 0em… */
const tiny = (v: string | undefined, max = 1) => {
  if (!v) return false
  const m = v.match(/^(-?[\d.]+)\s*(px|pt|em|rem|%)?/)
  if (!m) return false
  const n = parseFloat(m[1])
  const px = m[2] === 'em' || m[2] === 'rem' ? n * 16 : m[2] === 'pt' ? n * 4 / 3 : m[2] === '%' ? n * 0.16 : n
  return px <= max
}

interface Paint {
  fg: [number, number, number] | 'clear' | null // null: the client's default
  bg: [number, number, number]
  small: boolean // font-size too small to read — children may set it back
  shown: boolean // visibility — children may set it back too
}

/** Styled so neither it nor anything inside it can be seen. Font size,
 *  colour and visibility are inherited and can be reset by a child, so they
 *  live in Paint instead: layout tricks set font-size:0 on a wrapper and the
 *  real size on what it holds. */
function goneWithChildren(el: Element, st: Record<string, string>): boolean {
  if ('hidden' in el.attribs) return true
  if (/^none\b/.test(st.display || '')) return true
  if (st.opacity !== undefined && parseFloat(st.opacity) < 0.1) return true
  const clipped = /hidden|clip/.test(st.overflow || '')
  if (clipped && (tiny(st.height) || tiny(st['max-height']) || tiny(st.width) || tiny(st['max-width']))) return true
  // pushed far off the frame
  for (const k of ['margin', 'margin-left', 'margin-top']) {
    const m = (st[k] || '').match(/-(\d+)/)
    if (m && +m[1] >= 500) return true
  }
  return false
}

function nextPaint(el: Element, st: Record<string, string>, paint: Paint): Paint {
  const p = { ...paint }
  const bgv = st['background-color'] || (st.background && st.background.split(/\s+/)[0]) || el.attribs.bgcolor
  if (bgv) { const c = parseColor(bgv); if (c && c !== 'clear') p.bg = c }
  if (st.color) { const c = parseColor(st.color); if (c) p.fg = c }
  if (st['font-size']) p.small = tiny(st['font-size'], 2)
  if (st.visibility) p.shown = !/^(hidden|collapse)\b/.test(st.visibility)
  return p
}

const textHidden = (p: Paint) => !p.shown || p.small || p.fg === 'clear'
  // text the same colour as what's behind it
  || (p.fg !== null && contrast(p.fg, p.bg) < 1.4)

/** Walk the document in reading order: what a reader sees goes to `out` as
 *  bare HTML for htmlToText; what they can't see is collected with `at`, how
 *  much visible text came before it — a preview line sits near the top. */
interface Walk { out: string[]; hidden: { text: string; at: number }[]; seen: number }

const TOP = 300

function walk(nodes: ChildNode[], paint: Paint, w: Walk) {
  for (const n of nodes) {
    if (n.type === 'text') {
      if (!n.data.trim()) { w.out.push(' '); continue }
      if (textHidden(paint)) { w.hidden.push({ text: n.data, at: w.seen }); continue }
      w.seen += n.data.trim().length
      w.out.push(n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      continue
    }
    if (n.type !== 'tag') continue // comments, scripts, styles, directives
    const el = n as Element
    if (el.name === 'head' || el.name === 'title') continue
    const st = styleOf(el)
    if (goneWithChildren(el, st)) {
      const text = textOf(el)
      if (text.trim()) w.hidden.push({ text, at: w.seen })
      continue
    }
    w.out.push(`<${el.name}>`)
    const before = w.out.length
    walk(el.children, nextPaint(el, st, paint), w)
    // a link keeps where it goes, as the text/plain part would have it
    const href = el.name === 'a' ? el.attribs.href || '' : ''
    if (/^(https?|mailto):/i.test(href) && w.out.length > before) {
      const label = w.out.slice(before).join('')
      const bare = href.replace(/^mailto:/i, '')
      if (!label.includes(bare)) w.out.push(` (${bare.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')})`)
    }
    w.out.push(`</${el.name}>`)
  }
}

const textOf = (n: ChildNode): string =>
  n.type === 'text' ? n.data : 'children' in n ? (n.children as ChildNode[]).map(textOf).join('') : ''

/** Hidden text worth telling the agent about. Mail hides text for ordinary
 *  reasons — the inbox preview line at the top, a copy of the message for
 *  the preview pane — so a chunk only counts when it says something the
 *  visible mail doesn't. */
function suspiciousHidden(hidden: Walk['hidden'], visible: string): boolean {
  const words = (s: string) => s.toLowerCase().normalize('NFKC').replace(INVISIBLE, '').match(/\p{L}{2,}/gu) || []
  const seen = new Set(words(visible))
  // hidden pieces with nothing visible between them are one chunk, judged whole
  const chunks: { text: string; at: number }[] = []
  for (const h of hidden) {
    const last = chunks[chunks.length - 1]
    if (last && last.at === h.at) last.text += ' ' + h.text
    else chunks.push({ ...h })
  }
  const preview = chunks.findIndex((x) => words(x.text).length > 0)
  return chunks.some((c, i) => {
    // one preview line near the top is what every newsletter has
    if (i === preview && c.at < TOP) return false
    const ws = words(c.text)
    if (ws.length < 8) return false // tracking crumbs, a stray label
    const novel = ws.filter((x) => !seen.has(x)).length
    return novel / ws.length > 0.3
  })
}

// ---------- text-level cleaning ----------

// zero-width and formatting characters, bidi controls, invisible fillers,
// variation selectors and Unicode tag characters (the "ASCII smuggling" block)
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDDEF]/g
// ordinary mail is full of the above — spacers after a preview line, emoji
// variation selectors, joiners. What carries a smuggled message: tag
// characters, the supplementary selectors, runs of selectors, bidi overrides.
const SMUGGLING = /\uDB40[\uDC00-\uDDEF]|[\uFE00-\uFE0F]{2,}|[\u202A-\u202E\u2066-\u2069]/

const B64_TOKEN = /^[A-Za-z0-9+/_-]+={0,2}$/

/** A token that decodes to readable text is a message wrapped to slip past a
 *  human — real IDs and hashes decode to noise and are kept. */
function hiddenText(token: string): boolean {
  if (token.length < 16 || !B64_TOKEN.test(token)) return false
  if (!/[A-Za-z]/.test(token) || !/[0-9+/=_-]|[a-z][A-Z]|[A-Z][a-z]/.test(token)) return false
  let bytes: Buffer
  try { bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64') } catch { return false }
  if (bytes.length < 10) return false
  const s = bytes.toString('utf8')
  const printable = s.replace(/[^\x20-\x7E\n\r\t\u00A0-\uFFFF]/g, '').length
  const letters = s.replace(/[^a-zA-Z]/g, '').length
  return printable / s.length > 0.95 && letters / s.length > 0.5
}

export function cleanText(input: string, removed: Set<Removed>): string {
  let s = input
  if (/<!--/.test(s)) {
    const t = s.replace(/<!--[\s\S]*?(-->|$)/g, '')
    if (t !== s) { removed.add('comments'); s = t }
  }
  if (SMUGGLING.test(s)) removed.add('invisible_chars')
  s = s.replace(INVISIBLE, '')
  s = s.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=\s]{16,}/g, () => { removed.add('encoded_text'); return '[encoded data removed]' })
  s = s.replace(/[^\s<>"'()[\]]+/g, (tok) => {
    if (tok.includes('://') || tok.includes('@')) return tok
    const core = tok.replace(/[.,;:!?]+$/, '')
    if (core.length >= 200 && B64_TOKEN.test(core)) { removed.add('encoded_text'); return '[encoded data removed]' }
    if (hiddenText(core)) { removed.add('encoded_text'); return '[encoded text removed]' }
    return tok
  })
  return s
}

/** The body an agent may read, and what was cut from it. With an HTML part,
 *  that is the HTML — what members read in the app — never a text/plain part
 *  that nobody sees. */
export function agentBody(m: { body_text: string | null; body_html?: string | null }): { text: string; removed: Removed[] } {
  const removed = new Set<Removed>()
  let text = m.body_text || ''
  if (m.body_html) {
    const doc = parseDocument(m.body_html, { decodeEntities: true })
    const w: Walk = { out: [], hidden: [], seen: 0 }
    walk(doc.children, { fg: null, bg: [255, 255, 255], small: false, shown: true }, w)
    const fromHtml = htmlToText(w.out.join(''))
    if (suspiciousHidden(w.hidden, fromHtml)) removed.add('hidden_html')
    if (fromHtml.trim()) text = fromHtml
  }
  return { text: cleanText(text, removed), removed: [...removed] }
}
