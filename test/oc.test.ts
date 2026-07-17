import './setup.js'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { cfg } from '../src/config.js'
import { get } from '../src/db.js'
import { __setOcFetcher } from '../src/oc.js'
import { ocVerifyToken } from '../src/claim.js'

let seq = 0
const uniq = () => `oc${Date.now() % 100000}${++seq}`

// Fake Open Collective: routes queries/mutations by shape.
type OcFake = {
  accounts: Record<string, { name: string; contactForm: string; admins: string[]; description?: string }>
  sent: { slug: string; message: string }[]
}
let fake: OcFake
function installFake() {
  fake = { accounts: {}, sent: [] }
  __setOcFetcher((async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body)
    const slug = variables.account?.slug || variables.slug
    const acc = fake.accounts[slug]
    if (query.includes('sendMessage')) {
      if (!acc) return jsonRes({ errors: [{ message: 'Account Not Found', extensions: { code: 'NotFound' } }] })
      if (acc.contactForm !== 'ACTIVE') return jsonRes({ errors: [{ message: "You can't contact this account", extensions: { code: 'Unauthorized' } }] })
      fake.sent.push({ slug, message: variables.message })
      return jsonRes({ data: { sendMessage: { success: true } } })
    }
    if (!acc) return jsonRes({ errors: [{ message: 'Account Not Found', extensions: { code: 'NotFound' } }] })
    if (query.includes('description')) return jsonRes({ data: { account: { description: acc.description || '', longDescription: '' } } })
    return jsonRes({ data: { account: { name: acc.name, features: { CONTACT_FORM: acc.contactForm }, members: { nodes: acc.admins.map((name) => ({ account: { name, slug: name.toLowerCase() } })) } } } })
  }) as unknown as typeof fetch)
}
const jsonRes = (obj: unknown) => ({ json: async () => obj }) as Response

beforeEach(() => { cfg.ocToken = 'test-token'; installFake() })
afterEach(() => { cfg.ocToken = '' })

const claim = (path: string, body: Record<string, string>) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
})

test('live check: none / contactable / uncontactable', async () => {
  const s1 = uniq()
  let r = await (await app.request(`/claim/oc?slug=${s1}`)).json() as any
  assert.equal(r.oc.kind, 'none')

  const s2 = uniq()
  fake.accounts[s2] = { name: 'Active Co', contactForm: 'ACTIVE', admins: ['Xavier Damman', 'Leen'] }
  r = await (await app.request(`/claim/oc?slug=${s2}`)).json() as any
  assert.equal(r.oc.kind, 'contactable')
  assert.deepEqual(r.oc.admins, ['Xavier Damman', 'Leen'])

  const s3 = uniq()
  fake.accounts[s3] = { name: 'Inactive Co', contactForm: 'UNSUPPORTED', admins: ['Xavier'] }
  r = await (await app.request(`/claim/oc?slug=${s3}`)).json() as any
  assert.equal(r.oc.kind, 'uncontactable')
  assert.equal(r.oc.token, ocVerifyToken(s3))
})

test('claiming a contactable collective sends the code via OC, not to the personal email', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Commons Hub', contactForm: 'ACTIVE', admins: ['Xavier'] }
  const mail = `${slug}@personal.test`
  const res = await claim('/claim', { address: slug, name: 'X', email: mail })
  const html = await res.text()
  assert.match(html, /we sent a 6-digit code to its admins/i)
  assert.equal(fake.sent.length, 1, 'code delivered through the OC contact form')
  assert.match(fake.sent[0].message, /\b\d{6}\b/, 'the message carries a 6-digit code')
  // the code is stored under the personal email (login identity)
  const row = await get<any>('SELECT claim_slug FROM login_codes WHERE email = ?', [mail])
  assert.equal(row.claim_slug, slug)
})

test('an uncontactable collective cannot be claimed until the description token is present', async () => {
  const slug = uniq()
  const mail = `${slug}@personal.test`
  fake.accounts[slug] = { name: 'Quiet Co', contactForm: 'UNSUPPORTED', admins: ['Xavier'], description: 'We do good things.' }

  // plain submit → no code, form comes back asking for the description proof
  let res = await claim('/claim', { address: slug, name: 'X', email: mail })
  let html = await res.text()
  assert.match(html, /add this line/i)
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined, 'no code issued')

  // verify before adding the token → still refused
  res = await claim('/claim/oc-verify', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /find that line/i)
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined)

  // add the token to the description → verify passes, code goes to the personal email
  fake.accounts[slug].description = `We do good things. collective.email:${ocVerifyToken(slug)}`
  res = await claim('/claim/oc-verify', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /check your inbox/i)
  const row = await get<any>('SELECT claim_slug FROM login_codes WHERE email = ?', [mail])
  assert.equal(row.claim_slug, slug)
  assert.equal(fake.sent.length, 0, 'no OC message for the description path')
})

test('a collective with no OC presence claims normally to the personal email', async () => {
  const slug = uniq()
  const mail = `${slug}@personal.test`
  const res = await claim('/claim', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), new RegExp('we sent a 6-digit code to <b>' + mail, 'i'))
  assert.equal(fake.sent.length, 0)
})
