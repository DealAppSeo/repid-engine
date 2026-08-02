/**
 * agent-self-serve-key.ts — an agent can earn its own API key, without a human.
 *
 * THE WALL THIS REMOVES. Discovery already works: /.well-known/agent.json,
 * /.well-known/ai-plugin.json and /openapi.json are all live and unauthenticated,
 * so an agent can find this engine, read the spec, and know exactly what it
 * wants. Then it stops. Every write path needs an API key, and the only way to
 * get one is POST /api/v1/api-key-requests/request — a REQUEST, which a human
 * reads and approves. So the funnel from "agent discovers us" to "agent makes a
 * paid call" has a person standing in the middle of it, and it does not matter
 * how good the discovery documents are.
 *
 * WHAT AN AGENT PROVES INSTEAD. The same thing a human proves to own an agent, in
 * the same way: control of the wallet the agent is registered under, by signature
 * over a message naming this exact agent. Identity is a recovered signature,
 * never a header (human-agent-binding.ts, stake-authorization.ts — this is the
 * third surface built on that doctrine, deliberately).
 *
 * WHY A CHALLENGE AND NOT A TIMESTAMP. A signature over "issue me a key for agent
 * X" is a bearer token for every future key. Sign once, mint forever, including
 * after the operator revokes. So the server issues a single-use nonce, the agent
 * signs THAT, and the nonce is consumed on success. In-memory with a short TTL,
 * exactly as email-otp.ts does it and for the same reasons: one instance, and a
 * redeploy costs a caller one extra round trip.
 *
 * FRICTION IN PROPORTION TO VALUE AND RISK, the agent-side rung of the same
 * ladder the human side uses:
 *   anonymous          read the market board, agent cards, /stats. No proof.
 *   wallet signature   a scoped key: score events, LLM calls, reading cards.
 *                      Enough to participate; not enough to be dangerous.
 *   NOT granted here   'admin'. Key issuance and revocation for other agents
 *                      stay human-gated, because a key that can mint keys is a
 *                      key that can mint keys for someone else.
 *
 * WHAT THE KEY CAN STILL DO, said plainly: it is agent-BOUND, so f2-authz treats
 * the holder as that agent. That is the point — it can buy, bid, and accept a
 * deliverable it is the buyer on. It cannot act as any other agent, and the
 * money-release path additionally checks that the caller IS the buyer on that
 * specific contract.
 *
 * ONE LIVE KEY PER AGENT. Re-issuing revokes the previous one rather than
 * accumulating credentials nobody is tracking. An agent that lost its key can
 * recover; an attacker who briefly held one does not get to keep it forever.
 *
 * FLAG: AGENT_SELF_SERVE_KEYS_ENABLED (default OFF). Original work that mints
 * live credentials, so it lands finished and inert per CLAUDE_RULES 23.
 */

import { randomBytes, createHash } from 'crypto';
import { verifyMessage } from 'ethers';
import { db } from '../db';

export const AGENT_SELF_SERVE_KEYS_ENABLED =
  process.env.AGENT_SELF_SERVE_KEYS_ENABLED === 'true';

/** Deliberately excludes 'admin'. See the module header. */
export const SELF_SERVE_SCOPES = ['score_event', 'llm_complete', 'read_card'] as const;

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES_PER_AGENT_PER_HOUR = 5;

interface Challenge {
  nonce: string;
  agentId: string;
  expiresAt: number;
}

const challenges = new Map<string, Challenge>(); // key: nonce
const issueLog = new Map<string, number[]>(); // key: agentId → issue timestamps

/** Test seam — the maps are module state and must be resettable. */
export function __resetSelfServeState(): void {
  challenges.clear();
  issueLog.clear();
}

function sweep(now: number): void {
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k);
  for (const [k, times] of issueLog) {
    const fresh = times.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) issueLog.delete(k);
    else issueLog.set(k, fresh);
  }
}

/** The exact text an agent's wallet signs. The nonce is what stops replay. */
export function keyChallengeMessage(params: { agentId: string; nonce: string }): string {
  return [
    'HyperDAG — issue agent API key',
    '',
    `agent: ${params.agentId}`,
    `nonce: ${params.nonce}`,
    '',
    'Signing this proves you control the wallet this agent is registered under',
    'and issues an API key scoped to acting AS this agent.',
    'It moves no funds. Any previously issued self-serve key is revoked.',
  ].join('\n');
}

export interface ChallengeResult {
  ok: boolean;
  nonce?: string;
  message?: string;
  expires_in_seconds?: number;
  wallet?: string;
  reason?: 'disabled' | 'agent_not_found' | 'no_wallet' | 'rate_limited';
  detail?: string;
}

