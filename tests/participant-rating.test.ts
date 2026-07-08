/**
 * participant-rating.test.ts — the 5 laws, as enforced.
 *
 * Proves each law is ENFORCED IN CODE, not merely documented:
 *   L1 EARNED-GATE: an edge with no verified receipt is REJECTED.
 *   L2 GROUND-TRUTH ANCHOR: verification-strength orders edge weight
 *       (execution > quorum > peer-opinion > self-report).
 *   L3 RATER-REP-WEIGHT: a higher-RepID rater carries more weight.
 *   L4 ANTI-GAMING: comma-veto collusion + family-disjoint discounts.
 *   L5 FAIRNESS: multi-axis preserved (never collapsed to one score).
 * Plus: the ledger writer is SHADOW-FIRST — it logs a would-be row but performs
 * NO DB write and NO current_repid mutation in the default (shadow) mode.
 *
 * Pure/deterministic — no DB or network. The ledger's live path is exercised with
 * an in-memory fake `db` to prove it targets participant_rating_ledger only and
 * never touches repid_agents.
 */

import {
  RatingEdge,
  Participant,
  validateRatingEdge,
  edgeWeight,
  aggregateRatings,
  detectCollusion,
  assertFamilyDisjoint,
  raterReputationWeight,
  VERIFICATION_STRENGTH_WEIGHT,
  VERIFICATION_STRENGTH_RANK,
  RATING_AXES,
} from '../src/engine/participant-rating';
import {
  recordRatingEdge,
  edgeToLedgerRow,
  participantRatingMode,
} from '../src/engine/participant-rating-ledger';
import { edgesFromCanaryRun } from '../scripts/eval/seed-participant-ratings';

// ---- helpers ---------------------------------------------------------------
const agent = (id: string, repId?: number, family?: string): Participant => ({
  id, kind: 'agent', repId, family,
});
const llm = (id: string, family: string): Participant => ({ id, kind: 'llm', family });

