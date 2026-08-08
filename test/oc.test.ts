import './setup.js'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'
import { cfg } from '../src/config.js'
import { get } from '../src/db.js'
import { __setOcFetcher } from '../src/oc.js'

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
  assert.equal(r.oc.token, undefined, 'no random token — the proof is the public address in the description')
})

/** Which step a rendered page is: the heading gives it away. */
const stepOf = (html: string) => /Who&#39;s the first admin\?|Who's the first admin\?/.test(html) ? 2
  : /Claim your address/.test(html) ? 1 : 0

test('a name taken on Open Collective stays on step 1, never reaching "first admin"', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Commons Hub', contactForm: 'ACTIVE', admins: ['Xavier'] }
  const html = await (await app.request(`/claim?address=${slug}`)).text()
  assert.equal(stepOf(html), 1, 'still claiming the address')
  assert.match(html, /already claimed on Open Collective/i)
  assert.match(html, /one of its admins, we can send a confirmation code/i)
  assert.match(html, /Type another name to claim a different address/i)
  assert.equal(fake.sent.length, 0)
})

test('an uncontactable name also stays on step 1 until the description proves it', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Quiet Co', contactForm: 'UNSUPPORTED', admins: ['Ana'], description: 'We do good things.' }
  let html = await (await app.request(`/claim?address=${slug}`)).text()
  assert.equal(stepOf(html), 1)
  assert.match(html, /advertise it there anyway|add <code>/i)

  // verifying too early keeps you on step 1
  let res = await claim('/claim/oc-verify', { address: slug })
  html = await res.text()
  assert.equal(stepOf(html), 1)
  assert.match(html, /find that line/i)

  // once the description advertises the address, step 2 opens
  fake.accounts[slug].description = `We do good things. Reach us at ${slug}@collective.email!`
  res = await claim('/claim/oc-verify', { address: slug })
  assert.equal(res.status, 302)
  const next = res.headers.get('location')!
  assert.match(next, /[?&]p=/, 'carries a proof to step 2')
  html = await (await app.request(next)).text()
  assert.equal(stepOf(html), 2, 'now asking who the first admin is')
  assert.doesNotMatch(html, /advertise it there anyway/i, 'and not asking for the proof again')
})

test('claiming a contactable collective never messages its admins unasked', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Commons Hub', contactForm: 'ACTIVE', admins: ['Xavier'] }
  const mail = `${slug}@personal.test`

  // step 2 is only reachable by saying it's yours, and even then submitting it
  // just offers the option — a name typed by mistake never messages a stranger
  const html = await (await app.request(`/claim?address=${slug}&oc=admin`)).text()
  assert.equal(stepOf(html), 2)
  assert.match(html, /formaction="\/claim\/oc-send"/, 'sending is its own explicit action')

  const res = await claim('/claim', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /already claimed on Open Collective|claimed on Open Collective/i)
  assert.equal(fake.sent.length, 0, 'nothing sent to Open Collective')
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined, 'no code issued')
})

test('a step-1 proof cannot be reused for a different address', async () => {
  const mine = uniq(), theirs = uniq()
  fake.accounts[mine] = { name: 'Mine', contactForm: 'UNSUPPORTED', admins: ['Ana'], description: `Reach us at ${mine}@collective.email` }
  fake.accounts[theirs] = { name: 'Theirs', contactForm: 'UNSUPPORTED', admins: ['Bo'], description: 'Nothing here.' }
  const proof = new URL((await claim('/claim/oc-verify', { address: mine })).headers.get('location')!, 'http://x').searchParams.get('p')!

  const html = await (await app.request(`/claim?address=${theirs}&p=${encodeURIComponent(proof)}`)).text()
  assert.equal(stepOf(html), 1, 'someone else\'s proof unlocks nothing')

  const mail = `${theirs}@personal.test`
  await claim('/claim', { address: theirs, name: 'X', email: mail, proof })
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined, 'and issues no code')
})

test('the explicit "send to its admins" button delivers the code through OC', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Commons Hub', contactForm: 'ACTIVE', admins: ['Xavier'] }
  const mail = `${slug}@personal.test`
  const res = await claim('/claim/oc-send', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /we sent a 6-digit code to its admins/i)
  assert.equal(fake.sent.length, 1, 'code delivered through the OC contact form')
  assert.match(fake.sent[0].message, /\b\d{6}\b/, 'the message carries a 6-digit code')
  // the code is stored under the personal email (login identity)
  const row = await get<any>('SELECT claim_slug FROM login_codes WHERE email = ?', [mail])
  assert.equal(row.claim_slug, slug)
})

test('oc-send re-checks and will not message a collective that stopped being contactable', async () => {
  const slug = uniq()
  fake.accounts[slug] = { name: 'Quiet Co', contactForm: 'UNSUPPORTED', admins: ['Xavier'] }
  const mail = `${slug}@personal.test`
  const res = await claim('/claim/oc-send', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /advertise it there anyway/i, 'falls back to the description proof')
  assert.equal(fake.sent.length, 0)
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined)
})

test('an uncontactable collective cannot be claimed until the description token is present', async () => {
  const slug = uniq()
  const mail = `${slug}@personal.test`
  fake.accounts[slug] = { name: 'Quiet Co', contactForm: 'UNSUPPORTED', admins: ['Xavier'], description: 'We do good things.' }

  // submitting step 2 without a proof → no code, bounced back to step 1
  let res = await claim('/claim', { address: slug, name: 'X', email: mail })
  assert.match(await res.text(), /advertise it there anyway|add <code>/i)
  assert.equal(await get<any>('SELECT id FROM login_codes WHERE email = ?', [mail]), undefined, 'no code issued')

  // add the address to the description → step 1 passes and hands over a proof
  fake.accounts[slug].description = `We do good things. Reach us at ${slug}@collective.email!`
  res = await claim('/claim/oc-verify', { address: slug })
  const proof = new URL(res.headers.get('location')!, 'http://x').searchParams.get('p')!

  // now the ordinary claim goes through, to the personal email
  res = await claim('/claim', { address: slug, name: 'X', email: mail, proof })
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
