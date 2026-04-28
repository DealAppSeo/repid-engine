/**
 * Anonymous round runner — single-call demo flow.
 *
 * The live demo at /reponomics-live/ needs ONE button that:
 *   1. starts a trading round (APM ↔ VERITAS each place a bet)
 *   2. waits ~2 seconds (so the visitor sees the "in progress" state)
 *   3. force-resolves the round (the spec's resolveOpenRounds with force:true)
 *   4. returns a single response showing both agents' RepID before/after
 *      and the audit-chain rows that were emitted
 *
 * Sean's signature gate on /trader/round/start is preserved at the
 * route layer for direct callers. This anonymous wrapper computes its
 * OWN gate-equivalent — the visitor doesn't need to know SEAN_SIG_SECRET;
 * the server holds it. That's the whole point of the wrapper.
 *
 * Per CLAUDE-RULE-4: every response is_simulated=true (the on-chain
 * settlement, oracle outcome, and Plonky3 proof are all stubbed). The
 * RepID/Wisdom/Character updates ARE real — they hit Supabase.
 */

import { db } from '../db';
import { startTradingRound, resolveOpenRounds, APM_AGENT_NAME, VERITAS_AGENT_NAME } from './agent-trader';
import { emitAuditEvent } from './audit-emit';

export interface AnonRoundAgentSnapshot {
  agent_id: string;
  name: string;
  repid_before: number;
  repid_after: number;
  delta: number;
  wisdom_after: number;
  character_after: number;
}

export interface AnonRoundAuditEntry {
  id: number;
  event_type: string | null;
  source_table: string;
  created_at: string;
}

export interface RunRoundAnonymousResult {
  ok: boolean;
  round_id: string | null;
  apm: AnonRoundAgentSnapshot | null;
  veritas: AnonRoundAgentSnapshot | null;
  audit_entries: AnonRoundAuditEntry[];
  is_simulated: true;
  notes: string;
  error?: string;
}

interface AgentRow {
  id: string;
  agent_name: string;
  current_repid: number;
  wisdom_score: number | null;
  character_score: number | null;
}

async function fetchAgent(name: string): Promise<AgentRow | null> {
  const { data } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score')
    .eq('agent_name', name)
    .maybeSingle();
  return (data as AgentRow | null) ?? null;
}

function makeSnapshot(before: AgentRow | null, after: AgentRow | null): AnonRoundAgentSnapshot | null {
  if (!before || !after) return null;
  const beforeR = Number(before.current_repid ?? 0);
  const afterR = Number(after.current_repid ?? 0);
  return {
    agent_id: after.id,
    name: after.agent_name,
    repid_before: beforeR,
    repid_after: afterR,
    delta: afterR - beforeR,
    wisdom_after: Number(after.wisdom_score ?? 1000),
    character_after: Number(after.character_score ?? 1000),
  };
}

async function fetchRecentAuditForRound(roundId: string, sinceIso: string, limit = 25): Promise<AnonRoundAuditEntry[]> {
  // The audit chain pulls every event since the round was started so the
  // demo page can replay the lifecycle (round_started → bet_placed ×2 →
  // bet_resolved ×2 → wisdom/character/builder recompute).
  const { data } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, created_at')
    .gte('created_at', sinceIso)
    .order('id', { ascending: true })
    .limit(limit);
  const rows = (data ?? []) as Array<{ id: number; source_table: string; event_payload: any; created_at: string }>;
  return rows.map(r => ({
    id: r.id,
    event_type: typeof r.event_payload?.event_type === 'string' ? r.event_payload.event_type : null,
    source_table: r.source_table,
    created_at: r.created_at,
  }));
}

export interface RunRoundAnonymousOptions {
  /** Wait between start + resolve so the demo page can show "running…". v0.1 default 2s; tests inject 0. */
  waitMs?: number;
}

export async function runRoundAnonymous(opts: RunRoundAnonymousOptions = {}): Promise<RunRoundAnonymousResult> {
  const startedAtIso = new Date().toISOString();

  // Snapshot APM and VERITAS BEFORE the round.
  const apmBefore = await fetchAgent(APM_AGENT_NAME);
  const veritasBefore = await fetchAgent(VERITAS_AGENT_NAME);

  if (!apmBefore || !veritasBefore) {
    return {
      ok: false,
      round_id: null,
      apm: null,
      veritas: null,
      audit_entries: [],
      is_simulated: true,
      notes: 'APM or VERITAS not seeded — apply 20260427_seed_two_builder_demo.sql first',
      error: 'fleet agents missing',
    };
  }

  // Start the round. startTradingRound bypasses the Sean-signature gate
  // because we call it directly server-side.
  const round = await startTradingRound();
  if (!round.ok || !round.round_id) {
    return {
      ok: false,
      round_id: null,
      apm: null,
      veritas: null,
      audit_entries: [],
      is_simulated: true,
      notes: round.error ?? 'startTradingRound failed',
      error: round.error,
    };
  }

  // Optional wait so the UI can paint a "running…" state.
  const wait = opts.waitMs ?? 2000;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  // Force-resolve so the visitor doesn't wait 4 hours.
  await resolveOpenRounds({ force: true });

  // Snapshot AFTER.
  const apmAfter = await fetchAgent(APM_AGENT_NAME);
  const veritasAfter = await fetchAgent(VERITAS_AGENT_NAME);

  const audit_entries = await fetchRecentAuditForRound(round.round_id, startedAtIso);

  await emitAuditEvent({
    event_type: 'demo_anonymous_round_completed',
    source_table: 'trading_rounds',
    source_id: round.round_id,
    payload: {
      round_id: round.round_id,
      apm_delta: (apmAfter?.current_repid ?? 0) - (apmBefore.current_repid ?? 0),
      veritas_delta: (veritasAfter?.current_repid ?? 0) - (veritasBefore.current_repid ?? 0),
      is_simulated: true,
    },
  });

  return {
    ok: true,
    round_id: round.round_id,
    apm: makeSnapshot(apmBefore, apmAfter),
    veritas: makeSnapshot(veritasBefore, veritasAfter),
    audit_entries,
    is_simulated: true,
    notes: 'SIMULATED: oracle outcome is deterministic mock; Plonky3 proof is HMAC stub; on-chain settlement is off-chain DB updates.',
  };
}
