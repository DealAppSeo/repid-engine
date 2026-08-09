/**
 * proof-statement-guard.ts — fail-closed builder/validator for the PUBLIC STATEMENT
 * that every real proof row must carry.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS — the corpus-hygiene finding this closes
 * ════════════════════════════════════════════════════════════════════════════════
 * [V SQL 2026-08-08] Of 22,239 `is_real=true` rows in `repid_zkp_proofs`, 7,958 carry
 * a statement of the shape `{ repid_score, threshold }` — NO `agent_id`, NO `tier`,
 * and a `repid_score` that defaulted to 1000. Those rows are unbound: the proof is not
 * tied to any agent, so it certifies nothing, yet it inflated the "real proof" count.
 * The honest real-agent-bound count is ~14,281.
 *
 * The `@hyperdag/proof-verifier` WASM tool ALSO rejects the 2-key shape: with `agent_id`
 * omitted it returns "missing field `agent_id`", with `tier` omitted "missing field
 * `tier`". So an unbound statement is not merely under-specified — it is, as stored,
 * unverifiable by the very tool the project publishes.
 *
 * The root cause is the producer: `proof-drain-service.ts` assembled the statement inline
 * as `{ repid_score, threshold }`. `zkp-audit-service.ts` already assembled the correct
 * 4-key statement. This module is the ONE place both paths now go through, so a statement
 * cannot be built without its agent binding again.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAIL-CLOSED CONTRACT
 * ════════════════════════════════════════════════════════════════════════════════
 * `buildBoundStatement` THROWS (`UnboundProofStatementError`) rather than return an
 * agent-less statement. In the drain path a throw propagates to `markFailed`, so the job
 * fails and NO unbound proof is persisted — "no agent binding => no proof". The only
 * escape hatch is an EXPLICIT synthetic marker (`allowSynthetic`), used by test/synthetic
 * fixtures, never by the live drain.
 *
 * The four keys are exactly what the WASM verifier parses — nothing more. Extra keys are
 * a needless deserialisation risk against its fixed struct (same doctrine as
 * `zkp-audit-service.ts`).
 */

/** The four keys `@hyperdag/proof-verifier@0.2.0` hard-requires, in canonical order. */
export const REQUIRED_STATEMENT_KEYS = ['agent_id', 'tier', 'repid_score', 'threshold'] as const;

/**
 * The only agent id permitted to stand in for a real one, and only when the caller
 * OPTS IN via `allowSynthetic`. Matches the synthetic-fixture convention (all-zero uuid).
 * A live drain never uses this; it is here so a test corpus can be built deliberately
 * rather than by accident.
 */
export const SYNTHETIC_AGENT_ID = '00000000-0000-0000-0000-000000000000';

/** Canonical tier bands (CLAUDE.md). Score clamp is [10, 10000]. Kept identical to
 * `zkp-audit-service.deriveTier` so a statement built by either path derives the same
 * tier from the same score. */
const TIER_BANDS: ReadonlyArray<{ max: number; tier: string }> = [
  { max: 499, tier: 'PROBATIONARY' },
  { max: 999, tier: 'EARNING' },
  { max: 4999, tier: 'ESTABLISHED' },
  { max: 7999, tier: 'AUTONOMOUS' },
  { max: Number.POSITIVE_INFINITY, tier: 'VETERAN' },
];

export type UnboundStatementReason =
  | 'MISSING_AGENT_ID'
  | 'SYNTHETIC_AGENT_ID'
  | 'MISSING_TIER'
  | 'MISSING_SCORE'
  | 'MISSING_THRESHOLD'
  | 'STATEMENT_UNBOUND';

