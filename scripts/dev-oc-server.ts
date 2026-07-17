/** Dev-only server with a stubbed Open Collective for screenshotting the claim flow. */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cfg } from '../src/config.js'
import { app } from '../src/app.js'
import { __setOcFetcher } from '../src/oc.js'

;(cfg as unknown as { ocToken: string }).ocToken = 'dev'
const ACCOUNTS: Record<string, { name: string; CONTACT_FORM: string; admins: string[] }> = {
  commonshubbrussels: { name: 'Commons Hub Brussels', CONTACT_FORM: 'ACTIVE', admins: ['Xavier Damman', 'Leen Schelfhout', 'Jana'] },
  quietcollective: { name: 'Quiet Collective', CONTACT_FORM: 'UNSUPPORTED', admins: ['Xavier'] },
}
__setOcFetcher((async (_u: string, init: { body: string }) => {
  const { variables } = JSON.parse(init.body)
  const a = ACCOUNTS[variables.slug || variables.account?.slug]
  const json = a
    ? { data: { account: { name: a.name, features: { CONTACT_FORM: a.CONTACT_FORM }, members: { nodes: a.admins.map((n) => ({ account: { name: n } })) }, description: '', longDescription: '' } } }
    : { errors: [{ message: 'Account Not Found', extensions: { code: 'NotFound' } }] }
  return { json: async () => json } as Response
}) as unknown as typeof fetch)

app.use('/static/*', serveStatic({ root: './public' }))
serve({ fetch: app.fetch, port: cfg.port }, (i) => console.log('dev-oc on', i.port))
