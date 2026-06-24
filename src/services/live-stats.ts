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
  recent_settlements: number;
  last_updated: string;
  notes?: {
    realtime_hint?: string;
    stub_proofs_excluded?: number;
  };
}

export async function fetchLiveStats(): Promise<LiveStatsPayload> {
  const trinityList = TRINITY_12_AGENT_NAMES;

  const [minted, proofs, creds, repid, settlements, stubs] = await Promise.all([
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
      `SELECT count(*)::int AS n FROM x402_settlements
       WHERE created_at > now() - interval '7 days'`,
      [],
      { label: 'stats-recent-settlements' }
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
    last_updated: new Date().toISOString(),
    notes: {
      realtime_hint:
        'Supabase Realtime on repid_score_events INSERT + erc8004 mint events can push live ticks to TrustShell installs/mints without polling.',
      stub_proofs_excluded: stubs[0]?.n ?? 0,
    },
  };
}