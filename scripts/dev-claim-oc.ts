/** Dev-only: serve the app with a fake Open Collective, so the claim flow's
 *  contactable / uncontactable branches can be seen without a real OC token.
 *  `npx tsx scripts/dev-claim-oc.ts`, then open
 *  /claim?address=commonshub (contactable) or ?address=madeleine (not). */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cfg } from '../src/config.js'
import { app } from '../src/app.js'
import { __setOcFetcher } from '../src/oc.js'
cfg.ocToken = 'dev-token'
const ACCOUNTS: Record<string, { name: string; contactForm: string; admins: string[]; description: string }> = {
  madeleine: { name: 'Madeleine', contactForm: 'UNSUPPORTED', admins: ['Ana'], description: 'We do good things.' },
  commonshub: { name: 'Commons Hub Brussels', contactForm: 'ACTIVE', admins: ['Xavier Damman', 'Leen Schelfhout'], description: 'A place.' },
}
__setOcFetcher((async (_u: string, init: any) => {
  const { query, variables } = JSON.parse(init.body)
  const slug = variables.account?.slug || variables.slug
  const acc = ACCOUNTS[slug]
  const j = (o: unknown) => ({ json: async () => o }) as Response
  if (!acc) return j({ errors: [{ message: 'Account Not Found', extensions: { code: 'NotFound' } }] })
  if (query.includes('sendMessage')) return j({ data: { sendMessage: { success: true } } })
  if (query.includes('description')) return j({ data: { account: { description: acc.description, longDescription: '' } } })
  return j({ data: { account: { name: acc.name, features: { CONTACT_FORM: acc.contactForm }, members: { nodes: acc.admins.map((name) => ({ account: { name, slug: name.toLowerCase() } })) } } } })
}) as unknown as typeof fetch)
app.use('/static/*', serveStatic({ root: './public' }))
serve({ fetch: app.fetch, port: 3113 }, (i) => console.log('listening', i.port))
