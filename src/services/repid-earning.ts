/**
 * RepID Earning Service — paper-trade outcome → RepID delta
 *
 * Reads a closed paper trade from `trade_execution_log`, scores its outcome,
 * writes an audit row to `repid_score_events`, and updates
 * `repid_agents.current_repid` (the `trg_sync_tier` trigger handles tier).
 *
 * SCHEMA NOTES (verified via Supabase MCP 2026-05-11):
 *   - `trade_execution_log` has NO `status` / `closed_at` / `agent_id (uuid)`.
 *     Each row IS a closed trade. Identifier is `agent_name` (text), pnl is
 *     `pnl_realized` (numeric), notional is `amount_usd` (numeric).
 *   - Canonical RepID audit log per CLAUDE.md is `repid_score_events`
 *     (NOT the legacy `repid_events` referenced colloquially in the sprint).
 *   - `repid_agents.tier` is trigger-derived from `current_repid` via
 *     `trg_sync_tier`. We write only `current_repid`; the trigger updates `tier`.
 *   - `current_repid` is clamped to [10, 10000] by app convention; the DB
 *     CHECK constraint will reject out-of-range values.
 */

import { db } from '../db';

export interface ScoreOutcome {
  delta: number;
  reason: string;
  pnlPct: number | null;
}

export interface RecordOutcomeResult {
  event_id: number;
  delta: number;
  repid_before: number;
  repid_after: number;
  agent_id: string;
  agent_name: string;
  reason: string;
  skipped?: 'already_scored' | 'agent_not_found' | 'trade_not_found';
}

const REPID_MIN = 10;
const REPID_MAX = 10000;

/**
 * Score a single trade row's outcome.
 * Pure function over the row shape — easy to unit test.
 *
 * Sprint 3 amendment: the original Sprint 2 implementation tested the
 * decision string against `'veto'/'reject'/'no_action'/'hal_block'` —
 * but production data (verified via Supabase MCP 2026-05-11) uses
 * `'REFUSED'` (2,519 rows from trinity-ecosystem trade_pipeline.ts) and
 * `'EXECUTE'/'EXECUTED'` (15 rows from various paths). We now recognize
 * these explicitly and score them per the existing-architecture reality:
 *   - REFUSED  → constitutional refusal → +2 (same as HAL veto)
 *   - EXECUTE/EXECUTED with no pnl → intent signed but not settled → +1
 *     (small earn — agent decided decisively; settlement is a separate
 *     pipeline stage that doesn't exist for v1, see Sprint 3 report)
 *   - null pnl with no recognizable decision → -5 (timeout / lost signal)
 */
export function scoreTrade(row: {
  pnl_realized: number | null;
  amount_usd: number | null;
  decision: string | null;
  executed_at: string | null;
  execution_mode?: string | null;
}): ScoreOutcome {
  const dec = (row.decision ?? '').toLowerCase();

  // 1. Constitutional refusal / HAL veto — agent declined to trade
  // Matches the trinity-sophia trade_pipeline.ts dominant pattern (REFUSED),
  // plus the older 'veto'/'reject'/'hal_block' shapes we saw earlier.
  const isRefusal =
    row.pnl_realized == null &&
    (dec === 'refused' || dec.includes('veto') || dec.includes('reject') ||
     dec.includes('no_action') || dec.includes('hal_block'));
  if (isRefusal) {
    return { delta: +2, reason: 'constitutional_refusal_or_hal_veto', pnlPct: null };
  }

  // 2. EXECUTE/EXECUTED intent with no settlement data — small earn for
  // decisiveness. The current architecture (trade_pipeline.ts) signs an
  // intent but does not place a real order; pnl_realized is null by
  // design. When/if a fill resolver lands (see Sprint 3 trade-resolver
  // proposal), this branch becomes unreachable for resolved trades.
  const isUnresolvedExecute =
    row.pnl_realized == null &&
    (dec === 'execute' || dec === 'executed');
  if (isUnresolvedExecute) {
    return { delta: +1, reason: 'execute_intent_signed_unresolved', pnlPct: null };
  }

  // 3. Trade closed without P&L AND no recognizable decision context: log + dock
  if (row.pnl_realized == null) {
    return { delta: -5, reason: 'no_pnl_recorded', pnlPct: null };
  }

  const notional = row.amount_usd && row.amount_usd > 0 ? row.amount_usd : null;
  const pnlPct = notional != null ? (row.pnl_realized / notional) * 100 : null;

  if (row.pnl_realized > 0) {
    // Profit
    if (pnlPct != null && pnlPct > 2) {
      return { delta: +15, reason: `profit_${pnlPct.toFixed(2)}pct`, pnlPct };
    }
    return { delta: +5, reason: `profit_small${pnlPct != null ? `_${pnlPct.toFixed(2)}pct` : ''}`, pnlPct };
  }

  // Loss branch
  const absPct = pnlPct != null ? Math.abs(pnlPct) : null;
  if (absPct != null && absPct > 5) {
    return { delta: -20, reason: `loss_severe_${absPct.toFixed(2)}pct`, pnlPct };
  }
  if (absPct != null && absPct > 2) {
    return { delta: -10, reason: `loss_${absPct.toFixed(2)}pct`, pnlPct };
  }
  return { delta: -3, reason: `loss_small${absPct != null ? `_${absPct.toFixed(2)}pct` : ''}`, pnlPct };
}