function baseEdge(over: Partial<RatingEdge> = {}): RatingEdge {
  return {
    rater: agent('rater-1', 1000, 'harness'),
    ratee: llm('groq:llama-3.1-8b', 'llama'),
    axes: { accuracy: 0.9 },
    verificationStrength: 'quorum-verified',
    engagementReceiptRef: 'canary-run:deadbeef',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// L1 — EARNED-RATING GATE
// ---------------------------------------------------------------------------
describe('L1 earned-rating gate', () => {
  it('REJECTS an edge with no receipt ref', () => {
    const v = validateRatingEdge(baseEdge({ engagementReceiptRef: '' }));
    expect(v.valid).toBe(false);
    expect(v.violations).toContain('L1:no-verified-receipt');
  });

  it('REJECTS an edge with a whitespace-only receipt ref', () => {
    const v = validateRatingEdge(baseEdge({ engagementReceiptRef: '   ' }));
    expect(v.valid).toBe(false);
    expect(v.violations).toContain('L1:no-verified-receipt');
  });

  it('ACCEPTS an edge that references a verified receipt', () => {
    const v = validateRatingEdge(baseEdge());
    expect(v.valid).toBe(true);
    expect(v.violations).toHaveLength(0);
  });

  it('the ledger writer refuses to record a receipt-less edge (never a rating)', async () => {
    const res = await recordRatingEdge(baseEdge({ engagementReceiptRef: '' }));
    expect(res.accepted).toBe(false);
    expect(res.row).toBeNull();
    expect(res.persisted).toBe(false);
    expect(res.violations).toContain('L1:no-verified-receipt');
  });
});

// ---------------------------------------------------------------------------
// L2 — GROUND-TRUTH ANCHOR (verification-strength orders weight)
// ---------------------------------------------------------------------------
describe('L2 ground-truth anchor', () => {
  it('verification-strength weights are strictly ordered execution > quorum > peer > self', () => {
    expect(VERIFICATION_STRENGTH_WEIGHT['execution-verified']).toBeGreaterThan(
      VERIFICATION_STRENGTH_WEIGHT['quorum-verified'],
    );
    expect(VERIFICATION_STRENGTH_WEIGHT['quorum-verified']).toBeGreaterThan(
      VERIFICATION_STRENGTH_WEIGHT['peer-opinion'],
    );
    expect(VERIFICATION_STRENGTH_WEIGHT['peer-opinion']).toBeGreaterThan(
      VERIFICATION_STRENGTH_WEIGHT['self-report'],
    );
    // rank mirrors the ordering
    expect(VERIFICATION_STRENGTH_RANK['execution-verified']).toBe(4);
    expect(VERIFICATION_STRENGTH_RANK['self-report']).toBe(1);
  });

  it('an execution-verified edge outweighs a quorum edge outweighs a self-report edge (same rater/stake/time)', () => {
    const now = Date.parse('2026-07-08T00:00:00Z');
    const ts = '2026-07-08T00:00:00Z';
    const wExec = edgeWeight(baseEdge({ verificationStrength: 'execution-verified', timestamp: ts }), {}, now).weight;
    const wQuorum = edgeWeight(baseEdge({ verificationStrength: 'quorum-verified', timestamp: ts }), {}, now).weight;
    const wPeer = edgeWeight(baseEdge({ verificationStrength: 'peer-opinion', timestamp: ts }), {}, now).weight;
    const wSelf = edgeWeight(baseEdge({ verificationStrength: 'self-report', timestamp: ts }), {}, now).weight;
    expect(wExec).toBeGreaterThan(wQuorum);
    expect(wQuorum).toBeGreaterThan(wPeer);
    expect(wPeer).toBeGreaterThan(wSelf);
  });

  it('rejects an unknown verification strength (cannot weight it)', () => {
    const v = validateRatingEdge(baseEdge({ verificationStrength: 'vibes' as any }));
    expect(v.valid).toBe(false);
    expect(v.violations).toContain('L2:unknown-verification-strength');
  });
});

// ---------------------------------------------------------------------------
// L3 — RATER-REPUTATION WEIGHTING
// ---------------------------------------------------------------------------
describe('L3 rater-reputation weighting', () => {
  it('a higher-RepID rater carries strictly more weight (same edge otherwise)', () => {
    const now = Date.parse('2026-07-08T00:00:00Z');
    const ts = '2026-07-08T00:00:00Z';
    const low = edgeWeight(baseEdge({ rater: agent('r', 200, 'h'), timestamp: ts }), {}, now).weight;
    const mid = edgeWeight(baseEdge({ rater: agent('r', 1000, 'h'), timestamp: ts }), {}, now).weight;
    const high = edgeWeight(baseEdge({ rater: agent('r', 8000, 'h'), timestamp: ts }), {}, now).weight;
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it('an unknown/zero-RepID rater gets a small non-zero floor (never dominates, never silenced)', () => {
    expect(raterReputationWeight(undefined)).toBeCloseTo(0.1, 5);
    expect(raterReputationWeight(0)).toBeCloseTo(0.1, 5);
    expect(raterReputationWeight(10000)).toBeLessThanOrEqual(1.0);
    expect(raterReputationWeight(10000)).toBeGreaterThan(raterReputationWeight(1000));
  });
});

// ---------------------------------------------------------------------------
// L4 — ANTI-GAMING (collusion / comma-veto + family-disjoint)
// ---------------------------------------------------------------------------
describe('L4 anti-gaming', () => {
  it('flags too-perfect agreement (comma-veto) as collusion when ≥3 raters give identical scores', () => {
    const edges: RatingEdge[] = [
      baseEdge({ rater: agent('a', 1000, 'x'), axes: { accuracy: 0.8 } }),
      baseEdge({ rater: agent('b', 1000, 'y'), axes: { accuracy: 0.8 } }),
      baseEdge({ rater: agent('c', 1000, 'z'), axes: { accuracy: 0.8 } }),
    ];
    const c = detectCollusion(edges, 'accuracy');
    expect(c.contaminated).toHaveLength(3);
    expect(c.reason).toMatch(/comma-veto/i);
  });

  it('does NOT flag collusion with fewer than 3 raters or with genuine disagreement', () => {
    expect(detectCollusion([baseEdge(), baseEdge()], 'accuracy').contaminated).toHaveLength(0);
    const varied: RatingEdge[] = [
      baseEdge({ rater: agent('a', 1000, 'x'), axes: { accuracy: 0.8 } }),
      baseEdge({ rater: agent('b', 1000, 'y'), axes: { accuracy: 0.9 } }),
      baseEdge({ rater: agent('c', 1000, 'z'), axes: { accuracy: 0.7 } }),
    ];
    expect(detectCollusion(varied, 'accuracy').contaminated).toHaveLength(0);
  });

  it('family-disjoint: flags a participant that is the SOLE rater of its own family', () => {
    const edges: RatingEdge[] = [
      // llama rates a llama ratee, and is the only rater → conflicted
      baseEdge({ rater: { id: 'llama-a', kind: 'llm', family: 'llama' }, ratee: llm('llama-b', 'llama') }),
    ];
    const r = assertFamilyDisjoint(edges);
    expect(r.conflicted).toHaveLength(1);
  });

  it('family-disjoint: an independent-family corroborator clears the conflict', () => {
    const rateeB = llm('llama-b', 'llama');
    const edges: RatingEdge[] = [
      baseEdge({ rater: { id: 'llama-a', kind: 'llm', family: 'llama' }, ratee: rateeB }),
      baseEdge({ rater: { id: 'deepseek-x', kind: 'llm', family: 'deepseek' }, ratee: rateeB }),
    ];
    expect(assertFamilyDisjoint(edges).conflicted).toHaveLength(0);
  });

  it('a collusion-contaminated edge is discounted in weight', () => {
    const now = Date.parse('2026-07-08T00:00:00Z');
    const ts = '2026-07-08T00:00:00Z';
    const clean = edgeWeight(baseEdge({ timestamp: ts }), {}, now).weight;
    const flagged = edgeWeight(baseEdge({ timestamp: ts }), { collusionContaminated: true }, now).weight;
    expect(flagged).toBeLessThan(clean);
  });

  it('policy requireSybilBond REJECTS an unbonded rater', () => {
    const v = validateRatingEdge(baseEdge({ raterBonded: false }), { requireSybilBond: true });
    expect(v.valid).toBe(false);
    expect(v.violations).toContain('L4:sybil-bond-required');
  });
});

// ---------------------------------------------------------------------------
// L5 — FAIRNESS / MULTI-AXIS (never one collapsed score)
// ---------------------------------------------------------------------------
describe('L5 fairness / multi-axis', () => {
  it('rejects an edge with zero measured axes', () => {
    const v = validateRatingEdge(baseEdge({ axes: {} }));
    expect(v.valid).toBe(false);
    expect(v.violations).toContain('L5:no-axes-measured');
  });

  it('aggregation preserves EACH axis separately — never collapses to one number', () => {
    const ratee = llm('deepseek:deepseek-chat', 'deepseek');
    const edges: RatingEdge[] = [
      { rater: agent('r1', 1000, 'harness'), ratee, axes: { accuracy: 1.0, calibration: 0.9, coverage: 1.0, latency: 300 }, verificationStrength: 'quorum-verified', engagementReceiptRef: 'r:1' },
      { rater: agent('r2', 1000, 'harness2'), ratee, axes: { accuracy: 0.9, calibration: 0.8, coverage: 0.95, latency: 350 }, verificationStrength: 'quorum-verified', engagementReceiptRef: 'r:2' },
    ];
    const agg = aggregateRatings(ratee, edges);
    // every axis survives as its own value
    expect(agg.axes.accuracy).toBeGreaterThan(0);
    expect(agg.axes.calibration).toBeGreaterThan(0);
    expect(agg.axes.coverage).toBeGreaterThan(0);
    expect(agg.axes.latency).toBeGreaterThan(0);
    // the axes are DISTINCT (not a single collapsed number copied across)
    expect(agg.axes.accuracy).not.toEqual(agg.axes.calibration);
    // receipts carried through (auditability)
    expect(agg.receiptRefs).toEqual(['r:1', 'r:2']);
    expect(agg.edgeCount).toBe(2);
  });

  it('every ledger row carries its receipt ref (auditable why)', () => {
    const row = edgeToLedgerRow(baseEdge(), 'shadow');
    expect(row.engagement_receipt_ref).toBe('canary-run:deadbeef');
    // axes preserved as a map, not collapsed
    expect(row.axes).toHaveProperty('accuracy');
  });
});

// ---------------------------------------------------------------------------
// SHADOW-FIRST — logs but does not mutate
// ---------------------------------------------------------------------------
describe('shadow-first ledger writer', () => {
  const prev = process.env.PARTICIPANT_RATING_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PARTICIPANT_RATING_MODE;
    else process.env.PARTICIPANT_RATING_MODE = prev;
  });

  it('defaults to shadow mode', () => {
    delete process.env.PARTICIPANT_RATING_MODE;
    expect(participantRatingMode()).toBe('shadow');
    process.env.PARTICIPANT_RATING_MODE = 'anything-else';
    expect(participantRatingMode()).toBe('shadow');
    process.env.PARTICIPANT_RATING_MODE = 'live';
    expect(participantRatingMode()).toBe('live');
  });

  it('shadow mode: accepts + returns the row but performs NO DB write', async () => {
    delete process.env.PARTICIPANT_RATING_MODE;
    // a db whose .from() throws — proves shadow mode never touches it.
    const explodingDb = { from: () => { throw new Error('DB MUST NOT BE TOUCHED IN SHADOW'); } };
    const res = await recordRatingEdge(baseEdge(), {
      db: explodingDb as any,
      dogfood: { workRef: 'PR#999', verifiedBy: 'reviewer-x', repidDelta: 25 },
    });
    expect(res.accepted).toBe(true);
    expect(res.persisted).toBe(false);
    expect(res.mode).toBe('shadow');
    // the would-be RepID delta is recorded as a measurement, NEVER applied.
    expect(res.row?.repid_delta).toBe(25);
    expect(res.row?.repid_applied).toBe(false);
  });

  it('live mode: inserts ONLY into participant_rating_ledger, never repid_agents', async () => {
    process.env.PARTICIPANT_RATING_MODE = 'live';
    const inserts: Array<{ table: string; row: any }> = [];
    const fakeDb = {
      from: (table: string) => ({
        insert: async (row: any) => { inserts.push({ table, row }); return { error: null }; },
      }),
    };
    const res = await recordRatingEdge(baseEdge(), {
      db: fakeDb as any,
      dogfood: { workRef: 'PR#1', verifiedBy: 'xc', repidDelta: 25 },
    });
    expect(res.persisted).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe('participant_rating_ledger');
    // the ledger writer NEVER writes repid_agents (no live current_repid mutation).
    expect(inserts.some((i) => i.table === 'repid_agents')).toBe(false);
    // even in live mode the writer only LOGS the delta — promotion is a separate step.
    expect(inserts[0]!.row.repid_applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEED — real canary verdicts prove L1 + L2 on real receipts
// ---------------------------------------------------------------------------
describe('seed from real canary verdicts (L1+L2)', () => {
  // a minimal realistic canary run: 2 providers vote, 1 errors entirely.
  const run = {
    generated_at: '2026-07-08T02:17:06.804Z',
    quorum: [
      { name: 'deepseek', model: 'deepseek-chat', family: 'deepseek' },
      { name: 'groq', model: 'llama-3.1-8b-instant', family: 'llama' },
      { name: 'gemini', model: 'gemini-2.0-flash', family: 'gemini' },
    ],
    results: [
      { idx: 0, claim: 'c0', label: 'TRUE' as const, domain: 'x', difficulty: 'easy',
        verdicts: [
          { provider: 'deepseek', verdict: 'TRUE', confidence: 95, latency_ms: 300 },
          { provider: 'groq', verdict: 'TRUE', confidence: 100, latency_ms: 274 },
          { provider: 'gemini', verdict: 'ERROR', confidence: 0, error: 'HTTP 429', latency_ms: 1344 },
        ] },
      { idx: 1, claim: 'c1', label: 'FALSE' as const, domain: 'x', difficulty: 'easy',
        verdicts: [
          { provider: 'deepseek', verdict: 'FALSE', confidence: 90, latency_ms: 310 },
          { provider: 'groq', verdict: 'TRUE', confidence: 80, latency_ms: 280 }, // groq WRONG here
          { provider: 'gemini', verdict: 'ERROR', confidence: 0, error: 'HTTP 429', latency_ms: 1300 },
        ] },
    ],
  };

  it('produces one earned edge per provider that voted; gemini (all-errors) gets NO edge (L1)', () => {
    const { edges, unrated } = edgesFromCanaryRun(run as any, 'canary-run:testhash');
    const ratees = edges.map((e) => e.ratee.id);
    expect(ratees).toContain('deepseek:deepseek-chat');
    expect(ratees).toContain('groq:llama-3.1-8b-instant');
    // LAW 1: gemini errored every call → no verified engagement → no rating fabricated.
    expect(ratees.some((r) => r.startsWith('gemini'))).toBe(false);
    expect(unrated.map((u) => u.provider)).toContain('gemini');
  });

  it('L2 anchors to ground truth: deepseek (2/2 correct) outscores groq (1/2) on accuracy', () => {
    const { edges } = edgesFromCanaryRun(run as any, 'canary-run:testhash');
    const ds = edges.find((e) => e.ratee.id.startsWith('deepseek'))!;
    const gq = edges.find((e) => e.ratee.id.startsWith('groq'))!;
    expect(ds.axes.accuracy).toBeCloseTo(1.0, 5);
    expect(gq.axes.accuracy).toBeCloseTo(0.5, 5);
    expect(ds.axes.accuracy!).toBeGreaterThan(gq.axes.accuracy!);
    // every seeded edge is quorum-verified against a known-answer oracle, with a receipt.
    expect(ds.verificationStrength).toBe('quorum-verified');
    expect(ds.engagementReceiptRef).toBe('canary-run:testhash');
    // L5: multiple axes present (accuracy, calibration, coverage at minimum).
    for (const axis of ['accuracy', 'calibration', 'coverage'] as const) {
      expect(typeof ds.axes[axis]).toBe('number');
    }
  });
});
