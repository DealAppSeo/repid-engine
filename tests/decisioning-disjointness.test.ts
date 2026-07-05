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
import { resolveFamily, isMapped, UnmappedFamilyError, KNOWN_UNMAPPED } from '../src/decisioning/family-registry';

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
