/**
 * ledger-provenance.ts — what actually backs a RepID score.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE QUESTION AN AUDITOR ASKS FIRST
 * ════════════════════════════════════════════════════════════════════════════════
 * Not "what is the number" — "WHO CAN MINT IT, AND FROM WHAT?" Every reputation
 * system answers that question whether or not it means to. Today `repid_score_events`
 * answers it badly, not because the data is missing but because nothing reads it:
 *
 *   30,200 score events in 30 days [V sql 2026-08-04]
 *   29,906 (99.03%) are HAL_SCORE_EVENT — the engine scoring its own agents
 *      286 (0.95%)  are economic (SERVICE_FULFILLED / SERVICE_SATISFIED)
 *
 * and the net movement inverts that ratio: the 99% moved scores by −245 in total,
 * while the 0.95% moved them by +3,086. **99% of the volume produces ~7% of the
 * signal.** An auditor who samples the ledger sees self-generated noise and stops
 * reading. The real economic history — every event traceable to a settlement and an
 * on-chain write — is buried under 100x its volume in engine churn.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE FIX IS CLASSIFICATION, NOT CONCEALMENT
 * ════════════════════════════════════════════════════════════════════════════════
 * The tempting move is to filter the churn out of the public surface. That is the
 * wrong instinct and it fails the audit worse: an auditor who discovers you hid a
 * category trusts nothing else you present. Hiding also destroys the single most
 * useful property of an append-only ledger — that it accounts for everything.
 *
 * So every event keeps its place and gains a PROVENANCE CLASS, and the public
 * surface states the decomposition outright: this much of the score is backed by a
 * counterparty, this much by an on-chain artifact, this much is self-asserted, this
 * much is the engine scoring itself. A number you can decompose is worth more than
 * a bigger number you cannot.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * CLASSIFY ON EVIDENCE, NOT ON THE EVENT'S OWN LABEL
 * ════════════════════════════════════════════════════════════════════════════════
 * `event_type` is caller-supplied. Trusting it to describe its own trustworthiness
 * is circular — it is exactly the field an attacker controls. So the class is
 * derived from columns that a caller CANNOT set by assertion, in descending order
 * of how hard they are to forge:
 *
 *   contract_id          a two-party service contract exists in the DB
 *   eas_attestation_id   an attestation was anchored on-chain
 *   economic_impact_usdc real value moved
 *   metadata.evidence.ref a co-sign / artifact / tx reference was supplied
 *
 * `event_type` is consulted ONLY to separate engine-internal scoring from
 * caller-submitted claims — never to upgrade an event's trust.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY `self_reported` IS ITS OWN CLASS AND MUST STAY VISIBLE
 * ════════════════════════════════════════════════════════════════════════════════
 * `repid-update.ts:84-90` states it plainly: FIXED_DELTAS flow from a caller-supplied
 * eventType "with NO proof today — any API-key holder can self-award them on
 * POST /api/v1/score". CODE_CONTRIBUTION is +25, REFERRAL +20, AGENT_TEACHING +15.
 * The gate that would refuse an unproven claim (`SELF_REPORT_EVIDENCE_MODE`) exists
 * and defaults to off.
 *
 * MEASURED BEFORE ALARMING [V sql 2026-08-04]: across the entire ledger the
 * self-awardable types total **41 positive events and +156 RepID** — AGENT_TEACHING
 * (39, +126) and PEACEMAKER (2, +30). CODE_CONTRIBUTION, REFERRAL, STAKE,
 * WORKFLOW_CONTRIBUTION, TOOL_PIONEER, AUDIT_CONTRIBUTION have NEVER been used.
 * The surface is open and essentially unexploited.
 *
 * That is a far better position than it sounds, and it is the reason to surface the
 * class rather than quietly patch it: the append-only ledger can PROVE the hole was
 * never meaningfully used, which is a claim almost no reputation system can make
 * about its own weak spot. Concealing the class would throw that proof away.
 *
 * Pure functions over a row shape — no DB, no I/O, no clock — so the rule is
 * testable exhaustively and cannot drift from what the public surface reports.
 * ZERO DDL: every column read already exists (verified against information_schema,
 * not the generated types, which are stale by standing rule).
 */

