/**
 * DEFENSIBILITY (P0 of the peer-assessed trust lens).
 * Spec: E:\dev\living-docs\03_specs\DEFENSIBILITY_DISCERNMENT_LENS_SPEC_v0.md
 *
 * Defensibility = of an agent's OWN claims that reached a conclusive peer
 * verification, the share that were UPHELD. Computed read-only from
 * peer_verification_queue (source_agent_id = the agent):
 *   verified  → upheld
 *   disputed  → contested (not upheld)
 *   timeout / in_review → inconclusive or pending — EXCLUDED
 *
 * ⚠ PROVISIONAL: whether `disputed` means "claim failed" vs merely
 * "escalated" is under Grok cross-validation (INBOX_XC 2026-07-23, Q7).
 * Until confirmed, responses carry provisional=true and this is NOT wired
 * into any public leaderboard lens — it's a shadow read endpoint.
 *
 * Discernment (are you right when you check others) is P1 — it needs a
 * verifier-verdict → consensus join and is returned as null here.
 */

import { db } from '../db';

const MIN_CONCLUSIVE = Number(process.env.RELIABILITY_MIN_SAMPLE ?? 20);

export interface DefensibilityResult {
  agent_id: string;
  defensibility: number | null; // null until min sample
  verified: number;
  disputed: number;
  conclusive: number; // verified + disputed
  inconclusive: number; // timeout + in_review (excluded)
  sample_ok: boolean;
  min_sample: number;
  discernment: null; // P1
  provisional: true;
  basis: string;
  as_of: string;
}

/** Count peer-verifications for an agent as the CLAIM SOURCE, by status. */
async function countAsSource(agentId: string): Promise<Record<string, number>> {
  // One grouped query would be ideal, but supabase-js has no GROUP BY;
  // exact-count HEAD requests per status keep it simple and index-friendly.
  const statuses = ['verified', 'disputed', 'timeout', 'in_review'];
  const out: Record<string, number> = {};
  await Promise.all(
    statuses.map(async (s) => {
      const { count } = await db
        .from('peer_verification_queue')
        .select('id', { count: 'exact', head: true })
        .eq('source_agent_id', agentId)
        .eq('verification_status', s);
      out[s] = count ?? 0;
    })
  );
  return out;
}

/** Pure scoring — no DB. Exposed for tests. */
export function scoreDefensibility(
  counts: { verified?: number; disputed?: number; timeout?: number; in_review?: number },
  minSample = MIN_CONCLUSIVE
): Omit<DefensibilityResult, 'agent_id' | 'basis' | 'as_of'> {
  const verified = counts.verified ?? 0;
  const disputed = counts.disputed ?? 0;
  const conclusive = verified + disputed;
  const inconclusive = (counts.timeout ?? 0) + (counts.in_review ?? 0);
  const sample_ok = conclusive >= minSample;
  return {
    defensibility: sample_ok ? Number((verified / conclusive).toFixed(4)) : null,
    verified,
    disputed,
    conclusive,
    inconclusive,
    sample_ok,
    min_sample: minSample,
    discernment: null,
    provisional: true,
  };
}

export async function computeDefensibility(agentId: string): Promise<DefensibilityResult> {
  const c = await countAsSource(agentId);
  return {
    agent_id: agentId,
    ...scoreDefensibility(c),
    basis:
      'defensibility = verified / (verified + disputed) of an agent\'s own claims under peer verification; ' +
      'timeout/in_review excluded as inconclusive. Discernment (P1) and disputed-semantics confirm pending.',
    as_of: new Date().toISOString(),
  };
}
