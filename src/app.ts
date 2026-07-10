import { warnMissingConfig } from './config.js'
import { app } from './web/routes.js'
import { webhooks } from './webhook.js'

warnMissingConfig()
app.route('/', webhooks)

/** The complete Hono app — served by @hono/node-server locally/Docker,
 *  and by api/index.js as a Vercel function. */
export { app }
