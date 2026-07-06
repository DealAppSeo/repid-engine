/**
 * Self-tests for Phase 2 — verification floor + disjoint jury + canary + rule extraction.
 * OUTPUT_PATH: tests/decisioning-phase2-labels.test.ts
 * Placed under tests/ (the only dir jest.config.js roots on — per CLAUDE.md test-layout quirk).
 *
 * VERIFY (from the Phase-2 gate):
 *   1) sampler rate ≈ configured (uniform-random, seedable);
 *   2) jury excludes the generating family (§7 no self-grading);
 *   3) canary divergence computes (Goodhart tripwire);
 *   4) rule extraction is non-empty on a REAL decision (anfisRecommendProvider output).
 */

import {
  configFromEnv,
  selectVerificationFloor,
  shouldSample,
  inclusionScore,
  isCompletedDefault,
  DEFAULT_SAMPLER_RATE,
  SAMPLER_ENV,
  type CompletedCall,
  type SamplerConfig,
} from '../src/decisioning/verification-sampler';
import { assembleJuryForCall } from '../src/decisioning/jury-assembly';
import type { ModelRef } from '../src/decisioning/disjointness';
import { resolveFamily, UnmappedFamilyError } from '../src/decisioning/family-registry';
import {
  loadCanaryCorpus,
  canaryDivergence,
  answerIsCorrect,
  validateCanaryRow,
  SEED_CANARIES,
} from '../src/decisioning/canary-corpus';
import { extractFromRouterOutput, extractFromCommaResult } from '../src/decisioning/rule-extraction';
import { anfisRecommendProvider } from '../src/services/anfis-router';
import { commaANFIS } from '../src/services/anfis-comma';