export async function createKeyChallenge(agentIdRaw: string): Promise<ChallengeResult> {
  if (!AGENT_SELF_SERVE_KEYS_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Self-serve agent keys are not enabled on this deployment.' };
  }
  const now = Date.now();
  sweep(now);

  const agent = await loadAgent(agentIdRaw);
  if (!agent) {
    return { ok: false, reason: 'agent_not_found', detail: 'No agent is registered under that id or name.' };
  }
  if (!agent.wallet_address) {
    return {
      ok: false,
      reason: 'no_wallet',
      detail:
        'This agent has no registered wallet_address, so there is nothing to prove control of. ' +
        'Register a wallet first.',
    };
  }

  const recent = (issueLog.get(agent.id) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= MAX_CHALLENGES_PER_AGENT_PER_HOUR) {
    return { ok: false, reason: 'rate_limited', detail: 'Too many key issuances for this agent in the last hour.' };
  }

  const nonce = randomBytes(16).toString('hex');
  challenges.set(nonce, { nonce, agentId: agent.id, expiresAt: now + CHALLENGE_TTL_MS });

  return {
    ok: true,
    nonce,
    message: keyChallengeMessage({ agentId: agent.id, nonce }),
    expires_in_seconds: Math.floor(CHALLENGE_TTL_MS / 1000),
    wallet: agent.wallet_address,
  };
}

export interface IssueResult {
  ok: boolean;
  key?: string;
  key_prefix?: string;
  agent_id?: string;
  scopes?: string[];
  revoked_previous?: boolean;
  reason?:
    | 'disabled'
    | 'unknown_nonce'
    | 'nonce_expired'
    | 'agent_not_found'
    | 'no_wallet'
    | 'bad_signature'
    | 'write_failed';
  detail?: string;
}

export async function issueSelfServeKey(params: {
  nonce: string;
  signature: string;
}): Promise<IssueResult> {
  if (!AGENT_SELF_SERVE_KEYS_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Self-serve agent keys are not enabled on this deployment.' };
  }
  const now = Date.now();
  sweep(now);

  const challenge = challenges.get(String(params.nonce ?? ''));
  if (!challenge) {
    return {
      ok: false,
      reason: 'unknown_nonce',
      detail: 'That challenge is unknown or already used. Request a fresh one.',
    };
  }
  if (challenge.expiresAt < now) {
    challenges.delete(challenge.nonce);
    return { ok: false, reason: 'nonce_expired', detail: 'That challenge expired. Request a fresh one.' };
  }

  const agent = await loadAgent(challenge.agentId);
  if (!agent) return { ok: false, reason: 'agent_not_found', detail: 'Agent no longer exists.' };
  if (!agent.wallet_address) return { ok: false, reason: 'no_wallet', detail: 'Agent has no registered wallet.' };

  const message = keyChallengeMessage({ agentId: agent.id, nonce: challenge.nonce });
  if (!signatureMatches(agent.wallet_address, message, params.signature)) {
    // The nonce is NOT consumed on a bad signature — a wrong attempt should not
    // cost a legitimate agent its challenge. The TTL still bounds the window.
    return {
      ok: false,
      reason: 'bad_signature',
      detail: 'The signature did not recover to this agent\'s registered wallet.',
    };
  }

  // Consume before issuing: a nonce that survives its own success is a replay.
  challenges.delete(challenge.nonce);

  const rawKey = 'ts_live_' + randomBytes(16).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 16);

  // One live self-serve key per agent.
  const { error: revokeErr } = await db
    .from('agent_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('agent_id', agent.id)
    .eq('name', SELF_SERVE_KEY_NAME)
    .is('revoked_at', null);
  const revokedPrevious = !revokeErr;

  const { error } = await db.from('agent_api_keys').insert({
    agent_id: agent.id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: SELF_SERVE_KEY_NAME,
    scopes: [...SELF_SERVE_SCOPES],
  });
  if (error) return { ok: false, reason: 'write_failed', detail: error.message };

  const log = issueLog.get(agent.id) ?? [];
  log.push(now);
  issueLog.set(agent.id, log);

  return {
    ok: true,
    key: rawKey,
    key_prefix: keyPrefix,
    agent_id: agent.id,
    scopes: [...SELF_SERVE_SCOPES],
    revoked_previous: revokedPrevious,
  };
}

export const SELF_SERVE_KEY_NAME = 'self-serve';

/** Recover the signer and compare. False on any malformed input, never throws. */
export function signatureMatches(wallet: string, message: string, signature: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadAgent(
  idOrName: string,
): Promise<{ id: string; wallet_address: string | null } | null> {
  const key = String(idOrName ?? '').trim();
  if (!key) return null;
  const col = UUID_RE.test(key) ? 'id' : 'agent_name';
  const { data } = await db
    .from('repid_agents')
    .select('id, wallet_address')
    .eq(col, key)
    .maybeSingle();
  if (!data) return null;
  return {
    id: String((data as any).id),
    wallet_address: (data as any).wallet_address ?? null,
  };
}
