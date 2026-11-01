/**
 * actor-binding.ts — when the API key is bound to an agent, the actor a request names must be that agent.
 *
 * Several routes take the agent whose score moves from the body: POST /challenge (challengerId),
 * POST /api/v1/challenge/create (challenger_agent, a name), POST /api/v1/substance-gate/events
 * (agentName). authMiddleware only binds the fields in its IDENTITY_FIELDS list, so these were
 * free: agent A's key could act as B. One check here, used by every such route, so a new door
 * cannot be fixed in one place and left open in another (Strix, repid-engine#1470).
 *
 * A name is checked against THE PRINCIPAL'S OWN ROW, never looked up globally: agent_name is not
 * unique and registration is public, so a global lookup could be made ambiguous by anyone who
 * registers a duplicate, locking the real agent out (Strix). And the exact string is authorized,
 * because the writers resolve the name as sent: ' Alice' must not pass as 'Alice'.
 *
 * Operator keys (REPID_API_KEYS, no bound agent) are unchanged, the same rule as score.ts.
 */
import type { Request } from 'express';
import { db } from '../db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the key is bound to an agent. Routes that let the caller name a SECOND agent and
 * move its score on the caller's own say-so (the challenge routes: the defender is any agent, the
 * verdict comes from claim text the caller writes) are operator-only: binding the challenger is
 * not enough when registration is public and keys are self-issued (Strix, #1470).
 */
export function agentBoundKey(req: Request): boolean {
  const principal = (req as any).agent_id;
  return typeof principal === 'string' && principal.trim() !== '';
}

/** null when the request may act as `actor` (an id or an agent_name); otherwise why not. */
export async function actorMismatch(req: Request, actor: unknown): Promise<string | null> {
  const principal = (req as any).agent_id;
  if (typeof principal !== 'string' || !principal.trim()) return null; // operator key
  if (typeof actor !== 'string' || !actor.trim()) return 'actor_missing';
  if (actor !== actor.trim()) return 'actor_untrimmed';
  if (UUID.test(actor)) return actor.toLowerCase() === principal.trim().toLowerCase() ? null : 'actor_not_principal';
  const { data, error } = await db.from('repid_agents').select('agent_name').eq('id', principal.trim()).maybeSingle();
  if (error || !data) return 'actor_unresolved';
  return (data as any).agent_name === actor ? null : 'actor_not_principal';
}