// ---------------------------------------------------------------------------------------------------
// 1) UNIFORM-RANDOM VERIFICATION FLOOR — rate ≈ configured, seedable, not suspicion-coupled.
// ---------------------------------------------------------------------------------------------------
describe('verification-sampler (uniform-random floor)', () => {
  // Build N synthetic uuid-like ids (random -> mimics real uuid entropy the sampler relies on).
  function makeIds(n: number): CompletedCall[] {
    const out: CompletedCall[] = [];
    for (let i = 0; i < n; i++) {
      // pseudo-uuid; entropy is what matters for uniformity
      const id = `${i}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
      out.push({ id, status: 'success' });
    }
    return out;
  }

  it('observed rate ≈ configured rate over a large batch (default 0.05)', () => {
    const cfg: SamplerConfig = { rate: DEFAULT_SAMPLER_RATE, seed: 'test-seed' };
    const calls = makeIds(20000);
    const res = selectVerificationFloor(calls, cfg);
    expect(res.consideredCount).toBe(20000);
    // within a reasonable band of the configured 0.05 (binomial noise on 20k samples)
    expect(res.observedRate).toBeGreaterThan(0.04);
    expect(res.observedRate).toBeLessThan(0.06);
  });

  it('honors a different configured rate (0.20)', () => {
    const cfg: SamplerConfig = { rate: 0.2, seed: 'test-seed' };
    const res = selectVerificationFloor(makeIds(20000), cfg);
    expect(res.observedRate).toBeGreaterThan(0.18);
    expect(res.observedRate).toBeLessThan(0.22);
  });

  it('is seedable/deterministic — same (seed,id) => same decision', () => {
    const id = 'abc-123-def';
    const a = shouldSample(id, { rate: 0.5, seed: 'S' });
    const b = shouldSample(id, { rate: 0.5, seed: 'S' });
    expect(a).toBe(b);
    // inclusionScore is a stable function of (seed,id)
    expect(inclusionScore(id, 'S')).toBe(inclusionScore(id, 'S'));
  });

  it('rate=0 selects nothing; rate=1 selects everything', () => {
    const calls = makeIds(500);
    expect(selectVerificationFloor(calls, { rate: 0, seed: 'S' }).sampledIds.length).toBe(0);
    expect(selectVerificationFloor(calls, { rate: 1, seed: 'S' }).sampledIds.length).toBe(500);
  });

  it('excludes non-completed calls from the denominator (completed = terminal status)', () => {
    const calls: CompletedCall[] = [
      { id: 'a', status: 'success' },
      { id: 'b', status: 'failed' },
      { id: 'c', status: 'rate_limited' },
      { id: 'd', status: 'pending' }, // not terminal -> skipped
      { id: 'e', status: null },      // not terminal -> skipped
    ];
    const res = selectVerificationFloor(calls, { rate: 1, seed: 'S' });
    expect(res.consideredCount).toBe(3);
    expect(res.skippedNotCompleted).toBe(2);
    expect(isCompletedDefault({ id: 'x', status: 'success' })).toBe(true);
    expect(isCompletedDefault({ id: 'x', status: 'pending' })).toBe(false);
  });

  it('config-driven from env; bad rate falls back to default with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(configFromEnv({ [SAMPLER_ENV.RATE]: '0.1', [SAMPLER_ENV.SEED]: 'x' }).rate).toBe(0.1);
    expect(configFromEnv({ [SAMPLER_ENV.RATE]: '5' }).rate).toBe(DEFAULT_SAMPLER_RATE); // out of range
    expect(warn).toHaveBeenCalled();
    expect(configFromEnv({}).rate).toBe(DEFAULT_SAMPLER_RATE); // absent -> default
    warn.mockRestore();
  });

  it('inclusion decision reads ONLY id+status — the signature cannot accept a suspicion signal', () => {
    // Compile-time guarantee is the type; runtime: two calls with identical id but wildly different
    // "confidence" would be identical because confidence is not an input at all. We simulate by proving
    // the score depends only on (seed,id).
    expect(inclusionScore('same-id', 'seedA')).not.toBe(inclusionScore('same-id', 'seedB'));
    expect(inclusionScore('id1', 'seed')).not.toBe(inclusionScore('id2', 'seed'));
  });
});

// ---------------------------------------------------------------------------------------------------
// 2) FAMILY-DISJOINT JURY — excludes the generating family (§7 no self-grading).
// ---------------------------------------------------------------------------------------------------
describe('jury-assembly (family-disjoint, excludes generating family)', () => {
  // Pool of registry-mapped judges spanning several families.
  const pool: ModelRef[] = [
    { provider: 'groq', model: 'llama-3.1-8b-instant' },   // llama
    { provider: 'gemini', model: 'gemini-2.0-flash' },     // gemini
    { provider: 'mistral', model: 'mistral-small-latest' },// mistral
    { provider: 'deepseek', model: 'deepseek-chat' },      // deepseek
    { provider: 'openai', model: 'gpt-4o-mini' },          // openai
  ];

  it('assembles a jury that EXCLUDES the generating model family', () => {
    const generating = { provider: 'groq', model: 'llama-3.1-8b-instant' }; // llama
    const res = assembleJuryForCall(generating, pool, 3, 'call-123');
    expect(res.ok).toBe(true);
    expect(res.generatingFamily).toBe('llama');
    // no judge is llama
    for (const j of res.judges) expect(resolveFamily(j.model)).not.toBe('llama');
    expect(res.judgeFamilies).not.toContain('llama');
    expect(res.excludesGeneratingFamily).toBe(true);
  });

  it('is deterministic given the seed (auditable)', () => {
    const gen = { provider: 'gemini', model: 'gemini-2.0-flash' };
    const a = assembleJuryForCall(gen, pool, 3, 'seed-X');
    const b = assembleJuryForCall(gen, pool, 3, 'seed-X');
    expect(a.judgeFamilies).toEqual(b.judgeFamilies);
    expect(a.judges.map((j) => j.model)).toEqual(b.judges.map((j) => j.model));
  });

  it('fails (does not pad) when too few disjoint families exist', () => {
    // generating=gemini leaves 4 non-gemini families in the pool; ask for 5 -> impossible
    const gen = { provider: 'gemini', model: 'gemini-2.0-flash' };
    const res = assembleJuryForCall(gen, pool, 5, 'seed-Y');
    expect(res.ok).toBe(false);
    expect(res.judges.length).toBe(0);
    expect(res.failure).toMatch(/disjoint judge famil/i);
  });

  it('hard-fails on an unmapped generating model (register-first, never guess)', () => {
    expect(() => assembleJuryForCall({ model: 'hf/phi-4-mini' }, pool, 2, 's')).toThrow(UnmappedFamilyError);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3) CANARY — divergence computes; loader accepts external corpus + rejects bad rows.
// ---------------------------------------------------------------------------------------------------
describe('canary-corpus (Goodhart tripwire)', () => {
  it('loads the seed corpus with real known-answer checks', () => {
    const { probes, source } = loadCanaryCorpus();
    expect(probes.length).toBe(SEED_CANARIES.length);
    expect(source).toBe('SEED_CANARIES');
  });

  it('answerIsCorrect verifies known answers WITHOUT an LLM', () => {
    const arith = SEED_CANARIES.find((p) => p.id === 'canary-arith-1')!;
    expect(answerIsCorrect(arith, 'the answer is 68')).toBe(true);
    expect(answerIsCorrect(arith, '70')).toBe(false);
    const cap = SEED_CANARIES.find((p) => p.id === 'canary-geo-capital-fr')!;
    expect(answerIsCorrect(cap, 'The capital is Paris.')).toBe(true);
    expect(answerIsCorrect(cap, 'Lyon')).toBe(false);
  });

  it('canaryDivergence = fraction of jury judges WRONG on a known answer', () => {
    const water = SEED_CANARIES.find((p) => p.id === 'canary-chem-water')!;
    // 2 correct, 2 wrong => divergence 0.5. (Note: the check matches literal "h2o"; a Unicode-subscript
    // "H₂O" would NOT match — by design, the probe expects plain-digit chemical formula.)
    const d = canaryDivergence(water, ['H2O', 'water is h2o', 'CO2', 'salt']);
    expect(d.juryN).toBe(4);
    expect(d.correctCount).toBe(2);
    expect(d.divergence).toBeCloseTo(0.5, 5);
    // perfect jury => 0 divergence
    expect(canaryDivergence(water, ['H2O', 'h2o']).divergence).toBe(0);
  });

  it('loads an EXTERNAL corpus file, merges + dedupes, and rejects bad rows loudly', () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const file = path.join(os.tmpdir(), `canary-ext-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'ext-1', prompt: '2+2? number only', knownAnswer: '4', checkKind: 'numeric', source: 'arith' },
        { id: 'bad-1', prompt: 'x', knownAnswer: '', checkKind: 'exact', source: 's' }, // empty knownAnswer -> reject
        { id: 'bad-2', prompt: 'x', knownAnswer: 'y', checkKind: 'nonsense', source: 's' }, // bad kind -> reject
        { id: 'canary-arith-1', prompt: 'override', knownAnswer: '68', checkKind: 'numeric', source: 'override' }, // dedupe by id
      ]),
    );
    const { probes, rejected } = loadCanaryCorpus(file);
    const ids = probes.map((p) => p.id);
    expect(ids).toContain('ext-1');
    expect(rejected.length).toBe(2); // bad-1, bad-2
    // still only one canary-arith-1 (external overrides seed on id collision)
    expect(ids.filter((i) => i === 'canary-arith-1').length).toBe(1);
    fs.unlinkSync(file);
  });

  it('validateCanaryRow rejects a non-compiling regex probe', () => {
    const res = validateCanaryRow({ id: 'r', prompt: 'p', knownAnswer: '[', checkKind: 'regex', source: 's' }, 0);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// 4) RULE EXTRACTION — non-empty on a REAL decision.
// ---------------------------------------------------------------------------------------------------
describe('rule-extraction (glass box)', () => {
  it('extracts non-empty fired rules + LASSO drivers from a REAL router decision', () => {
    const out = anfisRecommendProvider('classify this short fact', 'classify');
    const ex = extractFromRouterOutput(out);
    expect(ex.hasRuleWeights).toBe(true);
    expect(ex.firedRules.length).toBeGreaterThan(0);
    expect(ex.topRule).not.toBeNull();
    expect(ex.ruleWeights.length).toBeGreaterThan(0);
    // strengths are sorted descending (top is the max)
    expect(ex.topRule!.strength).toBeGreaterThanOrEqual(ex.firedRules[ex.firedRules.length - 1]!.strength);
    // real LASSO driver names are a subset of the known feature set
    const known = new Set(['len', 'low', 'cat', 'cost', 'rate', 'qual']);
    for (const d of ex.lassoDrivers) expect(known.has(d)).toBe(true);
    expect(ex.summary).toMatch(/untrained/i); // honesty caveat present
  });

  it('extracts from a REAL commaANFIS result (dissonance path, no LASSO)', () => {
    const res = commaANFIS([0.8, 0.7, 0.3, 0.3, 0.28]);
    const ex = extractFromCommaResult(res);
    expect(ex.hasRuleWeights).toBe(true);
    expect(ex.firedRules.length).toBe(5); // 5-rule base
    expect(ex.hasLassoDrivers).toBe(false); // comma path exposes no LASSO features
    expect(ex.summary).toMatch(/comma-dissonance/);
  });

  it('honestly reports empty when a source exposes no rule weights', () => {
    const ex = extractFromRouterOutput({ recommendedProvider: 'x', recommendedTier: '0a', confidence: 0.5 });
    expect(ex.hasRuleWeights).toBe(false);
    expect(ex.firedRules.length).toBe(0);
    expect(ex.topRule).toBeNull();
  });
});
