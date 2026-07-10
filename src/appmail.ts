import { cfg } from './config.js'

/** Send an app email (login codes, notifications, digests) via Resend.
 *  Without RESEND_API_KEY the email is printed to stdout — handy in dev. */
export async function sendAppEmail(opts: {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
}): Promise<boolean> {
  if (!cfg.resendKey) {
    console.log(`\n[appmail:dev] To: ${opts.to}\n[appmail:dev] Subject: ${opts.subject}${opts.replyTo ? `\n[appmail:dev] Reply-To: ${opts.replyTo}` : ''}\n${opts.text}\n`)
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
        from: cfg.resendFrom,
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
