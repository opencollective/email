import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cfg } from './config.js'
import { digestTick } from './notify.js'
import { app } from './app.js'

// Local/Docker entry point. On Vercel, api/index.js serves the app instead
// (static files come from public/, digests from the cron hitting /cron/digest).
app.use('/static/*', serveStatic({ root: './public' }))

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[web] collective.email listening on :${info.port} (${cfg.baseUrl}, addresses @${cfg.emailDomain})`)
})

setInterval(() => digestTick().catch((err) => console.error('[digest] tick failed:', err)), 10 * 60 * 1000)
digestTick().catch(() => {})