export class RepIdEarningService {
  /**
   * Compute (but do not write) the outcome score for a trade.
   * Useful for previews / dry-run / tests.
   */
  async scoreTradeOutcome(tradeId: number): Promise<ScoreOutcome | { error: string }> {
    const { data: row, error } = await db
      .from('trade_execution_log')
      .select('id, agent_name, pnl_realized, amount_usd, decision, executed_at, execution_mode')
      .eq('id', tradeId)
      .maybeSingle();
    if (error) return { error: `trade_lookup_failed: ${error.message}` };
    if (!row) return { error: 'trade_not_found' };
    return scoreTrade(row as any);
  }

  /**
   * Record outcome: insert audit row in repid_score_events + update
   * repid_agents.current_repid. Idempotent via metadata->>'trade_id' check.
   *
   * Returns skipped='already_scored' if a previous run already recorded this trade.
   */
  async recordOutcome(tradeId: number): Promise<RecordOutcomeResult | { skipped: string; reason: string }> {
    // 1. Fetch trade
    const { data: trade, error: tradeErr } = await db
      .from('trade_execution_log')
      .select('id, agent_name, pnl_realized, amount_usd, decision, executed_at, execution_mode')
      .eq('id', tradeId)
      .maybeSingle();
    if (tradeErr) throw new Error(`trade_lookup_failed: ${tradeErr.message}`);
    if (!trade) return { skipped: 'trade_not_found', reason: `trade ${tradeId} does not exist` };
    if (!trade.agent_name) return { skipped: 'no_agent_name', reason: `trade ${tradeId} has null agent_name` };

    // 2. Resolve agent UUID by name
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid')
      .eq('agent_name', trade.agent_name)
      .maybeSingle();
    if (agentErr) throw new Error(`agent_lookup_failed: ${agentErr.message}`);
    if (!agent) return { skipped: 'agent_not_found', reason: `no repid_agents row for agent_name='${trade.agent_name}'` };

    // 3. Idempotency check — has this trade already been scored?
    const idempKey = `paper_trade:${tradeId}`;
    const { data: existing } = await db
      .from('repid_score_events')
      .select('id')
      .eq('idempotency_key', idempKey)
      .maybeSingle();
    if (existing) {
      return { skipped: 'already_scored', reason: `repid_score_events.id=${existing.id} exists for ${idempKey}` };
    }

    // 4. Score it
    const outcome = scoreTrade(trade as any);
    const before: number = agent.current_repid ?? 0;
    const after = Math.max(REPID_MIN, Math.min(REPID_MAX, before + outcome.delta));
    const appliedDelta = after - before;

    // 5. Insert audit row
    const { data: inserted, error: insertErr } = await db
      .from('repid_score_events')
      .insert({
        agent_id: agent.id,
        event_type: 'paper_trade_outcome',
        delta: appliedDelta,
        repid_before: before,
        repid_after: after,
        repid_delta_calculated: outcome.delta,
        repid_delta_applied: appliedDelta,
        idempotency_key: idempKey,
        metadata: {
          trade_id: tradeId,
          agent_name: trade.agent_name,
          pnl_realized: trade.pnl_realized,
          amount_usd: trade.amount_usd,
          pnl_pct: outcome.pnlPct,
          reason: outcome.reason,
          source: 'paper_trading',
          decision: trade.decision,
          execution_mode: trade.execution_mode,
        },
      })
      .select('id')
      .single();
    if (insertErr) throw new Error(`event_insert_failed: ${insertErr.message}`);

    // 6. Update agent current_repid (trg_sync_tier handles tier automatically)
    if (appliedDelta !== 0) {
      const { error: updateErr } = await db
        .from('repid_agents')
        .update({ current_repid: after, last_updated: new Date().toISOString() })
        .eq('id', agent.id);
      if (updateErr) {
        // Non-fatal: event row is the audit-of-record. Surface for monitoring.
        console.warn(
          `[repid-earning] event ${inserted.id} written but agent update failed: ${updateErr.message}`
        );
      }
    }

    return {
      event_id: inserted.id,
      delta: appliedDelta,
      repid_before: before,
      repid_after: after,
      agent_id: agent.id,
      agent_name: trade.agent_name,
      reason: outcome.reason,
    };
  }
}

export const repidEarning = new RepIdEarningService();
