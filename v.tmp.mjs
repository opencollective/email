import { createClient } from '@libsql/client'
import crypto from 'node:crypto'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')]}))
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
const now = Math.floor(Date.now()/1000)
const token = crypto.randomBytes(32).toString('base64url')
await db.execute({sql: "INSERT INTO sessions (token, email, created_at, expires_at) VALUES (?, 'xdamman@opencollective.com', ?, ?)", args:[token, now, now+3600]})
console.log(token)
