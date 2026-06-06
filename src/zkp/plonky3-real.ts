/**
 * Plonky3 prover bridge.
 *
 * Tries the real Plonky3 HTTP prover at $PLONKY3_PROVER_URL when the
 * env var is set; falls back to a deterministic HMAC-SHA256 stub when
 * the var is unset, the request times out (5s), the retry times out,
 * or the prover returns a malformed response. Every return value
 * carries an explicit `proof_source` so callers can surface honesty
 * to consumers.
 */

import { createHmac } from 'crypto';

const HMAC_SECRET = process.env.PROOF_SECRET || 'repid-default-secret';
const PROVER_URL = process.env.PLONKY3_PROVER_URL || '';
const PROVER_TIMEOUT_MS = 5000;

export type ProofSource = 'plonky3_real' | 'hmac_fallback';

export interface ProofResult {
  proof: string;
  proof_source: ProofSource;
}

interface ProveTradeAuthBody {
  agent_id: string;
  requester_pubkey: string;
  tier: string;
  timestamp: string;
}

function hmacFallback(body: ProveTradeAuthBody): string {
  return createHmac('sha256', HMAC_SECRET)
    .update(`${body.agent_id}:${body.requester_pubkey}:${body.tier}:${body.timestamp}`)
    .digest('base64');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async — calls the real prover first, falls back to HMAC.
 *
 * Tries once, retries once on timeout/network error, then falls back.
 * Never throws — every failure path returns the HMAC fallback.
 */
export async function generateProofReal(
  agentId: string,
  requesterPubkey: string,
  tier: string,
  timestamp: string,
): Promise<ProofResult> {
  const body: ProveTradeAuthBody = {
    agent_id: agentId,
    requester_pubkey: requesterPubkey,
    tier,
    timestamp,
  };

  if (!PROVER_URL) {
    return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
  }

  const url = PROVER_URL.replace(/\/$/, '') + '/prove/trade_auth';
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchWithTimeout(url, init, PROVER_TIMEOUT_MS);
      if (!r.ok) {
        // Non-2xx — don't retry status errors; only retry transport timeouts.
        return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
      }
      const j = (await r.json()) as { proof_bytes?: string };
      if (typeof j?.proof_bytes !== 'string' || j.proof_bytes.length === 0) {
        return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
      }
      return { proof: j.proof_bytes, proof_source: 'plonky3_real' };
    } catch (e: any) {
      // AbortError (timeout) or network error — retry once.
      const isTimeout = e?.name === 'AbortError' || /timeout|aborted/i.test(String(e?.message ?? e));
      if (attempt === 0 && isTimeout) continue;
      return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
    }
  }

  return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
}

/**
 * Synchronous HMAC — kept for legacy callers that cannot await.
 * Same output shape as the previous version: returns the proof string.
 * Prefer generateProofReal() for new code so proof_source flows through.
 */
export function generateProofRealSync(
  agentId: string,
  requesterPubkey: string,
  tier: string,
  timestamp: string,
): string {
  return hmacFallback({ agent_id: agentId, requester_pubkey: requesterPubkey, tier, timestamp });
}

export async function logProofGeneration(supabase: any, agentId: string, tier: string): Promise<void> {
  const { error } = await supabase.from('trinity_agent_logs').insert([{
    agent_name: 'repid-engine',
    action: 'zkp_proof_generated',
    message: `Proof generated for agent ${agentId} at tier ${tier}`,
    created_at: new Date().toISOString(),
  }]);
  if (error) console.error('[zkp] Log error:', error);
}

// ---------------------------------------------------------------------------
// zkp-vault prover endpoints (SPRINT_CC_3 P2). These call the real Rust prover
// (zkp-vault `prover` bin) at $PLONKY3_PROVER_URL. No HMAC fallback: these are
// real ZK statements, so a missing/failed prover returns null (callers decide).
// The Rust service self-verifies before responding (`verified: true`).
// ---------------------------------------------------------------------------

export interface VaultProof {
  ok: boolean;
  verified: boolean;
  statement: string;
  proof_bytes: string; // hex
  proof_len: number;
  [k: string]: unknown;
}

async function callProver(path: string, body: unknown): Promise<VaultProof | null> {
  if (!PROVER_URL) return null;
  const url = PROVER_URL.replace(/\/$/, '') + path;
  try {
    const r = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      PROVER_TIMEOUT_MS,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as VaultProof;
    return j?.ok && j?.verified ? j : null;
  } catch {
    return null;
  }
}

/** Prove human-anonymous ownership (secret/agent_id are private, sent over the
 *  trusted prover channel only). Returns a self-verified proof or null. */
export function generateOwnershipProof(secret: number, agentId: number, context: number) {
  return callProver('/prove/ownership', { secret, agent_id: agentId, context });
}

/** Prove `score >= threshold` without revealing score. Returns a self-verified
 *  proof or null. */
export function generateTierRangeProof(score: number, threshold: number) {
  return callProver('/prove/tier_range', { score, threshold });
}
