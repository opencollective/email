// Vercel entry for the image-rendering routes (/aimg/*, /og/*). Kept as its
// own function so satori/resvg (WASM + native binary + inlined fonts) never
// weighs down the main inbox function's cold start.
import { ogApp } from '../dist/og.js'

export default async function handler(req, res) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '))
    else if (typeof v === 'string') headers.set(k, v)
  }
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  const response = await ogApp.fetch(new Request(`${proto}://${host}${req.url}`, { method: req.method, headers }))
  res.statusCode = response.status
  response.headers.forEach((v, k) => res.setHeader(k, v))
  res.end(Buffer.from(await response.arrayBuffer()))
}
