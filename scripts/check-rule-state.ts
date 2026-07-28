/** Dev-only: verify rule/thread/html state for the newsletter feature (read-only). */
import { all, get } from '../src/db.js'
import { ruleFor } from '../src/rules.js'
console.log('rules:', JSON.stringify(await all('SELECT * FROM rules')))
const t = await get<any>('SELECT id, counterpart_email, status, assignee_member_id, collective_id FROM threads WHERE id = 11')
console.log('thread 11:', JSON.stringify(t))
const m = await get<any>('SELECT id, from_email, direction, length(body_html) AS html_len FROM messages WHERE thread_id = 11')
console.log('msg:', JSON.stringify(m))
console.log('ruleFor:', JSON.stringify(await ruleFor(t.collective_id, t.counterpart_email)))
process.exit(0)
