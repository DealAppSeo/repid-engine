/**
 * scripts/eval/jev-shadow.ts — the prepared (not run) Jev shadow eval. Fake decide only; no network.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CORPUS_PATH,
  CORPUS_V1_SHA256,
  corpusHash,
  estimateCostUsd,
  runShadow,
  summarizeShadow,
  type CorpusRow,
} from '../scripts/eval/jev-shadow';

const rows = (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { rows: CorpusRow[] }).rows;

describe('the frozen corpus', () => {
  it('matches its pinned hash, has both labels, and unique ids', () => {
    expect(corpusHash(rows)).toBe(CORPUS_V1_SHA256);
    expect(rows.filter((r) => r.label === 'factual').length).toBeGreaterThanOrEqual(30);
    expect(rows.filter((r) => r.label === 'not_factual').length).toBeGreaterThanOrEqual(30);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
  it('costs well under a cent to run once', () => {
    expect(estimateCostUsd(rows)).toBeLessThan(0.01);
  });
});

describe('summarizeShadow', () => {
  it('counts a factual row Jev would skip as a FALSE SKIP, and a skipped not_factual as correct', async () => {
    const decide = async (t: string) => {
      const row = rows.find((r) => r.text === t)!;
      // Jev skips every not_factual row, plus ONE factual row.
      const skip = row.label === 'not_factual' || row.id === 'f01';
      return { skipHal: skip, reason: skip ? 'skipped_not_factual' : 'factual' };
    };
    const s = summarizeShadow(await runShadow(rows, decide));
    const factualN = rows.filter((r) => r.label === 'factual').length;
    expect(s.status).toBe('VERIFIED');
    expect(s.false_skips).toBe(1);
    expect(s.false_skip_rate_on_factual).toBeCloseTo(1 / factualN, 4);
    expect(s.skip_recall_on_not_factual).toBe(1);
  });

  it('an unavailable call is neither a skip nor a keep; all unavailable is NOT_CHECKED', async () => {
    const s = summarizeShadow(await runShadow(rows, async () => ({ skipHal: false, reason: 'unavailable' })));
    expect(s).toMatchObject({ status: 'NOT_CHECKED', measured: 0, unavailable: rows.length, would_skip_rate: null, false_skip_rate_on_factual: null });
  });

  it('a thrown decide is unavailable, never a skip', async () => {
    const s = summarizeShadow(await runShadow(rows.slice(0, 3), async () => { throw new Error('boom'); }));
    expect(s.would_skip).toBe(0);
    expect(s.unavailable).toBe(3);
  });

  it('flag_off rows (the prefilter refusing) are not measured either', async () => {
    const s = summarizeShadow(await runShadow(rows.slice(0, 4), async () => ({ skipHal: false, reason: 'flag_off' })));
    expect(s.status).toBe('NOT_CHECKED');
  });
});

describe('the script refuses to run without its switch', () => {
  it('with no flag and no key it exits 2 NOT CHECKED and calls nothing', () => {
    const env = { ...process.env, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_KEY: 'dummy' };
    delete env.HAL_JEV_PREFILTER_ENABLED;
    delete env.OPENROUTER_API_KEY;
    const r = spawnSync(process.execPath, [require.resolve('ts-node/dist/bin'), '--transpile-only', path.join(__dirname, '..', 'scripts', 'eval', 'jev-shadow.ts')], { env, encoding: 'utf8', timeout: 60000 });
    expect(r.stdout).toMatch(/^NOT CHECKED/m);
    expect(r.status).toBe(2);
  });
});
