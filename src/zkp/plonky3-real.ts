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
const PROVER_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 1000;
const HEALTH_CACHE_TTL_MS = 60_000;

// Lazy — read PLONKY3_PROVER_URL on every call so tests can mutate
// process.env between cases without re-importing the module.
function proverUrl(): string {
  return process.env.PLONKY3_PROVER_URL || '';
}

interface HealthCacheEntry {
  healthy: boolean;
  checkedAt: number;
}
let healthCache: HealthCacheEntry | null = null;

export function _resetProverHealthCacheForTest(): void {
  healthCache = null;
}

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
 * GET ${PLONKY3_PROVER_URL}/health with a 1s timeout.
 *
 * Returns true only when status code is 200 AND the JSON body has
 * `status: "ok"` (the schema added in the Axum service's
 * feat/plonky3-observability-2026-04-28). Any other shape, any
 * non-200, or any transport failure → false.
 *
 * Result is cached for 60s so high-frequency proof callers don't
 * pay the round-trip every time. Test harnesses can flush the cache
 * via _resetProverHealthCacheForTest().
 */
export async function checkProverHealth(): Promise<boolean> {
  const base = proverUrl();
  if (!base) return false;

  const now = Date.now();
  if (healthCache && now - healthCache.checkedAt < HEALTH_CACHE_TTL_MS) {
    return healthCache.healthy;
  }

  const url = base.replace(/\/$/, '') + '/health';
  let healthy = false;
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as { status?: string } | null;
      healthy = j?.status === 'ok';
    }
  } catch {
    healthy = false;
  }
  healthCache = { healthy, checkedAt: now };
  return healthy;
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

  const base = proverUrl();
  if (!base) {
    return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
  }

  // Pre-flight: skip the 5s proof timeout when /health says down. Cached 60s.
  const healthy = await checkProverHealth();
  if (!healthy) {
    return { proof: hmacFallback(body), proof_source: 'hmac_fallback' };
  }

  const url = base.replace(/\/$/, '') + '/prove/trade_auth';
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
