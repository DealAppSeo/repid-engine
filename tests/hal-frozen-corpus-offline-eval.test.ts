/**
 * Tests for the OFFLINE frozen-corpus HAL veto evaluator
 * (scripts/hal-eval/run-frozen-corpus-offline.ts).
 *
 * What these tests defend:
 *   1. The confusion-matrix / F1 arithmetic is correct (synthetic, deterministic).
 *   2. The corpus HASH GATE actually gates — it accepts the real frozen corpus at
 *      its manifest hash and REFUSES a wrong hash. A measurement of a corpus you
 *      cannot name is the failure this whole rack exists to end.
 *   3. A REAL end-to-end offline measurement over the frozen canary holdout runs
 *      keyless, scores every row, and carries its ruler — with providers=NONE and
 *      quorum=NOT-EXERCISED so the extractor floor can never be quoted as the
 *      fact-check quorum's number.
 *
 * This is a HARNESS test. It asserts the measurement machinery is correct and the
 * ruler is attached; it does NOT pin a specific headline F1 (that would ossify a
 * number that legitimately moves when the extractor changes).
 */
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'dummy';

import fs from 'fs';
import path from 'path';
import {
  scoreConfusion,
  verifyCorpusHash,
  evaluateRowsOffline,
  runOfflineEval,
  type CorpusRow,
} from '../scripts/hal-eval/run-frozen-corpus-offline';

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json'), 'utf8'),
);
const canary = MANIFEST.corpora.find((c: any) => c.name === 'canary-v1');
const rigorous = MANIFEST.corpora.find((c: any) => c.name === 'rigorous-v1');

describe('scoreConfusion — arithmetic on a synthetic, known-label set', () => {
  // Positive class = hallucination = label FALSE, predicted = vetoed.
  it('scores perfect separation as F1 = 1.0', () => {
    const s = scoreConfusion([
      { truth: 'FALSE', vetoed: true, halScore: 0.9 }, // TP
      { truth: 'FALSE', vetoed: true, halScore: 0.8 }, // TP
      { truth: 'TRUE', vetoed: false, halScore: 0.1 }, // TN
      { truth: 'TRUE', vetoed: false, halScore: 0.2 }, // TN
    ]);
    expect(s.confusion).toEqual({ tp: 2, fp: 0, tn: 2, fn: 0 });
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.accuracy).toBe(1);
    expect(s.auc).toBe(1); // every FALSE scored above every TRUE
  });

  it('computes precision/recall/F1 correctly on a mixed set', () => {
    // 3 FALSE, 3 TRUE. Vetoes: 2 correct FALSE (TP), 1 wrong TRUE (FP),
    // miss 1 FALSE (FN), 2 correct TRUE (TN).
    const s = scoreConfusion([
      { truth: 'FALSE', vetoed: true, halScore: 0.7 }, // TP
      { truth: 'FALSE', vetoed: true, halScore: 0.6 }, // TP
      { truth: 'FALSE', vetoed: false, halScore: 0.3 }, // FN
      { truth: 'TRUE', vetoed: true, halScore: 0.55 }, // FP
      { truth: 'TRUE', vetoed: false, halScore: 0.2 }, // TN
      { truth: 'TRUE', vetoed: false, halScore: 0.1 }, // TN
    ]);
    expect(s.confusion).toEqual({ tp: 2, fp: 1, tn: 2, fn: 1 });
    expect(s.precision).toBeCloseTo(2 / 3, 6); // 2/(2+1)
    expect(s.recall).toBeCloseTo(2 / 3, 6); // 2/(2+1)
    expect(s.f1).toBeCloseTo(2 / 3, 6);
    expect(s.accuracy).toBeCloseTo(4 / 6, 6);
  });

  it('reports AUC ~0.5 for no separation (identical scores)', () => {
    const s = scoreConfusion([
      { truth: 'FALSE', vetoed: true, halScore: 0.5 },
      { truth: 'TRUE', vetoed: true, halScore: 0.5 },
      { truth: 'FALSE', vetoed: true, halScore: 0.5 },
      { truth: 'TRUE', vetoed: true, halScore: 0.5 },
    ]);
    expect(s.auc).toBe(0.5);
  });
});

describe('verifyCorpusHash — the hash gate', () => {
  it('accepts the real frozen corpus at its manifest hash', () => {
    const corpusPath = path.join(ROOT, rigorous.path);
    const hash = verifyCorpusHash(corpusPath, rigorous.sha256);
    expect(hash).toBe(rigorous.sha256);
  });

  it('REFUSES a wrong hash (drift must halt, not silently measure)', () => {
    const corpusPath = path.join(ROOT, canary.path);
    expect(() => verifyCorpusHash(corpusPath, 'deadbeef'.repeat(8))).toThrow(
      /REFUSING TO MEASURE/,
    );
  });
});

