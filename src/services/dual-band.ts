/**
 * dual-band.ts — Phase C: Competence × Integrity RepID bands.
 *
 * Charter: REPID_DUAL_BAND_CHARTER v0.2  INV-1 (disjoint signals)
 *   Band A — Competence: HAL fact-check OUTCOMES (quorum-confirmed pass/veto)
 *   Band B — Integrity:  peer_verification_queue outcomes (verified vs disputed)
 *                        NEVER HAL's own veto (no self-veto circularity, INV-1)
 *
 * Relationship to GA's wisdom_score / character_score:
 *   wisdom_score   = prediction-calibration (Brier score, reponomics)
 *   character_score = mission-alignment actions (reponomics)
 *   These are orthogonal sub-dimensions; all four coexist in repid_agents.
 *
 * Apply path:
 *   Dry-run by default (reads only, prints results).
 *   Set env DUALBAND_APPLY=true to enable DB writes.
 *   DUALBAND_APPLY should only be set after the migration
 *   (2026-06-15-dual-band-competence-integrity.sql) has been applied by Sean.
 *
 * Compute formulas:
 *
 *   COMPETENCE:
 *     Numerator   = HAL_SCORE_EVENT rows where hal_decision='clean'
 *                   AND hallucination_caught=false   (quorum-confirmed PASS)
 *                 + HAL_SCORE_EVENT rows where hallucination_caught=true
 *                   (quorum-confirmed VETO — the agent's output was genuinely
 *                   hallucinated, so the HAL system correctly caught it;
 *                   this counts as a *successful detection event* for the
 *                   SYSTEM but a *competence failure* for the agent being scored)
 *
 *   WAIT — re-read charter INV-1:
 *     Competence = "accuracy, task success, usefulness" of the AGENT.
 *     A hallucination caught (hallucination_caught=true) means the AGENT
 *     hallucinated. That is a FAILURE for the agent's competence.
 *     A clean pass (hal_decision='clean', hallucination_caught=false)
 *     means the agent produced non-hallucinated output. That is a PASS.
 *
 *   COMPETENCE formula:
 *     quorum_pass  = HAL_SCORE_EVENT rows where
 *                    hal_decision = 'clean' AND hallucination_caught = false
 *     quorum_total = HAL_SCORE_EVENT rows with a non-null hal_decision
 *     competence_score = quorum_pass / quorum_total  (range [0,1])
 *     competence_n     = quorum_total
 *
 *   INTEGRITY formula (INV-1: source is peer_verification_queue, NOT HAL):
 *     finalized    = peer_verification_queue rows where source_agent_id = agent.id
 *                    AND verification_status IN ('verified','disputed')
 *                    (timeout excluded — no peer decision was made)
 *     verified_n   = finalized rows where verification_status = 'verified'
 *     integrity_score = verified_n / finalized_n  (range [0,1])
 *     integrity_n     = finalized_n
 *
 *   If quorum_total = 0: competence_score = null (no data)
 *   If finalized_n = 0:  integrity_score  = null (no data)
 */

import { db } from '../db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BandResult {
  score: number | null;
  n: number;
}

