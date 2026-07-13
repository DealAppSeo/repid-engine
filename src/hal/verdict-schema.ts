/**
 * verdict-schema.ts — SPEC-AS-CODE for the merged CRAG-grade + arbiter-rank VERDICT (CC, task 31).
 *
 * ⚠ SPIKE / SPEC ONLY. This module is NOT imported by any route, worker, or pipeline — it defines the
 * types + the pure mapping helpers + a JSON Schema so the shape is provable (compiles + unit-tested)
 * BEFORE anyone wires it. No prod writes, no runtime behavior change. See
 * docs/VERDICT_SCHEMA_LITELLM_RECON_2026-07-12.md for the design rationale + recon.
 *
 * WHY (map priority 3 — the HAL/RepID keystone):
 * Today HAL runs TWO shapes separately: a CRAG-style grade of each candidate (relevant / irrelevant /
 * ambiguous — cf. src/hal/fact-check.ts FactCheckResult) and an arbiter rank/critique (cf.
 * src/services/adversarial-judge.ts AdversarialJudgeResult). This spec MERGES them into ONE typed
 * object emitted by ONE LLM call, so the SAME object doubles as:
 *   (1) a RepID trust event  → a row in `repid_score_events`, and
 *   (2) a HyperDAG audit input → the payload for `append_hal_audit_chain(...)`.
 * One call instead of two also halves the round-trips, which matters for the measured HAL latency
 * budget (Cowork: p50 ~0ms with stages 1–2 inline; p95 ~3155ms, the tail covered by LAO's 3s threshold).
 *
 * KEYWORD-ABSENCE AXIOM (the anti-hallucination guarantee):
 * If NONE of the candidates contains ANY of the question's answer-bearing keywords, the verdict is
 * `not_found` — the model may not invent an answer that isn't grounded in a candidate. This is a hard,
 * deterministic post-check computed OVER the model's structured output (not left to the model's prose).
 */

export const VERDICT_SCHEMA_VERSION = 'hal.verdict.v1' as const;

/** CRAG relevance grade of a candidate against the query. */
export type CandidateGrade = 'correct' | 'incorrect' | 'ambiguous';

/** Arbiter role assigned to a candidate in the merged ranking. */
export type CandidateRole = 'primary' | 'supporting' | 'contradicting' | 'irrelevant' | 'duplicate';

/** HAL decision domain — identical to fact-check.ts HalDecision so downstream code is unchanged. */
export type HalVerdictDecision = 'clean' | 'flagged' | 'vetoed' | 'abstain';

/** Terminal outcome of the merged verdict. */
export type VerdictOutcomeKind = 'answered' | 'not_found' | 'contested' | 'refused';

export interface CandidateProvenance {
  provider: string; // llm provider or agent that produced the candidate
  model: string;
  family: string;   // independence family (reuse familyOf/resolveFamily) — two same-family = one vote
  call_id?: string; // ties back to llm_call_log.call_id
  latency_ms?: number;
}

export interface VerdictCandidate {
  id: string;                 // stable id within this verdict
  source: string;             // provider / agent / document id the candidate came from
  grade: CandidateGrade;      // CRAG grade
  role: CandidateRole;        // arbiter role
  rank: number | null;        // arbiter rank, 1 = best; null when irrelevant/duplicate
  confidence: number;         // 0..1
  reason: string;             // one-line justification for grade+role
  keyword_hits: string[];     // which question_keywords appear in this candidate (absence-axiom input)
  provenance: CandidateProvenance;
}

export interface VerdictOutcome {
  decision: VerdictOutcomeKind;
  selected_candidate_id: string | null; // arbiter pick; null on not_found/contested/refused
  answer: string | null;                 // selected answer text; null on not_found/refused
  hal_decision: HalVerdictDecision;      // → repid_score_events.hal_decision
  hal_score: number;                     // 0..1 risk (higher = more likely false) → repid_score_events.hal_score
  reason: string;                        // human-readable decision_reason
  keyword_absence: boolean;              // true when `not_found` was driven by the absence axiom
  quorum: { families_used: number; agreement: number | null };
}

export interface VerdictProvenance {
  grader: { mode: 'crag_grade'; provider: string; model: string };
  arbiter: { mode: 'arbiter_rank'; provider: string; model: string };
  merged_single_call: boolean; // true when ONE call produced both grade + rank (the keystone optimization)
  produced_at: string;         // ISO-8601
  quorum_id: string;           // groups the underlying provider calls in llm_call_log
}

/** Fields that let the SAME verdict serve as a RepID trust event AND a HyperDAG audit input. */
export interface VerdictAudit {
  // RepID trust event (repid_score_events) projection
  event_type: string;        // e.g. 'HAL_VERDICT'
  decision_outcome: string;  // 'approved' | 'rejected' | 'clean' | 'abstained' (see decisionOutcomeOf)
  llm_provider: string;
  llm_model: string;
  task_domain: string;
  hallucination_caught: boolean;
  // HyperDAG audit input (append_hal_audit_chain)
  source_table: string;      // 'repid_score_events'
}

export interface HalVerdict {
  schema_version: typeof VERDICT_SCHEMA_VERSION;
  query: string;
  question_keywords: string[]; // answer-bearing keywords the answer MUST be grounded in
  candidates: VerdictCandidate[];
  outcome: VerdictOutcome;
  provenance: VerdictProvenance;
  audit: VerdictAudit;
}

// ---------------------------------------------------------------------------
// Pure helpers (spec-as-code). No IO, no DB — safe to unit test in isolation.
// ---------------------------------------------------------------------------

/**
 * KEYWORD-ABSENCE AXIOM. Returns true (⇒ not_found) when NO candidate contains ANY question keyword.
 * Case-insensitive substring match; empty keyword list is treated as "cannot ground" ⇒ not_found.
 */
