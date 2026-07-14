/** Dev-only: flip collective 1 to pro for wizard screenshots. */
import { run } from '../src/db.js'
await run("UPDATE collectives SET plan = 'pro' WHERE id = 1")
console.log('pro')
process.exit(0)
