/** Dev-only: print the LAST part of a message's body_text (read-only). */
import { get } from '../src/db.js'
const id = Number(process.argv[2] || 31)
const m = await get<any>('SELECT body_text FROM messages WHERE id = ?', [id])
console.log(JSON.stringify(m?.body_text?.slice(-800)))
process.exit(0)