export type ProvenanceClass =
  /** A second party's action caused it: a contract, a settlement, a counterparty verdict. */
  | 'counterparty_verified'
  /** Anchored on-chain (EAS attestation or ZK proof id). Strongest non-repudiable form. */
  | 'onchain_anchored'
  /** Caller asserted it AND supplied an evidence reference. Weaker than a counterparty. */
  | 'self_reported_with_evidence'
  /** Caller asserted it with nothing backing it. The class that must never be hidden. */
  | 'self_reported_unbacked'
  /** The engine scoring its own agents. Real, but not external evidence of anything. */
  | 'internal_scoring'
  /** Bootstrap / administrative adjustment. */
  | 'genesis'
  /** Shape we do not recognise. Never silently upgraded — see below. */
  | 'unclassified';

/**
 * Engine-generated scoring. These are NOT claims by anyone; they are the system
 * observing itself, and they dominate the ledger by volume.
 */
const INTERNAL_EVENT_TYPES = new Set(['HAL_SCORE_EVENT', 'HAL_SCORE', 'SCORE_MONITOR', 'DECAY']);

/** Bootstrap/admin. Separated so it never flatters the counterparty count. */
const GENESIS_EVENT_TYPES = new Set(['GENESIS', 'EPOCH_RESET', 'BASELINE']);

/**
 * Types payable straight from FIXED_DELTAS on a caller-supplied eventType, with no
 * proof required. Kept in sync with FIXED_DELTAS in engine/repid-update.ts.
 */
export const SELF_AWARDABLE_EVENT_TYPES = new Set([
  'STAKE', 'REFERRAL', 'PEACEMAKER', 'SELF_MONITOR', 'CODE_CONTRIBUTION',
  'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER', 'AGENT_TEACHING', 'AUDIT_CONTRIBUTION',
]);

/** The subset of columns this module reads. A row shape, not the whole table. */
export interface ScoreEventRow {
  event_type?: string | null;
  delta?: number | null;
  /** FK to service_contracts — a two-party agreement exists. */
  contract_id?: string | null;
  /** On-chain attestation id. */
  eas_attestation_id?: string | null;
  zk_proof_id?: string | null;
  zk_proof_triggered?: boolean | null;
  /** Real USDC moved. */
  economic_impact_usdc?: number | string | null;
  metadata?: Record<string, unknown> | null;
}

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/** Did the caller supply an evidence reference? (`evidence.ref`, per repid-update.ts) */
export function hasEvidenceRef(row: ScoreEventRow): boolean {
  const ev = (row.metadata ?? {})['evidence'];
  if (!ev || typeof ev !== 'object') return false;
  return hasText((ev as Record<string, unknown>)['ref']);
}

/**
 * Classify one event.
 *
 * Order is deliberate and is the whole security property: the hardest-to-forge
 * evidence is checked FIRST, and `event_type` is never allowed to upgrade a class.
 * An event claiming to be a settlement with no contract_id and no attestation is
 * classified on what it can prove, not on what it calls itself.
 */
export function classifyProvenance(row: ScoreEventRow): ProvenanceClass {
  const type = (row.event_type ?? '').trim().toUpperCase();

  // Engine-internal first: these are not claims and must never be counted as
  // external evidence, however they are otherwise decorated.
  if (INTERNAL_EVENT_TYPES.has(type)) return 'internal_scoring';
  if (GENESIS_EVENT_TYPES.has(type)) return 'genesis';

  // Hardest to forge: something exists on a public chain.
  if (hasText(row.eas_attestation_id) || hasText(row.zk_proof_id)) return 'onchain_anchored';

  // A counterparty was involved: a contract row, or value that actually moved.
  const usdc = Number(row.economic_impact_usdc ?? 0);
  if (hasText(row.contract_id) || (Number.isFinite(usdc) && usdc > 0)) {
    return 'counterparty_verified';
  }

  // Caller-submitted claim. Evidence ref is the only thing separating the two tiers.
  if (SELF_AWARDABLE_EVENT_TYPES.has(type)) {
    return hasEvidenceRef(row) ? 'self_reported_with_evidence' : 'self_reported_unbacked';
  }

  // Deliberately NOT defaulted to anything reassuring. An unrecognised shape is
  // reported as unclassified so a new event type shows up as a gap in the
  // decomposition rather than silently inheriting someone else's credibility.
  return 'unclassified';
}