export interface DualBandResult {
  agentId: string;
  agentName: string;
  competence: BandResult;
  integrity: BandResult;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fetch competence signal for a single agent UUID from repid_score_events. */
async function fetchCompetence(agentId: string): Promise<BandResult> {
  const { data, error } = await db
    .from('repid_score_events')
    .select('hal_decision, hallucination_caught')
    .eq('agent_id', agentId)
    .eq('event_type', 'HAL_SCORE_EVENT')
    .not('hal_decision', 'is', null);

  if (error || !data) {
    return { score: null, n: 0 };
  }

  const total = data.length;
  if (total === 0) {
    return { score: null, n: 0 };
  }

  // quorum-confirmed PASS: hal_decision='clean' AND hallucination_caught=false
  // (hal_decision='flagged' or 'vetoed' without hallucination_caught=true =
  //  extractor noise — excluded, not quorum-confirmed)
  const quorumPass = data.filter(
    (row) => row.hal_decision === 'clean' && row.hallucination_caught === false,
  ).length;

  return {
    score: quorumPass / total,
    n: total,
  };
}

/** Fetch integrity signal for a single agent UUID from peer_verification_queue. */
async function fetchIntegrity(agentId: string): Promise<BandResult> {
  const { data, error } = await db
    .from('peer_verification_queue')
    .select('verification_status')
    .eq('source_agent_id', agentId)
    .in('verification_status', ['verified', 'disputed']);

  if (error || !data) {
    return { score: null, n: 0 };
  }

  const finalized = data.length;
  if (finalized === 0) {
    return { score: null, n: 0 };
  }

  const verified = data.filter((row) => row.verification_status === 'verified').length;

  return {
    score: verified / finalized,
    n: finalized,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute dual-band scores for a single agent.
 *
 * @param agentId  UUID of the agent in repid_agents.id
 * @returns DualBandResult — always returns data (null score = insufficient data)
 */
export async function computeDualBand(agentId: string): Promise<DualBandResult> {
  const applyWrites = process.env.DUALBAND_APPLY === 'true';

  // Fetch agent name for context
  const { data: agentRow } = await db
    .from('repid_agents')
    .select('agent_name')
    .eq('id', agentId)
    .single();

  const agentName = agentRow?.agent_name ?? agentId;

  const [competence, integrity] = await Promise.all([
    fetchCompetence(agentId),
    fetchIntegrity(agentId),
  ]);

  if (applyWrites) {
    const updatePayload: Record<string, unknown> = {
      dual_band_updated_at: new Date().toISOString(),
    };
    if (competence.score !== null) {
      updatePayload.competence_score = competence.score;
      updatePayload.competence_n = competence.n;
    }
    if (integrity.score !== null) {
      updatePayload.integrity_score = integrity.score;
      updatePayload.integrity_n = integrity.n;
    }
    await db.from('repid_agents').update(updatePayload).eq('id', agentId);
  }

  return {
    agentId,
    agentName,
    competence,
    integrity,
    dryRun: !applyWrites,
  };
}

/**
 * Compute dual-band scores for all active Trinity agents.
 *
 * Queries repid_agents for lifecycle_status='active' agents whose names
 * match 'trinity-%', runs computeDualBand for each, and returns all results.
 *
 * Writes are guarded by DUALBAND_APPLY=true (default: dry-run).
 */
export async function computeAllDualBands(): Promise<DualBandResult[]> {
  const { data: agents, error } = await db
    .from('repid_agents')
    .select('id, agent_name')
    .eq('lifecycle_status', 'active')
    .like('agent_name', 'trinity-%');

  if (error || !agents || agents.length === 0) {
    console.warn('[dual-band] No active trinity agents found:', error?.message);
    return [];
  }

  const results: DualBandResult[] = [];
  for (const agent of agents) {
    if (!agent.id) continue; // skip agents without a UUID (role-play stubs)
    const result = await computeDualBand(agent.id);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI sample runner (invoked when this module is run directly)
// dry-run: prints real numbers computed from live DB, no writes.
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    console.log('[dual-band] Running READ-ONLY sample over live trinity agents...');
    console.log('[dual-band] DUALBAND_APPLY =', process.env.DUALBAND_APPLY ?? 'unset (dry-run)');
    console.log('');

    const results = await computeAllDualBands();

    if (results.length === 0) {
      console.log('[dual-band] No agents returned — check SUPABASE_URL/SUPABASE_SERVICE_KEY.');
      process.exit(1);
    }

    console.log(
      'agent_name'.padEnd(20),
      'competence'.padEnd(14),
      'comp_n'.padEnd(10),
      'integrity'.padEnd(14),
      'integ_n',
    );
    console.log('-'.repeat(72));

    for (const r of results) {
      const c =
        r.competence.score !== null ? r.competence.score.toFixed(4) : 'null (no data)';
      const i =
        r.integrity.score !== null ? r.integrity.score.toFixed(4) : 'null (no data)';
      console.log(
        r.agentName.padEnd(20),
        c.padEnd(14),
        String(r.competence.n).padEnd(10),
        i.padEnd(14),
        String(r.integrity.n),
      );
    }

    console.log('');
    console.log('[dual-band] Sample complete. Dry-run =', results[0]?.dryRun ?? true);
  })().catch((err) => {
    console.error('[dual-band] Fatal:', err);
    process.exit(1);
  });
}
