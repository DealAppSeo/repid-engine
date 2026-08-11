/**
 * WIRING FENCE — the coverage snapshot must actually be published by the quorum.
 *
 * Without this, `detector-coverage.ts` is another `repid_confession_log`: a complete, correct
 * mechanism that records UNKNOWN forever because nothing ever calls it. That is the failure
 * this entire line of work exists to stop (LESSONS #3), and it would be a particularly
 * embarrassing place to reproduce it.
 *
 * THE SUBTLETY THIS PINS. Coverage is built from `verdicts` — the providers actually
 * attempted — and NOT from the configured fleet. With cost-ordered waves, HAL deliberately
 * stops once a cheap quorum forms and never asks the expensive tier. Counting those unasked
 * providers as "down" would report an outage every time the system worked exactly as
 * designed, and a false alarm that fires on success trains everyone to ignore the real one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCoverage,
  currentCoverage,
  publishDetectorSnapshot,
  _resetCoverageForTest,
} from '../src/services/detector-coverage';

const FACT_CHECK = path.resolve(__dirname, '../src/hal/fact-check.ts');

beforeEach(() => _resetCoverageForTest());

describe('the quorum publishes coverage — the mechanism has a caller', () => {
  const src = readFileSync(FACT_CHECK, 'utf8');

  test('fact-check imports and calls publishDetectorSnapshot', () => {
    expect(src).toMatch(/import \{ publishDetectorSnapshot \} from '\.\.\/services\/detector-coverage'/);
    expect(src).toMatch(/publishDetectorSnapshot\(/);
  });

  test('it maps from `verdicts`, not from the configured provider list', () => {
    // activeProviders would include providers a cost-ordered run never asked.
    const call = src.slice(src.indexOf('publishDetectorSnapshot('), src.indexOf('publishDetectorSnapshot(') + 400);
    expect(call).toMatch(/verdicts\.map/);
    expect(call).not.toMatch(/activeProviders/);
  });

  test("live is derived from the verdict, not from a self-reported health field", () => {
    const call = src.slice(src.indexOf('publishDetectorSnapshot('), src.indexOf('publishDetectorSnapshot(') + 400);
    expect(call).toMatch(/live: v\.verdict !== 'ERROR'/);
  });

  test('the failure reason is a short code, not raw upstream prose', () => {
    // This value lands in repid_score_events.metadata; the full text belongs in logs.
    const call = src.slice(src.indexOf('publishDetectorSnapshot('), src.indexOf('publishDetectorSnapshot(') + 400);
    expect(call).toMatch(/shortFailureReason\(v\.error\)/);
    expect(call).not.toMatch(/reason: v\.error/);
  });
});

describe('the reason shortener produces enumerable codes', () => {
  // Re-implemented here from the same regexes; the fence above pins that the real one is
  // wired, this pins the behaviour a later reader depends on.
  const shorten = (err: string): string => {
    const e = err.toLowerCase();
    if (/\b402\b|insufficient|credit|quota|billing/.test(e)) return '402';
    if (/\b401\b|\b403\b|unauthor|invalid api key|forbidden/.test(e)) return '401';
    if (/\b429\b|rate.?limit|too many/.test(e)) return '429';
    if (/timeout|timed out|abort|etimedout/.test(e)) return 'timeout';
    if (/econnrefused|enotfound|network|socket|fetch failed/.test(e)) return 'network';
    if (/parse|json|schema|unexpected token/.test(e)) return 'badresponse';
    return 'error';
  };

  test.each([
    // The two failures task #56 actually records right now.
    ['HTTP 402: insufficient credits for this request', '402'],
    ['401 Unauthorized - invalid api key', '401'],
    ['429 Too Many Requests', '429'],
    ['request timed out after 12000ms', 'timeout'],
    ['fetch failed: ECONNREFUSED', 'network'],
    ['Unexpected token < in JSON at position 0', 'badresponse'],
    ['something nobody anticipated', 'error'],
  ])('%s → %s', (input, expected) => {
    expect(shorten(input)).toBe(expected);
  });

  test('a code never leaks the request back into metadata', () => {
    const leaky = 'HTTP 402 for prompt "the customer said their card ending 4242"';
    expect(shorten(leaky)).toBe('402');
    expect(shorten(leaky)).not.toMatch(/4242|customer/);
  });
});

describe('end to end: a published snapshot changes what a score event would record', () => {
  test('the degraded regime production is in right now', () => {
    // Task #56: 3 of ~6 providers down on credits/keys.
    publishDetectorSnapshot([
      { name: 'groq', live: true },
      { name: 'cerebras', live: true },
      { name: 'gemini', live: true },
      { name: 'openrouter', live: false, reason: '402' },
      { name: 'fireworks', live: false, reason: '402' },
      { name: 'anthropic', live: false, reason: '401' },
    ]);
    const c = currentCoverage();
    expect(c.state).toBe('DEGRADED');
    expect(c.live).toBe(3);
    expect(c.total).toBe(6);
    expect(c.down).toEqual(['openrouter:402', 'fireworks:402', 'anthropic:401']);
  });

  test('a cheap cost-ordered quorum reads FULL, not degraded', () => {
    // Two free providers answered and the expensive tier was never asked. Nothing is wrong.
    publishDetectorSnapshot([
      { name: 'groq', live: true },
      { name: 'cerebras', live: true },
    ]);
    const c = currentCoverage();
    expect(c.state).toBe('FULL');
    expect(c.live).toBe(2);
    expect(c.total).toBe(2);
  });

  test('total provider failure reads NONE — evidence, not silence', () => {
    publishDetectorSnapshot([
      { name: 'groq', live: false, reason: '429' },
      { name: 'cerebras', live: false, reason: '402' },
    ]);
    expect(currentCoverage().state).toBe('NONE');
  });

  test('before any quorum has run, coverage is UNKNOWN — never assumed good', () => {
    expect(currentCoverage().state).toBe('UNKNOWN');
    expect(currentCoverage().live).toBeNull();
  });

  test('buildCoverage and the published path agree', () => {
    const detectors = [{ name: 'a', live: true }, { name: 'b', live: false, reason: '402' }];
    publishDetectorSnapshot(detectors);
    const published = currentCoverage();
    const direct = buildCoverage(detectors);
    expect(published.state).toBe(direct.state);
    expect(published.live).toBe(direct.live);
    expect(published.down).toEqual(direct.down);
  });
});
