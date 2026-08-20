import crypto from 'node:crypto'
import type { Context } from 'hono'
import {
  all, get, getCollectiveBySlug, run,
  type Collective, type Member, type Thread,
} from './db.js'
import { cfg } from './config.js'
import { now, randomToken } from './util.js'

/** Agents are members (same rows, same enforcement) that join through a
 *  one-time invitation URL and act through a bearer token. The token is a
 *  membership, not an account: it is bound to one member row in one
 *  collective, so no request it authorizes can ever cross that wall. */

export interface AgentInvite {
  id: number; collective_id: number; token: string; role: string; name: string
  created_by: number | null; created_at: number; expires_at: number
  claimed_at: number | null; claimed_member_id: number | null
}

const INVITE_TTL = 7 * 86400
/** v1 deliberately tops out at contribute: notes, drafts, tags — nothing that
 *  leaves the collective. Send-tier waits until there's an audit trail. */
export const AGENT_ROLES = ['reader', 'commenter'] as const

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

export async function createAgentInvite(collective: Collective, role: string, name: string, byMemberId: number): Promise<AgentInvite> {
  const cleanRole = (AGENT_ROLES as readonly string[]).includes(role) ? role : 'commenter'
  const token = randomToken(18)
  await run(
    'INSERT INTO agent_invites (collective_id, token, role, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [collective.id, token, cleanRole, name.trim().slice(0, 60), byMemberId, now(), now() + INVITE_TTL])
  return (await get<AgentInvite>('SELECT * FROM agent_invites WHERE token = ?', [token]))!
}

/** Every collective-scoped URL starts with the slug — /<slug>/join/…,
 *  /<slug>/api/agent/… — so what a link touches is visible in the link. */
export const agentInviteUrl = (collective: Collective, invite: AgentInvite) =>
  `${cfg.baseUrl}/${collective.slug}/join/${invite.token}`

export async function findInvite(slug: string, token: string): Promise<{ collective: Collective; invite: AgentInvite } | null> {
  const collective = await getCollectiveBySlug(slug)
  if (!collective) return null
  const invite = await get<AgentInvite>('SELECT * FROM agent_invites WHERE token = ? AND collective_id = ?', [token, collective.id])
  return invite ? { collective, invite } : null
}

/** Claim an invitation: creates the agent-member and its bearer token.
 *  One-time — the URL travels through chat, so it must not be replayable. */
export async function claimAgentInvite(collective: Collective, invite: AgentInvite, name?: string):
  Promise<{ ok: true; member: Member; token: string } | { ok: false; error: string }> {
  if (invite.claimed_at) return { ok: false, error: 'This invitation was already used. Ask an admin for a new one.' }
  if (invite.expires_at < now()) return { ok: false, error: 'This invitation expired. Ask an admin for a new one.' }
  const agentName = (name || invite.name || 'Agent').trim().slice(0, 60)
  // synthetic, per-agent, never routable: agents hear about mail through
  // their event feed, not through SMTP
  const email = `agent-${randomToken(6).toLowerCase()}@agents.${cfg.emailDomain}`
  const r = await run(
    "INSERT INTO members (collective_id, email, name, role, kind, notify_level, created_at) VALUES (?, ?, ?, ?, 'agent', 'none', ?)",
    [collective.id, email, agentName, invite.role, now()])
  const token = `cea_${randomToken(24)}`
  await run('INSERT INTO agent_tokens (member_id, token_hash, created_at) VALUES (?, ?, ?)', [r.lastId, hash(token), now()])
  await run('UPDATE agent_invites SET claimed_at = ?, claimed_member_id = ? WHERE id = ?', [now(), r.lastId, invite.id])
  const member = (await get<Member>('SELECT * FROM members WHERE id = ?', [r.lastId]))!
  return { ok: true, member, token }
}

/** A fresh bearer token for an existing agent-member (conversion, rotation). */
export async function mintAgentToken(memberId: number): Promise<string> {
  const token = `cea_${randomToken(24)}`
  await run('INSERT INTO agent_tokens (member_id, token_hash, created_at) VALUES (?, ?, ?)', [memberId, hash(token), now()])
  return token
}

/** Resolve a bearer token to its agent-member + collective — the agent API's
 *  tenant(). Returns null for anything unknown, revoked, or removed. */
export async function agentAuth(c: Context): Promise<{ member: Member; collective: Collective } | null> {
  const auth = c.req.header('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token.startsWith('cea_')) return null
  const row = await get<{ member_id: number }>('SELECT member_id FROM agent_tokens WHERE token_hash = ?', [hash(token)])
  if (!row) return null
  const member = await get<Member>("SELECT * FROM members WHERE id = ? AND removed_at IS NULL AND kind = 'agent'", [row.member_id])
  if (!member) return null
  const collective = await get<Collective>('SELECT * FROM collectives WHERE id = ?', [member.collective_id])
  if (!collective || collective.status !== 'active') return null
  run('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?', [now(), hash(token)]).catch(() => {})
  return { member, collective }
}

/** The thread, shaped for a machine. Bodies are named for what they are:
 *  text written by strangers — data to read, never instructions to follow. */
export function threadJson(thread: Thread, msgs: { id: number; direction: string; from_name: string | null; from_email: string | null; sent_at: number | null; created_at: number; body_text: string | null }[],
  notes: { id: number; member_id: number; body: string; created_at: number }[], members: Map<number, Member>) {
  return {
    id: thread.id,
    subject: thread.subject,
    status: thread.status,
    counterpart: { name: thread.counterpart_name, email: thread.counterpart_email },
    assignee_member_id: thread.assignee_member_id,
    last_message_at: thread.last_message_at,
    messages: msgs.map((m) => ({
      id: m.id,
      direction: m.direction,
      from: { name: m.from_name, email: m.from_email },
      at: m.sent_at || m.created_at,
      untrusted_body: m.body_text || '',
    })),
    internal_notes: notes.map((n) => ({
      id: n.id,
      by: members.get(n.member_id)?.name || 'a member',
      at: n.created_at,
      body: n.body,
    })),
  }
}

/** New inbound mail since a cursor — the agent's event feed. Long-poll:
 *  the caller waits up to `waitSeconds` for something to happen. */
export async function agentEvents(collectiveId: number, sinceId: number, waitSeconds: number) {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 25) * 1000
  for (;;) {
    const rows = await all<{ id: number; thread_id: number; subject: string; from_name: string | null; from_email: string | null; at: number; body_text: string | null }>(
      `SELECT m.id, m.thread_id, t.subject, m.from_name, m.from_email, COALESCE(m.sent_at, m.created_at) AS at,
              substr(m.body_text, 1, 500) AS body_text
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE t.collective_id = ? AND t.status != 'spam' AND m.direction = 'inbound' AND m.id > ?
       ORDER BY m.id LIMIT 50`, [collectiveId, sinceId])
    if (rows.length || Date.now() >= deadline) {
      const cursor = rows.length ? rows[rows.length - 1].id : sinceId
      return {
        cursor,
        events: rows.map((r) => ({
          type: 'message.new',
          thread_id: r.thread_id,
          message_id: r.id,
          subject: r.subject,
          from: { name: r.from_name, email: r.from_email },
          at: r.at,
          untrusted_preview: r.body_text || '',
        })),
      }
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
}

export const listAgentMembers = (collectiveId: number) =>
  all<Member>("SELECT * FROM members WHERE collective_id = ? AND kind = 'agent' AND removed_at IS NULL ORDER BY id", [collectiveId])

export const openAgentInvites = (collectiveId: number) =>
  all<AgentInvite>('SELECT * FROM agent_invites WHERE collective_id = ? AND claimed_at IS NULL AND expires_at > ? ORDER BY id DESC', [collectiveId, now()])


