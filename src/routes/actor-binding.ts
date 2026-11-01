/**
 * actor-binding.ts — when the API key is bound to an agent, the actor a request names must be that agent.
 *
 * Several routes take the agent whose score moves from the body: POST /challenge (challengerId),
 * POST /api/v1/challenge/create (challenger_agent, a name), POST /api/v1/substance-gate/events
 * (agentName). authMiddleware only binds the fields in its IDENTITY_FIELDS list, so these were
 * free: agent A's key could act as B. One check here, used by every such route, so a new door
 * cannot be fixed in one place and left open in another (Strix, repid-engine#1470).
 *
 * Operator keys (REPID_API_KEYS, no bound agent) are unchanged, the same rule as score.ts.
 */
import type { Request } from 'express';
import { db } from '../db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * null when the request may act as `actor` (an id or an agent_name); otherwise why not.
 * A name must resolve to exactly one agent: none, several, or a read error refuse.
 */
export async function actorMismatch(req: Request, actor: unknown): Promise<string | null> {
  const principal = (req as any).agent_id;
  if (typeof principal !== 'string' || !principal.trim()) return null; // operator key
  const want = principal.trim().toLowerCase();
  const named = typeof actor === 'string' ? actor.trim() : '';
  if (!named) return 'actor_missing';
  if (UUID.test(named)) return named.toLowerCase() === want ? null : 'actor_not_principal';
  const { data, error } = await db.from('repid_agents').select('id').eq('agent_name', named).maybeSingle();
  if (error || !data) return 'actor_unresolved';
  return String((data as any).id).toLowerCase() === want ? null : 'actor_not_principal';
}
