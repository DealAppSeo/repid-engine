/**
 * verdict-schema.test.ts — task 31 SPIKE. Proves the merged VERDICT spec is self-consistent:
 * the keyword-absence axiom, the RepID-event projection, the audit-chain projection, and canonical
 * (stable) JSON. Pure — no DB, no network.
 */
import {
  VERDICT_SCHEMA_VERSION,
  isKeywordAbsent,
  keywordHits,
  decisionOutcomeOf,
  toRepidScoreEvent,
  toAuditChainArgs,
  canonicalJson,
  type HalVerdict,
} from '../src/hal/verdict-schema';

function verdict(over: Partial<HalVerdict> = {}): HalVerdict {
  return {
    schema_version: VERDICT_SCHEMA_VERSION,
    query: 'What is the capital of France?',
    question_keywords: ['paris'],
    candidates: [
      {
        id: 'c1', source: 'groq', grade: 'correct', role: 'primary', rank: 1, confidence: 0.95,
        reason: 'states Paris, matches reference', keyword_hits: ['paris'],
        provenance: { provider: 'groq', model: 'llama-3.1-8b-instant', family: 'llama', call_id: 'x', latency_ms: 700 },
      },
    ],
    outcome: {
      decision: 'answered', selected_candidate_id: 'c1', answer: 'Paris',
      hal_decision: 'clean', hal_score: 0.05, reason: '2 families agree TRUE', keyword_absence: false,
      quorum: { families_used: 2, agreement: 1.0 },
    },
    provenance: {
      grader: { mode: 'crag_grade', provider: 'groq', model: 'llama-3.1-8b-instant' },
      arbiter: { mode: 'arbiter_rank', provider: 'groq', model: 'llama-3.1-8b-instant' },
      merged_single_call: true, produced_at: '2026-07-12T00:00:00.000Z', quorum_id: 'q1',
    },
    audit: {
      event_type: 'HAL_VERDICT', decision_outcome: 'approved', llm_provider: 'groq',
      llm_model: 'llama-3.1-8b-instant', task_domain: 'peer_verify', hallucination_caught: false,
      source_table: 'repid_score_events',
    },
    ...over,
  };
}

describe('keyword-absence axiom', () => {
  test('keywordHits is a case-insensitive substring match', () => {
    expect(keywordHits('The capital is PARIS.', ['paris', 'london'])).toEqual(['paris']);
    expect(keywordHits('nothing relevant', ['paris'])).toEqual([]);
  });
  test('absent when NO candidate has any keyword hit ⇒ not_found', () => {
    expect(isKeywordAbsent([{ keyword_hits: [] }, { keyword_hits: [] }])).toBe(true);
  });
  test('present when at least one candidate has a hit', () => {
    expect(isKeywordAbsent([{ keyword_hits: [] }, { keyword_hits: ['paris'] }])).toBe(false);
  });
});

describe('decision → repid_score_events.decision_outcome mapping', () => {
  test('covers all four HAL decisions', () => {
    expect(decisionOutcomeOf('clean')).toBe('approved');
    expect(decisionOutcomeOf('vetoed')).toBe('rejected');
    expect(decisionOutcomeOf('flagged')).toBe('flagged');
    expect(decisionOutcomeOf('abstain')).toBe('abstained');
  });
});

describe('RepID trust event projection', () => {
  test('projects onto the repid_score_events columns (real schema)', () => {
    const row = toRepidScoreEvent(verdict(), { agent_id: 'agent-uuid' });
    // keys must all be real repid_score_events columns
    const REAL_COLS = new Set([
      'agent_id', 'event_type', 'llm_provider', 'llm_model', 'task_domain', 'hal_score',
      'hal_decision', 'decision_outcome', 'hallucination_caught', 'metadata',
    ]);
    for (const k of Object.keys(row)) expect(REAL_COLS.has(k)).toBe(true);
    expect(row.decision_outcome).toBe('approved');
    expect(row.hal_decision).toBe('clean');
    expect((row.metadata as any).schema_version).toBe(VERDICT_SCHEMA_VERSION);
  });
});

describe('audit-chain projection + canonical JSON', () => {
  test('maps onto append_hal_audit_chain(p_source_table,p_source_id,p_event_payload,p_canonical_json_text)', () => {
    const args = toAuditChainArgs(verdict(), 'evt-123');
    expect(Object.keys(args).sort()).toEqual(['p_canonical_json_text', 'p_event_payload', 'p_source_id', 'p_source_table']);
    expect(args.p_source_table).toBe('repid_score_events');
    expect(args.p_source_id).toBe('evt-123');
  });
  test('canonical JSON is stable regardless of key order', () => {
    const a = verdict();
    // same content, different top-level key insertion order
    const b: HalVerdict = { audit: a.audit, provenance: a.provenance, outcome: a.outcome, candidates: a.candidates, question_keywords: a.question_keywords, query: a.query, schema_version: a.schema_version };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe('not_found verdict shape', () => {
  test('a grounded-nowhere query yields keyword_absence + null answer', () => {
    const v = verdict({
      candidates: [{ id: 'c1', source: 'groq', grade: 'incorrect', role: 'irrelevant', rank: null, confidence: 0.4, reason: 'no keyword', keyword_hits: [], provenance: { provider: 'groq', model: 'm', family: 'llama' } }],
      outcome: { decision: 'not_found', selected_candidate_id: null, answer: null, hal_decision: 'abstain', hal_score: 0.5, reason: 'no candidate contained an answer keyword', keyword_absence: true, quorum: { families_used: 1, agreement: null } },
    });
    expect(isKeywordAbsent(v.candidates)).toBe(true);
    expect(v.outcome.decision).toBe('not_found');
    expect(v.outcome.answer).toBeNull();
    expect(decisionOutcomeOf(v.outcome.hal_decision)).toBe('abstained');
  });
});
