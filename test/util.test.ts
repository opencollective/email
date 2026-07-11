import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import {
  htmlToText, parseReplyAddress, replyAddress, signToken, slugify, stripQuotedReply, verifyToken,
} from '../src/util.js'
import { isAutoSubmitted, plainText } from '../src/ingest.js'

test('stripQuotedReply cuts Apple/Gmail "On … wrote:" tails', () => {
  const t = stripQuotedReply('Yes, works for me!\n\nOn 11 Jul 2026, at 10:09, collective.email <n@collective.email> wrote:\n> Hi there\n> old text')
  assert.equal(t, 'Yes, works for me!')
})

test('stripQuotedReply cuts trailing > quoted blocks', () => {
  const t = stripQuotedReply('Answer here\n> quoted line 1\n> quoted line 2\n')
  assert.equal(t, 'Answer here')
})

test('stripQuotedReply keeps > lines followed by fresh text', () => {
  const t = stripQuotedReply('> you said this\nAnd I disagree!')
  assert.ok(t.includes('And I disagree!'))
})

test('htmlToText converts tags, entities, and collapses blank lines', () => {
  const t = htmlToText('<div>Hello &amp; welcome<br><br><br>Second&nbsp;line</div><style>.x{}</style>')
  assert.equal(t, 'Hello & welcome\n\nSecond line')
})

test('replyAddress roundtrips and rejects tampering', () => {
  const addr = replyAddress('commonshub', 12, 3, 45)
  const parsed = parseReplyAddress(addr)
  assert.deepEqual(parsed, { slug: 'commonshub', threadId: 12, memberId: 3, msgId: 45 })
  assert.equal(parseReplyAddress(addr.replace('+r.12.', '+r.99.')), null, 'tampered thread id must fail')
  assert.equal(parseReplyAddress(addr.replace('@collective.email', '@evil.com')), null, 'wrong domain must fail')
})

test('signToken/verifyToken enforce expiry and integrity', () => {
  const ok = signToken({ a: 'assign', th: 1 }, 60)
  assert.equal(verifyToken(ok)?.th, 1)
  const expired = signToken({ a: 'assign' }, -10)
  assert.equal(verifyToken(expired), null)
  assert.equal(verifyToken(ok.slice(0, -2) + 'zz'), null)
})

test('slugify normalizes collective names', () => {
  assert.equal(slugify('La Coopérative!'), 'la-coop-rative')
  assert.equal(slugify('  Commons Hub  '), 'commons-hub')
})

/** Apple Mail rich replies ship an EMPTY text/plain alternative + an HTML part. */
const appleHtmlOnly = (html: string) => [
  'From: X <x@personal.test>',
  'To: commonshub@collective.email',
  'Subject: Re: hello',
  'Message-ID: <html-only@test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="AA"',
  '',
  '--AA',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '',
  '--AA',
  'Content-Type: text/html; charset=utf-8',
  '',
  html,
  '--AA--',
  '',
].join('\r\n')

test('plainText falls back to HTML when the text part is empty (Apple Mail)', async () => {
  const parsed = await simpleParser(appleHtmlOnly(
    '<html><body><div>Well received. Here is a picture.</div><br>' +
    '<blockquote type="cite">On 11 Jul 2026, notifications@collective.email wrote: quoted history</blockquote></body></html>',
  ))
  assert.equal(parsed.text?.trim() || '', '', 'fixture must have an empty text part')
  assert.equal(plainText(parsed, true), 'Well received. Here is a picture.')
})

test('plainText without dropQuotes keeps quoted history', async () => {
  const parsed = await simpleParser(appleHtmlOnly('<p>a</p><blockquote>b</blockquote>'))
  assert.equal(plainText(parsed, false), 'a\nb')
})

test('isAutoSubmitted detects autoresponders', async () => {
  const auto = await simpleParser('Auto-Submitted: auto-replied\r\nSubject: Re: x\r\n\r\nI am away')
  assert.equal(isAutoSubmitted(auto), true)
  const ooo = await simpleParser('Subject: Automatic reply: hello\r\n\r\nOut of office')
  assert.equal(isAutoSubmitted(ooo), true)
  const normal = await simpleParser('Subject: Re: hello\r\n\r\nA real reply')
  assert.equal(isAutoSubmitted(normal), false)
})
