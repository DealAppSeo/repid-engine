/**
 * DETECTOR-COVERAGE FENCE — a score must never be recorded without its ruler.
 *
 * MEASURED 2026-08-11: 99.86% of negative reputation events (68,321 of 68,417) come from a
 * single detector, and task #56 records 3 of ~6 HAL providers down. So the sole source of
 * punitive signal is degraded right now.
 *
 * The outage is not the danger. The danger is that **a detector outage and a genuine
 * improvement in agent behaviour produce the identical signature** — fewer negative events.
 * Nothing in 152,130 rows of history distinguishes "agents got better" from "the thing that
 * notices stopped noticing", and nobody reading it later can either. LESSONS #8, applied to
 * reputation rather than to HAL's F1.
 *
 * THE PROPERTY UNDER TEST, and the one that is easy to get wrong: unknown coverage must be
 * recorded as UNKNOWN, never omitted and never defaulted to full. An absent ruler that reads
 * as the good ruler is worse than no field at all — it is the same "unwired mechanism becomes
 * false coverage" failure that left repid_confession_log empty while the schema implied just
 * culture was handled.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCoverage,
  withCoverage,
  currentCoverage,
  publishDetectorSnapshot,
  _resetCoverageForTest,
  COVERAGE_KEY,
  type DetectorState,
} from '../src/services/detector-coverage';

const SIX = (liveCount: number): DetectorState[] =>
  ['groq', 'cerebras', 'gemini', 'openrouter', 'fireworks', 'anthropic'].map((name, i) => ({
    name,
    live: i < liveCount,
    ...(i < liveCount ? {} : { reason: '402' }),
  }));

beforeEach(() => _resetCoverageForTest());

describe('coverage states are distinguished, not collapsed', () => {
  test('all six live → FULL', () => {
    const c = buildCoverage(SIX(6));
    expect(c.state).toBe('FULL');
    expect(c.live).toBe(6);
    expect(c.total).toBe(6);
    expect(c.down).toBeUndefined();
  });

  test('three of six → DEGRADED, and it names which are down', () => {
    // This is the regime production is in right now per task #56.
    const c = buildCoverage(SIX(3));
    expect(c.state).toBe('DEGRADED');
    expect(c.live).toBe(3);
    expect(c.total).toBe(6);
    expect(c.down).toEqual(['openrouter:402', 'fireworks:402', 'anthropic:402']);
  });

  test('none live → NONE, which is EVIDENCE about the providers', () => {
    const c = buildCoverage(SIX(0));
    expect(c.state).toBe('NONE');
    expect(c.live).toBe(0);
    expect(c.total).toBe(6);
  });

  test('nobody asked → UNKNOWN, which is NOT evidence and must not read as NONE', () => {
    // "we asked and nobody answered" and "we never asked" are different facts. Collapsing
    // them would let a scoring path with no detector wired look like a total outage, or
    // worse, let a total outage look like a deliberate no-op.
    for (const empty of [undefined, null, []]) {
      const c = buildCoverage(empty as never);
      expect(c.state).toBe('UNKNOWN');
      expect(c.live).toBeNull();
      expect(c.total).toBeNull();
      expect(c.unknown_because).toMatch(/no detector snapshot/);
    }
  });

  test('live counts are truthy-strict — only an explicit true counts as answered', () => {
    const sloppy = [
      { name: 'a', live: true },
      { name: 'b', live: 1 as unknown as boolean },
      { name: 'c', live: 'yes' as unknown as boolean },
    ];
    expect(buildCoverage(sloppy).live).toBe(1);
  });
});

describe('coverage rides in metadata without disturbing it', () => {
  test('existing keys survive', () => {
    const out = withCoverage({ existing: 1, nested: { a: 2 } }, buildCoverage(SIX(6)));
    expect(out.existing).toBe(1);
    expect(out.nested).toEqual({ a: 2 });
    expect((out[COVERAGE_KEY] as { state: string }).state).toBe('FULL');
  });

  test('null / undefined metadata is fine', () => {
    expect(withCoverage(null, buildCoverage(SIX(6)))[COVERAGE_KEY]).toBeDefined();
    expect(withCoverage(undefined, buildCoverage(SIX(6)))[COVERAGE_KEY]).toBeDefined();
  });

  test('the input is not mutated', () => {
    const original = { a: 1 };
    withCoverage(original, buildCoverage(SIX(6)));
    expect(original).toEqual({ a: 1 });
  });
});

describe('a stale snapshot is UNKNOWN, not a comforting old number', () => {
  // Reporting twenty-minute-old coverage as current would be a more convincing lie than
  // reporting nothing, because it looks like a measurement.
  const T0 = 1_760_000_000_000;

  test('fresh snapshot is used', () => {
    publishDetectorSnapshot(SIX(3), T0);
    const c = currentCoverage(T0 + 60_000);
    expect(c.state).toBe('DEGRADED');
    expect(c.live).toBe(3);
  });

  test('a snapshot older than the max age degrades to UNKNOWN and says how old', () => {
    publishDetectorSnapshot(SIX(6), T0);
    const c = currentCoverage(T0 + 6 * 60 * 1000);
    expect(c.state).toBe('UNKNOWN');
    expect(c.live).toBeNull();
    expect(c.unknown_because).toMatch(/snapshot is \d+s old/);
  });

  test('no snapshot at all is UNKNOWN', () => {
    expect(currentCoverage(T0).state).toBe('UNKNOWN');
  });
});

describe('every guarded score write is stamped — at the chokepoint, not per caller', () => {
  // A per-call-site "remember to add coverage" list is the hand-maintained enumeration that
  // has already failed three times in this repo (a copied resolver, a grep that missed a
  // local, a router list of 8 when there were 41).
  const WRITER = path.resolve(__dirname, '../src/scoring/score-event-writer.ts');

  test('insertScoreEvent stamps coverage into metadata', () => {
    const src = readFileSync(WRITER, 'utf8');
    expect(src).toMatch(/import \{ currentCoverage, withCoverage \}/);
    expect(src).toMatch(/metadata: withCoverage\(e\.metadata, currentCoverage\(\)\)/);
  });

  test('it does NOT pass raw metadata through — that would be the unstamped path', () => {
    const src = readFileSync(WRITER, 'utf8');
    const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    // The old line was `metadata: e.metadata ?? {},`. If it comes back, coverage silently stops.
    expect(lines.join('\n')).not.toMatch(/metadata:\s*e\.metadata\s*\?\?\s*\{\}/);
  });
});