/** True when this class represents evidence a third party could independently check. */
export function isExternallyVerifiable(c: ProvenanceClass): boolean {
  return c === 'counterparty_verified' || c === 'onchain_anchored';
}

export interface ProvenanceBucket {
  events: number;
  netDelta: number;
}

export interface ProvenanceBreakdown {
  totalEvents: number;
  totalNetDelta: number;
  byClass: Record<ProvenanceClass, ProvenanceBucket>;
  /** Events + delta a third party could independently verify. */
  externallyVerifiable: ProvenanceBucket;
  /** Delta that rests on nothing but the caller's word. The number to watch. */
  unbackedSelfReported: ProvenanceBucket;
  /**
   * Share of POSITIVE delta that is externally verifiable, 0..1, or null when no
   * positive delta exists.
   *
   * Positive-only on purpose: penalties are not credibility. Including negative
   * deltas would let a heavily-penalised agent appear better-evidenced than a
   * clean one, which inverts the meaning of the whole metric.
   */
  verifiableShareOfGains: number | null;
}

const EMPTY = (): Record<ProvenanceClass, ProvenanceBucket> => ({
  counterparty_verified: { events: 0, netDelta: 0 },
  onchain_anchored: { events: 0, netDelta: 0 },
  self_reported_with_evidence: { events: 0, netDelta: 0 },
  self_reported_unbacked: { events: 0, netDelta: 0 },
  internal_scoring: { events: 0, netDelta: 0 },
  genesis: { events: 0, netDelta: 0 },
  unclassified: { events: 0, netDelta: 0 },
});

/**
 * Decompose a set of events. This is the artifact an auditor should be handed:
 * not "the score is 1,460" but "here is what the 1,460 is made of."
 */
export function summarizeProvenance(rows: ScoreEventRow[]): ProvenanceBreakdown {
  const byClass = EMPTY();
  let totalNetDelta = 0;
  let positiveTotal = 0;
  let positiveVerifiable = 0;

  for (const r of rows) {
    const c = classifyProvenance(r);
    const d = Number(r.delta ?? 0);
    const delta = Number.isFinite(d) ? d : 0;

    byClass[c].events += 1;
    byClass[c].netDelta += delta;
    totalNetDelta += delta;

    if (delta > 0) {
      positiveTotal += delta;
      if (isExternallyVerifiable(c)) positiveVerifiable += delta;
    }
  }

  const sum = (cs: ProvenanceClass[]): ProvenanceBucket =>
    cs.reduce(
      (a, c) => ({ events: a.events + byClass[c].events, netDelta: a.netDelta + byClass[c].netDelta }),
      { events: 0, netDelta: 0 },
    );

  return {
    totalEvents: rows.length,
    totalNetDelta,
    byClass,
    externallyVerifiable: sum(['counterparty_verified', 'onchain_anchored']),
    unbackedSelfReported: byClass.self_reported_unbacked,
    verifiableShareOfGains: positiveTotal > 0 ? positiveVerifiable / positiveTotal : null,
  };
}

/**
 * One-line, honest summary for a public surface or a log.
 *
 * States the internal-churn share explicitly rather than omitting it — an auditor
 * who finds a hidden category stops believing the rest of the page.
 */
export function describeProvenance(b: ProvenanceBreakdown): string {
  const pct = b.verifiableShareOfGains === null ? 'n/a' : `${Math.round(b.verifiableShareOfGains * 100)}%`;
  return (
    `${b.totalEvents} events · ${pct} of gains externally verifiable · ` +
    `unbacked self-reported ${b.unbackedSelfReported.netDelta >= 0 ? '+' : ''}${b.unbackedSelfReported.netDelta} ` +
    `over ${b.unbackedSelfReported.events} events · internal scoring ${b.byClass.internal_scoring.events} events ` +
    `(${b.byClass.internal_scoring.netDelta >= 0 ? '+' : ''}${b.byClass.internal_scoring.netDelta})`
  );
}
