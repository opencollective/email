import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../src/app.js'

test('marketing pages render with their key content', async () => {
  const faq = await app.request('/faq')
  assert.equal(faq.status, 200)
  const faqHtml = await faq.text()
  assert.match(faqHtml, /own domain/i)
  assert.match(faqHtml, /no free plan/i)

  const docs = await app.request('/docs')
  assert.equal(docs.status, 200)
  const docsHtml = await docs.text()
  assert.match(docsHtml, /MX record/)
  assert.match(docsHtml, /Commenter/)

  const about = await app.request('/about')
  assert.equal(about.status, 200)
  assert.match(await about.text(), /share the password/i)

  const home = await app.request('/')
  assert.match(await home.text(), /href="\/about"/)
})

test('/homepage shows the homepage even with a session', async () => {
  const { createSession } = await import('../src/auth.js')
  const sid = await createSession('somebody@t.test')
  const res = await app.request('/homepage', { headers: { cookie: `requests_sid=${sid}` } })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /An email address for your collective/)
})
