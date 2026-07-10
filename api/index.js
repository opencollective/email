// Vercel serverless entry. `npm run build` (vercel.json buildCommand) compiles
// src/ → dist/ first; this adapts Vercel's Node request/response to the Hono app.
import { app } from '../dist/app.js'

// Keep request bodies raw (required for webhook signature verification and
// multipart uploads). If the platform ignores this and pre-parses the body,
// the handler below reconstructs it.
export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body !== undefined) {
      // body parser ran anyway: rebuild the raw bytes as faithfully as possible
      const ct = String(req.headers['content-type'] || '')
      if (Buffer.isBuffer(req.body)) body = req.body
      else if (typeof req.body === 'string') body = Buffer.from(req.body)
      else if (ct.includes('application/x-www-form-urlencoded')) body = Buffer.from(new URLSearchParams(req.body).toString())
      else body = Buffer.from(JSON.stringify(req.body))
    } else {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = chunks.length ? Buffer.concat(chunks) : undefined
    }
  }

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '))
    else if (typeof v === 'string') headers.set(k, v)
  }

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body })

  const response = await app.fetch(request)

  res.statusCode = response.status
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') res.setHeader(k, v)
  })
  if (cookies.length) res.setHeader('set-cookie', cookies)
  res.end(Buffer.from(await response.arrayBuffer()))
}
