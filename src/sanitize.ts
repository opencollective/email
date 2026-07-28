import sanitizeHtml from 'sanitize-html'

/** Email-safe HTML sanitization. Newsletters arrive as table-soup with inline
 *  styles — keep the layout, kill everything that can execute or phone home
 *  beyond ordinary images: no scripts, no event handlers, no <style> blocks,
 *  no iframes/objects/forms, no javascript: or cid: URLs, and only an
 *  allow-listed set of inline CSS properties (no url(...) values possible).
 *  Rendered inside a sandboxed iframe in the web UI (defense in depth) and
 *  inlined into notification emails (where clients apply their own rules). */

const STYLE_PROPS: Record<string, RegExp[]> = Object.fromEntries([
  'color', 'background-color', 'background', 'font', 'font-size', 'font-family', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'vertical-align',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'height', 'max-width', 'min-width', 'max-height', 'display', 'float', 'clear', 'white-space',
  'word-break', 'overflow-wrap', 'table-layout', 'list-style', 'opacity',
].map((p) => [p, [/^(?!.*(?:url|expression)\s*\()[^;{}]*$/i]])) // rgb()/calc() fine; url() and expression() are not

export function sanitizeEmailHtml(html: string): string {
  if (!html) return ''
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sub', 'sup', 'span', 'font', 'center',
      'p', 'div', 'br', 'hr', 'blockquote', 'pre', 'code',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
      'img', 'figure', 'figcaption', 'article', 'section', 'header', 'footer', 'main', 'nav', 'time', 'address', 'abbr',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'lang', 'title'],
      a: ['href', 'name', 'target', 'rel', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style', 'border'],
      table: ['cellpadding', 'cellspacing', 'border', 'style', 'width', 'align', 'bgcolor', 'role'],
      td: ['colspan', 'rowspan', 'style', 'width', 'height', 'align', 'valign', 'bgcolor'],
      th: ['colspan', 'rowspan', 'style', 'width', 'height', 'align', 'valign', 'bgcolor'],
      col: ['span', 'width'],
      time: ['datetime'],
    },
    allowedStyles: { '*': STYLE_PROPS },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      // every link opens in a new tab and never gets a referrer or opener
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
    },
  })
}

/** Wrap sanitized email HTML into a minimal document for the sandboxed
 *  iframe: readable defaults, images capped to the frame, links open outside. */
export function emailHtmlDocument(sanitized: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body { margin: 10px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #141414; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    a { color: #0c2d66; }
    table { max-width: 100%; }
  </style></head><body>${sanitized}</body></html>`
}
