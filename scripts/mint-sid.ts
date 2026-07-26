/** Dev-only: mint a short session for an existing member email (to inspect rendered pages). */
import { createSession } from '../src/auth.js'
const email = process.argv[2]
if (!email) { console.error('usage: mint-sid.ts <email>'); process.exit(1) }
console.log(await createSession(email))
process.exit(0)
