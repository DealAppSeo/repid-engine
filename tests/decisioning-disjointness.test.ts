/**
 * Self-test for the §7 family-disjointness gate + family registry.
 * OUTPUT_PATH: tests/decisioning-disjointness.test.ts
 * Placed under tests/ (the only dir jest.config.js roots on — per CLAUDE.md test-layout quirk).
 *
 * REQUIRED CHECKS (from the Phase-1 gate): the module must REJECT a same-family judge and ACCEPT a
 * disjoint one; an unmapped model must HARD-FAIL (register first, never guess).
 */

import {
  checkDisjoint,
  assertDisjoint,
  assembleDisjointJudges,
  type DisjointViolation,
} from '../src/decisioning/disjointness';
import {
  resolveFamily,
  isMapped,
  UnmappedFamilyError,
  KNOWN_UNMAPPED,
  FAMILY_REGISTRY_SEED,
  AMBIGUOUS_SEED,
  isAmbiguousFamily,
  matchedFamilies,
  seedFamilyFor,
} from '../src/decisioning/family-registry';

describe('family-registry lookup', () => {
  it('resolves seeded models to their real family', () => {
    expect(resolveFamily('llama-3.1-8b-instant')).toBe('llama');
    expect(resolveFamily('zai-glm-4.7')).toBe('glm');
    expect(resolveFamily('gemini-2.0-flash')).toBe('gemini');
    expect(resolveFamily('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(resolveFamily('deepseek-chat')).toBe('deepseek');
  });

  it('HARD-FAILS on an unmapped model (no guess)', () => {
    // 'test-model' and 'unknown' are the real telemetry sentinels familyOf() cannot resolve.
    expect(() => resolveFamily('test-model')).toThrow(UnmappedFamilyError);
    expect(() => resolveFamily('unknown')).toThrow(UnmappedFamilyError);
    expect(isMapped('test-model')).toBe(false);
    // hf/phi-4-mini: real 'phi' model but familyOf has no rule -> must NOT be silently accepted.
    expect(isMapped('hf/phi-4-mini')).toBe(false);
  });

  it('records the 6 known-unmapped telemetry pairs for Sean (no invented families)', () => {
    expect(KNOWN_UNMAPPED.length).toBe(6);
    const models = KNOWN_UNMAPPED.map((u) => u.model).sort();
    expect(models).toContain('hf/phi-4-mini');
    expect(models.filter((m) => m === 'test-model').length).toBe(2);
    expect(models.filter((m) => m === 'unknown').length).toBe(3);
  });

  // ---- FIX CYCLE 1 (XC red-team repro): the familyOf() first-match bypass is closed ----
  it('REGRESSION: an aliased Llama model is NOT silently resolved to deepseek (register-first)', () => {
    // XC repro: `deepseek-llama-3.3-70b` matches /deepseek/ before /llama/ in familyOf(); the old
    // fallback returned 'deepseek', letting a Llama judge pass disjointness against a Llama candidate.
    // Runtime is now REGISTRY-ONLY: this model is not seeded, so it HARD-FAILS (never guesses 'deepseek').
    expect(() => resolveFamily('deepseek-llama-3.3-70b')).toThrow(UnmappedFamilyError);
    expect(isMapped('deepseek-llama-3.3-70b')).toBe(false);
    // and the mirror alias order is handled identically
    expect(() => resolveFamily('llama-deepseek-chat')).toThrow(UnmappedFamilyError);
    expect(isMapped('llama-deepseek-chat')).toBe(false);
  });

  it('SEED INTEGRITY: multi-family names are flagged AMBIGUOUS, never first-matched', () => {
    expect(matchedFamilies('deepseek-llama-3.3-70b').sort()).toEqual(['deepseek', 'llama']);
    expect(isAmbiguousFamily('deepseek-llama-3.3-70b')).toBe(true);
    expect(isAmbiguousFamily('llama-deepseek-chat')).toBe(true);
    // the seed-build guard REFUSES to seed an ambiguous name (goes to register-explicitly path)
    const s1 = seedFamilyFor('deepseek-llama-3.3-70b');
    expect(s1.seed).toBe(false);
    if (!s1.seed) expect(s1.reason).toMatch(/AMBIGUOUS/);
    const s2 = seedFamilyFor('llama-deepseek-chat');
    expect(s2.seed).toBe(false);
    // an unambiguous, known-family name still seeds cleanly
    const s3 = seedFamilyFor('llama-3.1-8b-instant');
    expect(s3.seed).toBe(true);
    if (s3.seed) expect(s3.family).toBe('llama');
  });

  // ---- FIX CYCLE 2 (XC red-team repro #2): the EXISTING seed is swept for ambiguity ----
  it('SEED SWEEP: the whole seed is swept; the ambiguous hf/deepseek-r1-qwen-32b is EXCLUDED', () => {
    // Exactly one grandfathered seed row is ambiguous (1/21): a DeepSeek-R1-distill-Qwen hybrid that
    // matches BOTH /deepseek/ AND /qwen/. It must be swept out of BY_MODEL (register-first), not
    // first-matched to 'deepseek'.
    expect(AMBIGUOUS_SEED.length).toBe(1);
    expect(AMBIGUOUS_SEED[0]!.model).toBe('hf/deepseek-r1-qwen-32b');
    expect(AMBIGUOUS_SEED[0]!.matchedFamilies.sort()).toEqual(['deepseek', 'qwen']);
    expect(isAmbiguousFamily('hf/deepseek-r1-qwen-32b')).toBe(true);
  });

  it('REGRESSION (XC #2): hf/deepseek-r1-qwen-32b HARD-FAILS — no clean deepseek pass', () => {
    // Before the sweep it was seeded as 'deepseek'; now it is unmapped and throws (register-first).
    expect(() => resolveFamily('hf/deepseek-r1-qwen-32b')).toThrow(UnmappedFamilyError);
    expect(isMapped('hf/deepseek-r1-qwen-32b')).toBe(false);
  });

  it('REGRESSION (XC #2): a Qwen-lineage judge canNOT clean-pass §7 against a Qwen candidate', () => {
    // XC repro: candidate hf/qwen-2.5-72b (qwen) vs judge hf/deepseek-r1-qwen-32b (Qwen-lineage).
    // The old bug: judge resolved to 'deepseek' -> checkDisjoint returned disjoint=true (WRONG).
    // Now the ambiguous judge is unmapped, so checkDisjoint THROWS rather than falsely passing.
    const candidate = [{ provider: 'litellm', model: 'hf/qwen-2.5-72b' }];
    const qwenLineageJudge = [{ provider: 'litellm', model: 'hf/deepseek-r1-qwen-32b' }];
    expect(() => checkDisjoint(candidate, qwenLineageJudge)).toThrow(UnmappedFamilyError);
  });

  it('NO REGRESSION: the 20 unambiguous seeded telemetry models still resolve to their family', () => {
    expect(FAMILY_REGISTRY_SEED.length).toBe(21); // seed table unchanged; sweep is at load time
    const legit = FAMILY_REGISTRY_SEED.filter((e) => !isAmbiguousFamily(e.model));
    expect(legit.length).toBe(20); // exactly one (hf/deepseek-r1-qwen-32b) swept out
    for (const e of legit) {
      expect(resolveFamily(e.model)).toBe(e.family);
    }
  });
});

describe('§7 disjointness gate', () => {
  const candidates = [{ provider: 'groq', model: 'llama-3.1-8b-instant' }]; // family: llama

  it('REJECTS a same-family judge (Llama judging Llama = self-grading)', () => {
    const sameFamilyJudge = [{ provider: 'cerebras', model: 'llama3.1-8b' }]; // family: llama
    const res = checkDisjoint(candidates, sameFamilyJudge);
    expect(res.disjoint).toBe(false);
    expect(res.sharedFamilies).toEqual(['llama']);
  });

  it('ACCEPTS a disjoint judge (Gemini judging Llama)', () => {
    const disjointJudge = [{ provider: 'gemini', model: 'gemini-2.0-flash' }]; // family: gemini
    const res = checkDisjoint(candidates, disjointJudge);
    expect(res.disjoint).toBe(true);
    expect(res.sharedFamilies).toEqual([]);
  });

  it('assertDisjoint fires a REAL sink on violation (no silent swallow)', () => {
    const captured: DisjointViolation[] = [];
    const res = assertDisjoint(candidates, [{ model: 'llama3.1-8b' }], {
      sink: (v) => captured.push(v),
      context: 'self-test',
    });
    expect(res.disjoint).toBe(false);
    expect(captured.length).toBe(1);
    expect(captured[0]!.shared_families).toEqual(['llama']);
    expect(captured[0]!.context).toBe('self-test');
  });

  it('assertDisjoint does NOT fire the sink when disjoint', () => {
    const captured: DisjointViolation[] = [];
    const res = assertDisjoint(candidates, [{ model: 'gemini-2.0-flash' }], { sink: (v) => captured.push(v) });
    expect(res.disjoint).toBe(true);
    expect(captured.length).toBe(0);
  });

  it('throwOnViolation hard-stops label assembly', () => {
    expect(() =>
      assertDisjoint(candidates, [{ model: 'llama3.1-8b' }], { sink: () => {}, throwOnViolation: true }),
    ).toThrow(/VIOLATION/);
  });
});

describe('seeded rotation for judge assembly (real, deterministic — no fake logs)', () => {
  const candidates = [{ provider: 'groq', model: 'llama-3.1-8b-instant' }]; // llama
  // Pool spans several disjoint families + one same-family (llama) that must be excluded.
  const pool = [
    { provider: 'gemini', model: 'gemini-2.0-flash' },       // gemini
    { provider: 'mistral', model: 'mistral-small-latest' },  // mistral
    { provider: 'deepseek', model: 'deepseek-chat' },        // deepseek
    { provider: 'cerebras', model: 'zai-glm-4.7' },          // glm
    { provider: 'cerebras', model: 'llama3.1-8b' },          // llama (MUST be excluded)
  ];

  it('assembles k disjoint-family judges, excluding the candidate family', () => {
    const a = assembleDisjointJudges(candidates, pool, 2, 'req-123');
    expect(a.ok).toBe(true);
    expect(a.judges.length).toBe(2);
    expect(a.judgeFamilies).not.toContain('llama');
    // assembled set is genuinely disjoint
    expect(checkDisjoint(candidates, a.judges).disjoint).toBe(true);
  });

  it('is deterministic for the same seed and rotates with the seed', () => {
    const a = assembleDisjointJudges(candidates, pool, 2, 'seedA');
    const aAgain = assembleDisjointJudges(candidates, pool, 2, 'seedA');
    expect(aAgain.judgeFamilies).toEqual(a.judgeFamilies); // determinism
    // a different seed is allowed to (and generally does) pick a different rotation offset
    const b = assembleDisjointJudges(candidates, pool, 4, 'seedB');
    expect(b.ok).toBe(true);
    expect(new Set(b.judgeFamilies).size).toBe(4); // 4 distinct families, none llama
  });

  it('FAILS (does not pad with same-family) when not enough disjoint families exist', () => {
    const thinPool = [{ provider: 'cerebras', model: 'llama3.1-8b' }]; // only llama (== candidate family)
    const a = assembleDisjointJudges(candidates, thinPool, 1, 'req-x');
    expect(a.ok).toBe(false);
    expect(a.judges.length).toBe(0);
    expect(a.failure).toMatch(/NOT padding/);
  });
});
