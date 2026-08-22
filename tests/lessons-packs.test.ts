/**
 * lessons-packs.test.ts — proves the domain-pack second tier actually fires.
 *
 * Without this, keyword matching FAILS OPEN (LESSONS §5): a brief says "proof system",
 * the trigger says "plonky3", the pack silently does not load, and you have a rule that
 * exists and did not apply. So: every pack must declare >=1 trigger, and every pack must
 * fire against a representative brief written in natural language (not the trigger line
 * copied back). require() the CommonJS matcher so this runs on Windows too — importing
 * the ESM run-agent.mjs by absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME there.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadPacks, matchPacks, parseTriggers } = require('../scripts/dispatch/lessons-lib');

const LESSONS_DIR = path.join(__dirname, '..', 'lessons');

// Natural-language briefs that a real dispatch might carry — deliberately NOT the
// trigger list. If a new pack ships without a fixture here, the loop below fails.
const REPRESENTATIVE: Record<string, string> = {
  dispatch: 'Coordinator: fix the sprint-daemon self-chain deadlock and validate two consecutive dispatches in one worktree.',
  'hal-eval': 'Measure HAL F1 on the rigorous corpus across all providers and report the quorum and any provider failures.',
  schema: 'Land a migration adding sufficient-statistic columns to the score-event table; read the CHECK constraint before writing SQL.',
  zkp: 'Wire the plonky3 aggregation over the poseidon2 leaf and keep the A1 statement arity fixed.',
};

describe('LESSONS domain packs', () => {
  const packs = loadPacks(LESSONS_DIR);

  it('loads at least the four shipped packs (guards against an empty/false-green scan)', () => {
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expect(packs.map((p: any) => p.name).sort()).toEqual(
      expect.arrayContaining(['dispatch', 'hal-eval', 'schema', 'zkp']),
    );
  });

  it('every pack declares >=1 trigger — a pack with none can never fire', () => {
    const noTrigger = packs.filter((p: any) => p.triggers.length === 0).map((p: any) => p.name);
    expect(noTrigger).toEqual([]);
  });

  it('every pack has a fixture brief in this test (so new packs cannot ship untested)', () => {
    const missing = packs.map((p: any) => p.name).filter((n: string) => !(n in REPRESENTATIVE));
    expect(missing).toEqual([]);
  });

  for (const p of packs) {
    it(`pack "${p.name}" fires on a natural-language brief`, () => {
      const brief = REPRESENTATIVE[p.name];
      const matched = matchPacks(brief, packs).map((m: any) => m.name);
      expect(matched).toContain(p.name);
    });
  }

  it('matches by substring, not exact token (the whole point)', () => {
    // "proofs" contains "proof"; a real brief rarely uses the exact trigger word.
    expect(matchPacks('working on zero-knowledge proofs', packs).map((m: any) => m.name)).toContain('zkp');
  });

  it('loads nothing for text that contains no trigger', () => {
    const matched = matchPacks('write landing page hero copy and a launch announcement', packs);
    expect(matched.map((m: any) => m.name)).not.toContain('zkp');
    expect(matched.map((m: any) => m.name)).not.toContain('hal-eval');
  });

  it('parseTriggers lowercases and splits on commas and whitespace', () => {
    expect(parseTriggers('<!-- triggers: Foo, BAR baz -->')).toEqual(['foo', 'bar', 'baz']);
    expect(parseTriggers('no header here')).toEqual([]);
  });
});