export class UnboundProofStatementError extends Error {
  public readonly reason: UnboundStatementReason;
  public readonly detail: Record<string, unknown>;
  constructor(reason: UnboundStatementReason, message: string, detail: Record<string, unknown> = {}) {
    super(`proof-statement-guard[${reason}]: ${message}`);
    this.name = 'UnboundProofStatementError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Canonical tier from a RepID score. DERIVED, never trusted from a caller-supplied
 * `tier` field: the tier carries no cryptographic authority (substituting a wrong tier
 * into a statement still verifies), so it is recomputed from the score here.
 */
export function deriveStatementTier(score: number): string {
  const s = Math.max(10, Math.min(10000, Math.round(score)));
  for (const band of TIER_BANDS) {
    if (s <= band.max) return band.tier;
  }
  return 'VETERAN';
}

/** True iff `agentId` is the explicit synthetic sentinel. */
export function isSyntheticAgentId(agentId: unknown): boolean {
  return typeof agentId === 'string' && agentId.trim() === SYNTHETIC_AGENT_ID;
}

export interface BoundStatementArgs {
  /** The agent the proof is ABOUT. A real, non-empty id — or the synthetic sentinel
   * only when `allowSynthetic` is true. */
  agentId: string | null | undefined;
  /** The live RepID score the proof attests to. Must be a finite number the caller
   * actually fetched — not left to default. */
  repidScore: number | null | undefined;
  /** The threshold the prover proved (`score > threshold`). Non-negative finite. */
  threshold: number | null | undefined;
  /** Optional explicit tier; derived from `repidScore` when omitted or blank. */
  tier?: string | null;
  /**
   * When true, permits `SYNTHETIC_AGENT_ID` to pass the agent-binding gate. Reserved
   * for test/synthetic fixtures. A live drain must NEVER set this.
   */
  allowSynthetic?: boolean;
}

/**
 * Assemble the COMPLETE, agent-bound public statement — or throw.
 *
 * Fail-closed: a missing/blank `agent_id`, the synthetic sentinel without opt-in, a
 * non-finite score, or a bad threshold each throw `UnboundProofStatementError`. The
 * returned object has exactly the four canonical keys, so it round-trips through the
 * WASM verifier's fixed struct.
 */
export function buildBoundStatement(args: BoundStatementArgs): Record<string, unknown> {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  if (agentId.length === 0) {
    throw new UnboundProofStatementError(
      'MISSING_AGENT_ID',
      'refusing to build an agent-less proof statement — no agent binding, no proof',
      { agentId: args.agentId ?? null }
    );
  }
  if (agentId === SYNTHETIC_AGENT_ID && args.allowSynthetic !== true) {
    throw new UnboundProofStatementError(
      'SYNTHETIC_AGENT_ID',
      'agent id is the synthetic sentinel; set allowSynthetic to mint a deliberately synthetic statement',
      { agentId }
    );
  }
  if (typeof args.repidScore !== 'number' || !Number.isFinite(args.repidScore)) {
    throw new UnboundProofStatementError(
      'MISSING_SCORE',
      'refusing to build a statement without a live, finite repid_score (a defaulted score is not a measurement)',
      { repidScore: args.repidScore ?? null }
    );
  }
  if (typeof args.threshold !== 'number' || !Number.isFinite(args.threshold) || args.threshold < 0) {
    throw new UnboundProofStatementError(
      'MISSING_THRESHOLD',
      'refusing to build a statement without a non-negative finite threshold',
      { threshold: args.threshold ?? null }
    );
  }

  const tier =
    typeof args.tier === 'string' && args.tier.trim().length > 0
      ? args.tier.trim()
      : deriveStatementTier(args.repidScore);

  return {
    agent_id: agentId,
    tier,
    // Stored raw (unclamped, unrounded) — the statement attests to the score as read.
    repid_score: args.repidScore,
    threshold: args.threshold,
  };
}

/**
 * STATEMENT-BOUND predicate. A statement is bound iff all four keys are present and
 * neither `agent_id` nor `tier` is null/blank. This is the exact negation of the 7,958
 * unbound rows' `{ repid_score, threshold }` shape.
 */
export function isStatementBound(statement: unknown): statement is Record<string, unknown> {
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return false;
  const s = statement as Record<string, unknown>;
  for (const k of REQUIRED_STATEMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(s, k) || s[k] === undefined || s[k] === null) return false;
  }
  if (typeof s.agent_id !== 'string' || s.agent_id.trim().length === 0) return false;
  if (typeof s.tier !== 'string' || s.tier.trim().length === 0) return false;
  return true;
}

/** Assert a statement is bound; throw `UnboundProofStatementError` if not. */
export function assertStatementBound(statement: unknown): asserts statement is Record<string, unknown> {
  if (!isStatementBound(statement)) {
    throw new UnboundProofStatementError(
      'STATEMENT_UNBOUND',
      'statement is missing its agent binding (agent_id + tier) — it certifies nothing',
      { statement: statement ?? null }
    );
  }
}
