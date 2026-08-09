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
 * The canonical keys when a statement ALSO carries its ERC-8004 token binding: the
 * base four PLUS `erc8004_token_id`. This is the extended shape that lets a verifier
 * read WHICH token a proof is about straight from the proof statement — closing the
 * "proof → token needs the server DB" gap (see `erc8004-linkage.ts` module header).
 *
 * IMPORTANT — this shape is OPT-IN and not yet fully in-ZK. The deployed WASM verifier
 * (`@hyperdag/proof-verifier@0.2.0`) parses exactly the four `REQUIRED_STATEMENT_KEYS`;
 * `erc8004_token_id` becomes a checkable-in-ZK binding only once the external Plonky3
 * circuit treats it as a PUBLIC INPUT and the verifier struct gains the field. Until
 * then it is an in-repo statement-level binding: explicit and checkable off-chain, but
 * a server could still attach the wrong token to raw proof bytes. `buildBoundStatement`
 * therefore emits the 4-key shape by DEFAULT and only appends `erc8004_token_id` when a
 * caller explicitly supplies it — the live drain does not.
 */
export const TOKEN_BOUND_STATEMENT_KEYS = [...REQUIRED_STATEMENT_KEYS, 'erc8004_token_id'] as const;

/** `erc8004_token_id` is a uint256 minted token, stored as a decimal string. */
const ERC8004_TOKEN_ID_RE = /^\d+$/;
/** An EVM address the registry associates with the token (0x + 40 hex). */
const ERC8004_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
  | 'STATEMENT_UNBOUND'
  | 'INVALID_ERC8004_TOKEN_ID'
  | 'INVALID_ERC8004_ADDRESS';

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
  /**
   * Optional ERC-8004 token id (uint256 decimal string) to bind into the statement as
   * a FIRST-CLASS field. When present, the returned statement carries `erc8004_token_id`
   * alongside `agent_id`/`tier`/`repid_score`, so a verifier can read the token straight
   * from the proof and check `tokenURI(token_id) -> UUID == agent_id` WITHOUT the server's
   * DB mapping. Omit it (the default) and the statement is the canonical 4-key shape the
   * deployed WASM verifier parses — see `TOKEN_BOUND_STATEMENT_KEYS` for why this is
   * opt-in and not yet fully in-ZK.
   */
  erc8004TokenId?: string | null;
  /**
   * Optional ERC-8004 address the registry associates with the token (0x+40 hex, stored
   * lowercased). Bound as `erc8004_address` when present. Secondary to the token id — a
   * server-minted token is owned by a shared deployer wallet, so the address alone does
   * not discriminate the agent (see `erc8004-linkage` residual C).
   */
  erc8004Address?: string | null;
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

  const statement: Record<string, unknown> = {
    agent_id: agentId,
    tier,
    // Stored raw (unclamped, unrounded) — the statement attests to the score as read.
    repid_score: args.repidScore,
    threshold: args.threshold,
  };

  // Optional ERC-8004 token binding — first-class fields so a verifier maps proof → token
  // without the server. Validated fail-closed: a malformed token/address THROWS rather than
  // silently drop the binding, so a caller that intends to bind cannot end up with an
  // unbound statement it believes is bound. Absent args leave the canonical 4-key shape.
  if (args.erc8004TokenId !== undefined && args.erc8004TokenId !== null) {
    const tokenId = String(args.erc8004TokenId).trim();
    if (!ERC8004_TOKEN_ID_RE.test(tokenId)) {
      throw new UnboundProofStatementError(
        'INVALID_ERC8004_TOKEN_ID',
        'erc8004TokenId must be a uint256 decimal string (the minted token id)',
        { erc8004TokenId: args.erc8004TokenId }
      );
    }
    statement.erc8004_token_id = tokenId;
  }
  if (args.erc8004Address !== undefined && args.erc8004Address !== null) {
    const addr = String(args.erc8004Address).trim();
    if (!ERC8004_ADDRESS_RE.test(addr)) {
      throw new UnboundProofStatementError(
        'INVALID_ERC8004_ADDRESS',
        'erc8004Address must be an EVM address (0x + 40 hex)',
        { erc8004Address: args.erc8004Address }
      );
    }
    // Lowercased so a checksummed and an all-lowercase form of one address bind
    // identically — an address differs only in case, never in meaning.
    statement.erc8004_address = addr.toLowerCase();
  }

  return statement;
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

/**
 * TOKEN-BOUND predicate. A statement is token-bound iff it is agent-bound AND carries a
 * well-formed `erc8004_token_id`. This is the shape a verifier can map to an on-chain
 * token WITHOUT the server's DB — the linkage verifier (`verifyProofLinksToToken`) reads
 * the token straight from such a statement and drops the "which token? ask the server"
 * residual accordingly.
 */
export function isStatementTokenBound(statement: unknown): statement is Record<string, unknown> {
  if (!isStatementBound(statement)) return false;
  const s = statement as Record<string, unknown>;
  return typeof s.erc8004_token_id === 'string' && ERC8004_TOKEN_ID_RE.test(s.erc8004_token_id);
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
