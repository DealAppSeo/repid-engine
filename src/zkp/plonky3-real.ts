/**
 * Plonky3 prover bridge.
 *
 * Tries the real Plonky3 HTTP prover at $PLONKY3_PROVER_URL when the
 * env var is set; falls back to a deterministic HMAC-SHA256 stub when
 * the var is unset, the request times out (5s), the retry times out,
 * or the prover returns a malformed response. Every return value
 * carries an explicit `proof_source` so callers can surface honesty
 * to consumers.
 *
 * LOCAL_MODE: only a loopback prover is called, and there is no HMAC
 * stand-in — every path that would fall back throws ProverUnavailableError.
 */

import { localProverGate, proverAuthHeaders, proverLocalMode, proverRedirect } from '../config/prover';
import { createHmac } from 'crypto';
import { markDegraded } from '../lib/degraded';
import { buildAgentLogRow } from '../engine/agent-log-row';

const HMAC_SECRET = process.env.PROOF_SECRET || 'repid-default-secret';
const PROVER_TIMEOUT_MS = 5000;

/** LOCAL_MODE gets this instead of an HMAC that looks like a proof. Routes answer 503 PROVER_UNAVAILABLE. */
export class ProverUnavailableError extends Error {
  readonly status = 'PROVER_UNAVAILABLE';
  constructor(reason: string) {
    super(`PROVER_UNAVAILABLE: ${reason}`);
    this.name = 'ProverUnavailableError';
  }
}

export type ProofSource = 'plonky3_real' | 'hmac_fallback';

export interface ProofResult {
  proof: string;
  proof_source: ProofSource;
  // "Degrade loudly": the HMAC stub is NOT a real proof. Every fallback path
  // sets these so a caller/DB row can never mistake a stub for a real Plonky3
  // proof. Present ONLY on the fallback; the real path omits them (undefined).
  degraded_mode?: true;
  degraded_reason?: string;
  is_real?: boolean; // true only on the real Plonky3 path; false on every fallback.
}

/**
 * Build the HMAC fallback result with the loud degraded signal attached.
 * `reason` names why we degraded (env unset / timeout / malformed proof_bytes).
 */
function fallbackResult(body: ProveTradeAuthBody, reason: string): ProofResult {
  if (proverLocalMode()) throw new ProverUnavailableError(reason.replace(/ — falling back to HMAC stub.*$/, ''));
  return markDegraded(
    { proof: hmacFallback(body), proof_source: 'hmac_fallback' as ProofSource, is_real: false },
    reason,
    'zkp',
  );
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
 * Hosted: never throws — every failure path returns the HMAC fallback.
 * LOCAL_MODE: throws ProverUnavailableError on every one of those paths.
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

  // Read per call, not at import, so the LOCAL_MODE gate judges the env this call runs under.
  const base = localProverGate(process.env.PLONKY3_PROVER_URL || process.env.ZKP_SERVICE_URL || '');
  if (!base) {
    return fallbackResult(
      body,
      base === null
        ? 'LOCAL_MODE: no loopback prover configured (remote and unset prover URLs are refused)'
        : 'PLONKY3_PROVER_URL is unset — falling back to HMAC stub (NOT a real proof)',
    );
  }

  const url = base.replace(/\/$/, '') + '/prove/trade_auth';
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...proverAuthHeaders() },
    redirect: proverRedirect(),
    body: JSON.stringify(body),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchWithTimeout(url, init, PROVER_TIMEOUT_MS);
      if (!r.ok) {
        // Non-2xx — don't retry status errors; only retry transport timeouts.
        return fallbackResult(body, `prover returned HTTP ${r.status} — falling back to HMAC stub (NOT a real proof)`);
      }
      const j = (await r.json()) as { proof_bytes?: string };
      if (typeof j?.proof_bytes !== 'string' || j.proof_bytes.length === 0) {
        return fallbackResult(body, 'prover returned malformed/empty proof_bytes — falling back to HMAC stub (NOT a real proof)');
      }
      return { proof: j.proof_bytes, proof_source: 'plonky3_real', is_real: true };
    } catch (e: any) {
      if (e instanceof ProverUnavailableError) throw e; // LOCAL_MODE refusal from the try block above
      // AbortError (timeout) or network error — retry once.
      const isTimeout = e?.name === 'AbortError' || /timeout|aborted/i.test(String(e?.message ?? e));
      if (attempt === 0 && isTimeout) continue;
      return fallbackResult(body, `prover request failed (${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? String(e))}) — falling back to HMAC stub (NOT a real proof)`);
    }
  }

  return fallbackResult(body, 'prover retries exhausted — falling back to HMAC stub (NOT a real proof)');
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
  const { error } = await supabase.from('trinity_agent_logs').insert([buildAgentLogRow({
    // `agent` is NOT NULL with no default — omitting it failed 23502 on every call, silently.
    agent: agentId,
    agent_name: 'repid-engine',
    action: 'zkp_proof_generated',
    message: `Proof generated for agent ${agentId} at tier ${tier}`,
    created_at: new Date().toISOString(),
  })]);
  if (error) console.error('[zkp] Log error:', error);
}
