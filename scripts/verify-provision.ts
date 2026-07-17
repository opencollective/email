import { all } from '../src/db.js'
const rows = await all<any>(`
  SELECT c.slug, c.name, c.status, c.plan, c.comped, c.trial_ends_at,
         (SELECT group_concat(m.email || ':' || m.role) FROM members m WHERE m.collective_id = c.id AND m.removed_at IS NULL) AS members
  FROM collectives c WHERE c.slug IN ('hello','xlcollective') ORDER BY c.slug`)
for (const r of rows) console.log(JSON.stringify(r))
process.exit(0)
