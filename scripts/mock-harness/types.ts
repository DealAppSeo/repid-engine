/**
 * CC Sprint 9 — Mock harness shared types.
 *
 * Mock agents use the `mock-` prefix in agent_name for unambiguous
 * identification and bulk cleanup. They live in repid_agents alongside
 * the 4 real spokespersons (SOPHIA/VERITAS/SHOFET/CHESED) — but they're
 * deletable; real spokespersons are not.
 */

export type BehaviorProfile =
  | 'constitutional'  // mostly REFUSES uncertain trades (+2 per refusal)
  | 'aggressive'     // EXECUTES most opportunities, mixed P&L
  | 'uncertain'      // randomly EXECUTE/REFUSED with low confidence
  | 'veto_heavy'     // REFUSES with strong rationale (HAL-aligned)
  | 'trade_happy';   // EXECUTES everything; high variance scoring

export type AgentDecision = 'REFUSED' | 'EXECUTE' | 'ESCALATE';

export interface MockAgentState {
  agent_id: string;        // UUID, generated at bootstrap
  agent_name: string;      // 'mock-<scenario>-<slot>' (e.g., 'mock-buyer-001')
  current_repid: number;   // starts at 500 (EARNING tier)
  tier: string;            // computed by trg_sync_tier on write
  behavior_profile: BehaviorProfile;
}

export interface DecisionPayload {
  decision: AgentDecision;
  confidence: number;        // 0..1
  reasoning: string;         // short English rationale
  asset?: string;            // 'BTC' / 'ETH' etc.
  pair?: string;             // 'BTC/USD'
  amount_usd?: number;
}

export interface TradeOutcome {
  trade_id: number;          // trade_execution_log.id
  agent_name: string;
  decision: AgentDecision;
  pnl_realized: number | null; // numeric for executed trades; null for REFUSED
  reason: string;
}
