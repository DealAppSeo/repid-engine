/**
 * Live public stats for TrustShell.dev — real numbers only (Trinity 12 + is_real proofs).
 * Hot-path reads via pgQuery; ~10s edge cache in route layer.
 */
import { pgQuery } from '../db/direct-pg';
import { MOCK_AGENT_EXCLUSION_SQL, TRINITY_12_AGENT_NAMES } from '../constants/public-surfaces';

export interface LiveStatsPayload {
  agents_minted: number;
  real_proofs: number;
  credentials_issued: number;
  total_repid: number;
  /**
   * Settlements in the last 7 days, NOW filtered to real (non-simulated) ones.
   * It answers "is anything happening this week" — a LIVENESS signal.
   * It is NOT an achievement count. See full_harness_loops.
   */
  recent_settlements: number;
  /**
   * THE number for any trust claim: a contract that reached `settled` AND has a
   * non-simulated settlement with a real tx_hash. Everything else overstates.
   *
   * Added 2026-08-01 because "2", "3" and "39" were all in use for the same
   * claim and all three were true of different questions — 36 of the 39 real
   * settlements predate the A2A contract path and are not harness loops at all.
   * Quoting 39 as "trust loops" would have overstated by 13x.
   */
  full_harness_loops: number;
  last_updated: string;
  notes?: {
    realtime_hint?: string;
    stub_proofs_excluded?: number;
  };
}

export async function fetchLiveStats(): Promise<LiveStatsPayload> {
  const trinityList = TRINITY_12_AGENT_NAMES;

  const [minted, proofs, creds, repid, settlements, loops, stubs] = await Promise.all([
    pgQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM repid_agents
       WHERE agent_name = ANY($1::text[])
         AND erc8004_token_id IS NOT NULL
         AND ${MOCK_AGENT_EXCLUSION_SQL}`,
      [trinityList],
      { label: 'stats-agents-minted' }
    ),
    pgQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM repid_zkp_proofs WHERE is_real = true`,
      [],
      { label: 'stats-real-proofs' }
    ),
    pgQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM repid_credentials`,
      [],
      { label: 'stats-credentials' }
    ),
    pgQuery<{ total: number }>(
      `SELECT COALESCE(SUM(current_repid), 0)::int AS total FROM repid_agents
       WHERE agent_name = ANY($1::text[])
         AND ${MOCK_AGENT_EXCLUSION_SQL}`,
      [trinityList],
      { label: 'stats-total-repid' }
    ),
    pgQuery<{ n: number }>(
      // Liveness. Simulated rows are excluded — a simulated settlement moved no
      // money and must never inflate a public counter.
      `SELECT count(*)::int AS n FROM x402_settlements
       WHERE created_at > now() - interval '7 days'
         AND is_simulated = false
         AND tx_hash IS NOT NULL`,
      [],
      { label: 'stats-recent-settlements' }
    ),
    pgQuery<{ n: number }>(
      // The claim-grade number: settled contract + real money. Both halves
      // required, because either alone is a different and weaker statement.
      `SELECT count(*)::int AS n
         FROM service_contracts c
         JOIN x402_settlements s ON s.idempotency_key = c.id::text
        WHERE c.status = 'settled'
          AND s.is_simulated = false
          AND s.tx_hash IS NOT NULL`,
      [],
      { label: 'stats-full-harness-loops' }
    ),
    pgQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM repid_zkp_proofs WHERE is_real IS NOT TRUE`,
      [],
      { label: 'stats-stub-proofs' }
    ),
  ]);

  return {
    agents_minted: minted[0]?.n ?? 0,
    real_proofs: proofs[0]?.n ?? 0,
    credentials_issued: creds[0]?.n ?? 0,
    total_repid: repid[0]?.total ?? 0,
    recent_settlements: settlements[0]?.n ?? 0,
    full_harness_loops: loops[0]?.n ?? 0,
    last_updated: new Date().toISOString(),
    notes: {
      realtime_hint:
        'Supabase Realtime on repid_score_events INSERT + erc8004 mint events can push live ticks to TrustShell installs/mints without polling.',
      stub_proofs_excluded: stubs[0]?.n ?? 0,
    },
  };
}