/** Dev-only: list active members of a collective (read-only). */
import { all } from '../src/db.js'
const slug = process.argv[2] || 'commonshub'
const m = await all<any>('SELECT m.email, m.role FROM members m JOIN collectives c ON c.id = m.collective_id WHERE c.slug = ? AND m.removed_at IS NULL', [slug])
console.log(JSON.stringify(m))
process.exit(0)