export function isKeywordAbsent(candidates: Pick<VerdictCandidate, 'keyword_hits'>[]): boolean {
  return candidates.every((c) => (c.keyword_hits?.length ?? 0) === 0);
}

/** Compute keyword_hits for a candidate body against the question keywords (deterministic). */
export function keywordHits(body: string, questionKeywords: string[]): string[] {
  const hay = body.toLowerCase();
  return questionKeywords.filter((k) => k.trim().length > 0 && hay.includes(k.toLowerCase()));
}

/** Map a HAL decision → the repid_score_events.decision_outcome domain used elsewhere in the engine. */
export function decisionOutcomeOf(decision: HalVerdictDecision): string {
  switch (decision) {
    case 'clean': return 'approved';
    case 'vetoed': return 'rejected';
    case 'flagged': return 'flagged';
    case 'abstain': return 'abstained';
  }
}

/** Project a verdict onto a `repid_score_events` insert row (the RepID-trust-event half). */
export function toRepidScoreEvent(v: HalVerdict, opts: { agent_id: string; event_type?: string }): Record<string, unknown> {
  return {
    agent_id: opts.agent_id,
    event_type: opts.event_type ?? v.audit.event_type,
    llm_provider: v.audit.llm_provider,
    llm_model: v.audit.llm_model,
    task_domain: v.audit.task_domain,
    hal_score: v.outcome.hal_score,
    hal_decision: v.outcome.hal_decision,
    decision_outcome: decisionOutcomeOf(v.outcome.hal_decision),
    hallucination_caught: v.audit.hallucination_caught,
    metadata: {
      schema_version: v.schema_version,
      query: v.query,
      outcome: v.outcome,
      provenance: v.provenance,
      candidates: v.candidates,
    },
  };
}

/**
 * Deterministic canonical JSON (sorted keys) — the exact bytes fed to the audit hash chain, so the
 * same verdict always hashes to the same value regardless of key insertion order.
 */
export function canonicalJson(v: HalVerdict): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      return Object.keys(x as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort((x as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return x;
  };
  return JSON.stringify(sort(v));
}

/** Project a verdict onto the `append_hal_audit_chain(...)` argument shape (the audit-input half). */
export function toAuditChainArgs(v: HalVerdict, sourceId: string): {
  p_source_table: string;
  p_source_id: string;
  p_event_payload: HalVerdict;
  p_canonical_json_text: string;
} {
  return {
    p_source_table: v.audit.source_table,
    p_source_id: sourceId,
    p_event_payload: v,
    p_canonical_json_text: canonicalJson(v),
  };
}

/**
 * JSON Schema (draft-07) mirror of HalVerdict, for non-TS consumers (other agents / lanes / the
 * wrapper) to validate the object off the wire. Kept in lockstep with the interfaces above.
 */
export const HAL_VERDICT_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://hyperdag.dev/schemas/hal.verdict.v1.json',
  title: 'HalVerdict',
  type: 'object',
  required: ['schema_version', 'query', 'question_keywords', 'candidates', 'outcome', 'provenance', 'audit'],
  additionalProperties: false,
  properties: {
    schema_version: { const: VERDICT_SCHEMA_VERSION },
    query: { type: 'string' },
    question_keywords: { type: 'array', items: { type: 'string' } },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'source', 'grade', 'role', 'rank', 'confidence', 'reason', 'keyword_hits', 'provenance'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          grade: { enum: ['correct', 'incorrect', 'ambiguous'] },
          role: { enum: ['primary', 'supporting', 'contradicting', 'irrelevant', 'duplicate'] },
          rank: { type: ['integer', 'null'], minimum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
          keyword_hits: { type: 'array', items: { type: 'string' } },
          provenance: {
            type: 'object',
            required: ['provider', 'model', 'family'],
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              family: { type: 'string' },
              call_id: { type: 'string' },
              latency_ms: { type: 'number' },
            },
          },
        },
      },
    },
    outcome: {
      type: 'object',
      required: ['decision', 'selected_candidate_id', 'answer', 'hal_decision', 'hal_score', 'reason', 'keyword_absence', 'quorum'],
      additionalProperties: false,
      properties: {
        decision: { enum: ['answered', 'not_found', 'contested', 'refused'] },
        selected_candidate_id: { type: ['string', 'null'] },
        answer: { type: ['string', 'null'] },
        hal_decision: { enum: ['clean', 'flagged', 'vetoed', 'abstain'] },
        hal_score: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
        keyword_absence: { type: 'boolean' },
        quorum: {
          type: 'object',
          required: ['families_used', 'agreement'],
          properties: {
            families_used: { type: 'integer', minimum: 0 },
            agreement: { type: ['number', 'null'] },
          },
        },
      },
    },
    provenance: {
      type: 'object',
      required: ['grader', 'arbiter', 'merged_single_call', 'produced_at', 'quorum_id'],
      properties: {
        grader: { type: 'object', required: ['mode', 'provider', 'model'] },
        arbiter: { type: 'object', required: ['mode', 'provider', 'model'] },
        merged_single_call: { type: 'boolean' },
        produced_at: { type: 'string' },
        quorum_id: { type: 'string' },
      },
    },
    audit: {
      type: 'object',
      required: ['event_type', 'decision_outcome', 'llm_provider', 'llm_model', 'task_domain', 'hallucination_caught', 'source_table'],
      properties: {
        event_type: { type: 'string' },
        decision_outcome: { type: 'string' },
        llm_provider: { type: 'string' },
        llm_model: { type: 'string' },
        task_domain: { type: 'string' },
        hallucination_caught: { type: 'boolean' },
        source_table: { type: 'string' },
      },
    },
  },
} as const;
