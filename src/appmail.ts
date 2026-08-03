import fs from 'node:fs'
import path from 'node:path'
import { cfg } from './config.js'

export interface AppMail {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  from?: string
}

/** Test seam: capture outgoing app mail instead of hitting the network. */
let observer: ((mail: AppMail) => void) | null = null
export function __observeAppMail(fn: ((mail: AppMail) => void) | null) { observer = fn }

/** Send an app email (login codes, notifications, digests) via Resend.
 *  Without RESEND_API_KEY the email is printed to stdout — handy in dev. */
export async function sendAppEmail(opts: {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  /** Display From, e.g. `Commons Hub Brussels <commonshub@collective.email>`.
   *  Must stay on our own sending domain (Resend verification + the inbound
   *  loop guard both depend on it). */
  from?: string
}): Promise<boolean> {
  observer?.(opts)
  if (!cfg.resendKey) {
    console.log(`\n[appmail:dev] To: ${opts.to}\n[appmail:dev] Subject: ${opts.subject}${opts.replyTo ? `\n[appmail:dev] Reply-To: ${opts.replyTo}` : ''}\n${opts.text}\n`)
    try { fs.writeFileSync(path.join(cfg.dataDir, 'last-email.html'), opts.html) } catch { /* dev nicety only */ }
    return true
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opts.from || cfg.resendFrom,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(opts.replyTo ? { reply_to: [opts.replyTo] } : {}),
      }),
    })
    if (!res.ok) {
      console.error(`[appmail] Resend error ${res.status}: ${await res.text()}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[appmail] Resend request failed:', err)
    return false
  }
}