describe('runOfflineEval — real keyless measurement over the frozen canary holdout', () => {
  let res: Awaited<ReturnType<typeof runOfflineEval>>;

  beforeAll(async () => {
    res = await runOfflineEval({
      corpusName: 'canary-v1',
      split: 'holdout',
      strictness: 1,
      write: false, // tests never write reports into the repo
    });
  }, 60_000);

  it('scores every holdout row (100% coverage, keyless)', () => {
    expect(res.rows).toBe(canary.splits.holdout);
    expect(res.scored).toBe(res.rows);
    const total = res.confusion.tp + res.confusion.fp + res.confusion.tn + res.confusion.fn;
    expect(total).toBe(res.scored);
  });

  it('carries its ruler and never claims the quorum ran', () => {
    expect(res.corpus_sha256).toBe(canary.sha256);
    expect(res.ruler).toContain(`canary-v1@${canary.sha256.slice(0, 12)}`);
    expect(res.ruler).toContain('providers=NONE');
    expect(res.ruler).toContain('quorum=NOT-EXERCISED');
    // Honesty invariant: the offline path must not silently present itself as the
    // disjoint-family fact-check quorum.
    expect(res.providers).toBe('NONE');
    expect(res.quorum).toBe('NOT-EXERCISED');
  });

  it('produces a finite F1 in [0,1] with a consistent confusion matrix', () => {
    expect(Number.isFinite(res.f1)).toBe(true);
    expect(res.f1).toBeGreaterThanOrEqual(0);
    expect(res.f1).toBeLessThanOrEqual(1);
    expect(res.f1).toBeGreaterThanOrEqual(0); // guards against NaN slipping through
    // The oracle threshold is a diagnostic upper bound over the same split.
    expect(res.oracle_threshold.f1).toBeGreaterThanOrEqual(res.f1 - 1e-9);
  });

  it('is deterministic — a second run yields the identical matrix', async () => {
    const again = await runOfflineEval({
      corpusName: 'canary-v1',
      split: 'holdout',
      strictness: 1,
      write: false,
    });
    expect(again.confusion).toEqual(res.confusion);
    expect(again.f1).toBe(res.f1);
    expect(again.auc).toBe(res.auc);
  }, 60_000);

  it('strictness 2 == strictness 1 without providers (quorum machinery is inert keyless)', async () => {
    const s2 = await runOfflineEval({
      corpusName: 'canary-v1',
      split: 'holdout',
      strictness: 2,
      write: false,
    });
    // With providers=[] the strictness>=2 cross-LLM gate cannot fire, so the two
    // strictnesses must be byte-identical. If this ever diverges, something in the
    // offline path started depending on a provider it does not have.
    expect(s2.confusion).toEqual(res.confusion);
  }, 60_000);
});

describe('evaluateRowsOffline — synthetic SMOKE (NOT a headline number)', () => {
  // A tiny hand-built labeled set used only to prove the extractor runs end to end
  // and the veto decision plumbs through. This is explicitly NOT the corpus and
  // NOT a quality measurement — it exists so a failure here points at the harness,
  // not at HAL quality.
  const smoke: CorpusRow[] = [
    {
      id: '00000000-0000-0000-0000-000000000001',
      prompt: 'Is the following claim true? Answer TRUE or FALSE.',
      candidate_answer: 'Water boils at 100 degrees Celsius at sea level.',
      label: 'TRUE',
      split: 'holdout',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      prompt: 'Is the following claim true? Answer TRUE or FALSE.',
      candidate_answer: 'The moon is definitely made of green cheese and this is 100% certain.',
      label: 'FALSE',
      split: 'holdout',
    },
  ];

  it('runs keyless and returns a scored row per input', async () => {
    const scored = await evaluateRowsOffline(smoke, 1);
    expect(scored).toHaveLength(2);
    for (const r of scored) {
      expect(typeof r.halScore).toBe('number');
      expect(Number.isFinite(r.halScore)).toBe(true);
      expect(typeof r.vetoed).toBe('boolean');
    }
    // scoreConfusion consumes exactly this shape — the harness composes.
    const s = scoreConfusion(scored);
    expect(s.confusion.tp + s.confusion.fp + s.confusion.tn + s.confusion.fn).toBe(2);
  }, 30_000);
});
