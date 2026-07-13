import { getCollectiveBySlug } from '../src/db.js'
const c = await getCollectiveBySlug('contribute')
console.log(JSON.stringify({ id: c?.id, status: c?.status, comped: c?.comped, trial_ends_at: c?.trial_ends_at }))
process.exit(0)
