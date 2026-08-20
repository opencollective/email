import { warnMissingConfig } from './config.js'
import { app } from './web/routes.js'
import { webhooks } from './webhook.js'
import { agentApp } from './web/agent-routes.js'

warnMissingConfig()
app.route('/', webhooks)
app.route('/', agentApp)

/** The complete Hono app — served by @hono/node-server locally/Docker,
 *  and by api/index.js as a Vercel function. */
export { app }
