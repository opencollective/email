// Capture app screenshots from the local demo server for the video.
// usage: node scripts/shoot.mjs <session token> <out dir> <notification html> [desk|ios|all]
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const [,, sid, outDir, notifPath, mode = 'all'] = process.argv
const B = 'http://localhost:3077'
const here = new URL('.', import.meta.url).pathname
const font = (pkg, file) => `data:font/woff2;base64,${fs.readFileSync(`${here}../node_modules/@fontsource/${pkg}/files/${file}`).toString('base64')}`
// the app asks for Inter and SF Mono; headless Linux has neither
const FONTS = [400, 500, 600, 700].map((w) => `@font-face{font-family:Inter;font-weight:${w};src:url(${font('inter', `inter-latin-${w}-normal.woff2`)})}`).join('')
  + [400, 500].map((w) => `@font-face{font-family:'SF Mono';font-weight:${w};src:url(${font('jetbrains-mono', `jetbrains-mono-latin-${w}-normal.woff2`)})}`).join('')
  + `@font-face{font-family:'SF Mono';font-weight:600 800;src:url(${font('jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2')})}`
  + ':root{--mono:"SF Mono",monospace !important} body{font-family:Inter,sans-serif}'

const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome' })
async function context(vp, scale, mobile = false) {
  const c = await browser.newContext({ viewport: vp, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile })
  await c.addCookies([{ name: 'requests_sid', value: sid, url: B }])
  return c
}
async function settle(p) {
  await p.addStyleTag({ content: FONTS })
  await p.evaluate(() => document.fonts.ready)
  await p.waitForTimeout(500)
}
async function shot(c, path, file, prep) {
  const p = await c.newPage()
  await p.goto(B + path, { waitUntil: 'networkidle' })
  await settle(p)
  if (prep) await prep(p)
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${outDir}/${file}.png` })
  await p.close()
}

if (mode === 'all' || mode === 'desk') {
  const desk = await context({ width: 1440, height: 900 }, 2)
  await shot(desk, '/homepage', 'home')
  await shot(desk, '/inbox/commonshub', 'inbox')
  await shot(desk, '/inbox/commonshub/thread/1', 'thread-repair')
  await shot(desk, '/inbox/commonshub/members', 'members')
  { // the whole thread, to pan from the email down to the notes and the agent's reply
    const tall = await context({ width: 1440, height: 2300 }, 2)
    const p = await tall.newPage()
    await p.goto(B + '/inbox/commonshub/thread/1', { waitUntil: 'networkidle' })
    await settle(p)
    await p.screenshot({ path: `${outDir}/thread-full.png` })
    await p.close()
  }
  await shot(desk, '/inbox/commonshub?f=drafts', 'drafts')
  await shot(desk, '/inbox/commonshub/thread/9', 'draft-nl')
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await shot(anon, '/claim', 'claim')
  await shot(anon, '/claim', 'claim-typed', async (p) => {
    const input = p.locator('input[type=text], input:not([type])').first()
    await input.fill('commonshub')
  })
}

if (mode === 'all' || mode === 'ios') {
  const tpl = fs.readFileSync(`${here}ios-mail.html`, 'utf8')
  const body = fs.readFileSync(notifPath, 'utf8')
  const html = tpl.replace('{{BODY}}', body).replace('{{INITIALS}}', 'ML').replace('{{WHEN}}', '14:27')
    .replace('{{FROM}}', 'Marie Laurent via hello@commonshub.brussels')
    .replace('{{SUBJECT}}', 'Partnership proposal – Brussels Climate Week 2026')
  const phone = await context({ width: 390, height: 844 }, 3, true)
  const render = async (file) => {
    const p = await phone.newPage()
    await p.setContent(html, { waitUntil: 'networkidle' })
    await settle(p)
    await p.screenshot({ path: `${outDir}/${file}.png` })
    const box = async (sel) => { const b = await p.locator(sel).first().boundingBox(); return b && { x: b.x / 390, y: b.y / 844, w: b.width / 390, h: b.height / 844 } }
    const boxes = { assign: await box('a:has-text("Assign to me")'), badge: await box('img[alt*="when this was sent"]') }
    await p.close()
    return boxes
  }
  const before = await render('ios-before')
  // the real one-click: the link renders a self-submitting form, then lands on the thread
  const assignHref = /href="([^"]+\/a\/[^"]+)"[^>]*>Assign to me/.exec(body)[1]
  const p = await phone.newPage()
  await p.goto(assignHref, { waitUntil: 'networkidle' })
  await p.waitForURL(/thread/, { timeout: 10000 })
  await settle(p)
  await p.screenshot({ path: `${outDir}/ios-thread.png` })
  await p.close()
  const after = await render('ios-after')
  fs.writeFileSync(`${outDir}/ios-boxes.json`, JSON.stringify({ before, after }, null, 1))
}
await browser.close()
