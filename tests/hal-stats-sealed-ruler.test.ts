/**
 * GET /hal/stats never publishes an F1 without its ruler (CLAUDE_RULES r24, 2026-10-16).
 *
 * The external benchmark is published only when the latest run's rows carry a sealed ruler tag
 * that names a registered version with its pinned hash, and the run scored exactly that version's
 * N sealed cases. Every other run is withheld: no F1, no confusion counts, the reason stated.
 *
 * Fixtures only: synthetic ids (00000000-0000-4000-8000-<12 digits>) filtered by the sealed
 * predicate. No sealed id or text from the database appears here.
 */
import express from 'express';
import request from 'supertest';
import { SEALED_RULER_VERSIONS, isSealedId } from '../src/hal/sealed-ruler';

type RunRow = { test_case_id: string; hal_decision: string; correct: boolean | null; harness_version: string | null };
let latest: Array<{ run_id: string; run_at: string }> = [];
let runRows: RunRow[] = [];

jest.mock('../src/db', () => {
  const resolved = (v: unknown) => {
    const c: any = {};
    for (const m of ['select', 'eq', 'gte', 'is', 'order', 'limit']) c[m] = () => c;
    c.then = (ok: any, bad: any) => Promise.resolve(v).then(ok, bad);
    return c;
  };
  return {
    db: {
      from: (table: string) => ({
        select: (cols: string) => {
          if (table === 'hal_external_validation_runs') {
            return resolved(cols.includes('test_case_id') ? { data: runRows, error: null } : { data: latest, error: null });
          }
          return resolved({ data: [], error: null, count: 0 });
        },
      }),
    },
  };
});

jest.mock('../src/hal/fact-check', () => ({
  buildFactCheckProviders: () => [],
  auditFamilyIndependence: () => ({ families: [] }),
}));

import halStatsRouter from '../src/routes/hal-stats';

const app = express();
app.use('/api/v1', halStatsRouter);
const getBench = async () => (await request(app).get('/api/v1/hal/stats')).body.external_benchmark;

const V1 = SEALED_RULER_VERSIONS[0]!;
const fx = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SEALED: string[] = [];
for (let i = 0; SEALED.length < V1.pin.caseCount + 1; i++) if (isSealedId(fx(i))) SEALED.push(fx(i));
const OPEN = fx([...Array(50).keys()].find((i) => !isSealedId(fx(i)))!);
const TAG = `2.0.0|hal-sealed-v1@${V1.pin.contentHash}|w3-3|s2|dq1|pq0`;

/** 519 rows: the first 200 vetoed, every third row wrong. */
function sealedRun(tag: string | null = TAG): RunRow[] {
  return SEALED.slice(0, V1.pin.caseCount).map((id, i) => ({
    test_case_id: id,
    hal_decision: i < 200 ? 'vetoed' : 'clean',
    correct: i % 3 !== 0,
    harness_version: tag,
  }));
}
function expectedMatrix(rows: RunRow[]) {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    if (r.hal_decision === 'vetoed') r.correct ? m.tp++ : m.fp++;
    else r.correct ? m.tn++ : m.fn++;
  }
  return m;
}

beforeEach(() => {
  latest = [{ run_id: 'run-fixture', run_at: '2026-10-16T00:00:00.000Z' }];
  runRows = sealedRun();
});

describe('GET /hal/stats external_benchmark', () => {
  it('withholds a run recorded before the sealed ruler (harness_version 1.0.0): no number at all', async () => {
    runRows = sealedRun('1.0.0');
    const b = await getBench();
    expect(b.status).toBe('not_measured_on_sealed_ruler');
    expect(b.note).toBe('not measured on a sealed ruler yet');
    expect(b.metrics).toBeNull();
    expect(b.citation).toBeNull();
    expect(b.ruler).toBeNull();
    expect(b.run_id).toBe('run-fixture');
    expect(JSON.stringify(b)).not.toMatch(/f1|precision|recall|accuracy|"tp"/i);
  });

  it('publishes a full sealed run with its ruler citation (id, hash, N, width)', async () => {
    const b = await getBench();
    const m = expectedMatrix(runRows);
    expect(b.status).toBe('measured');
    expect(b.ruler).toEqual({
      id: 'hal-sealed-v1',
      content_hash: V1.pin.contentHash,
      n: V1.pin.caseCount,
      families_observed_min: 3,
      families_observed_max: 3,
      strictness: 2,
      decision_requires_quorum: true,
      penalty_requires_quorum: false,
    });
    expect(b.citation).toContain(`on corpus hal-sealed-v1@${V1.pin.contentHash.slice(0, 19)} (${V1.pin.caseCount} cases) at 3 families, strictness 2`);
    expect(b.metrics).toMatchObject(m);
    const f1 = (2 * m.tp) / (2 * m.tp + m.fp + m.fn);
    expect(b.metrics.f1_score).toBeCloseTo(f1 * 100, 2);
    expect(b.citation).toContain(`F1 = ${f1.toFixed(4)}`);
  });

  it.each([
    ['one case short of N', () => { runRows = sealedRun().slice(1); }],
    ['a hash that is not the pinned one', () => { runRows = sealedRun(TAG.replace(/[0-9a-f]{64}/, 'f'.repeat(64))); }],
    ['an unregistered ruler id', () => { runRows = sealedRun(TAG.replace('hal-sealed-v1@', 'hal-sealed-v9@')); }],
    ['a subset ruler', () => { runRows = sealedRun(TAG.replace('hal-sealed-v1@', 'hal-sealed-v1/subset@')); }],
    ['rows with different tags', () => { runRows = sealedRun(); runRows[7] = { ...runRows[7]!, harness_version: '1.0.0' }; }],
    ['an open (non-sealed) case in the run', () => { runRows = sealedRun(); runRows[0] = { ...runRows[0]!, test_case_id: OPEN }; }],
    ['a case scored twice', () => { runRows = sealedRun(); runRows[1] = { ...runRows[1]!, test_case_id: runRows[0]!.test_case_id }; }],
    ['a row with no correctness label', () => { runRows = sealedRun(); runRows[3] = { ...runRows[3]!, correct: null }; }],
    ['a tag with no ruler key', () => { runRows = sealedRun('2.0.0'); }],
  ])('withholds the number for %s', async (_name, arrange) => {
    arrange();
    const b = await getBench();
    expect(b.status).toBe('not_measured_on_sealed_ruler');
    expect(b.metrics).toBeNull();
    expect(typeof b.reason).toBe('string');
  });

  it('is null when no run exists', async () => {
    latest = [];
    expect(await getBench()).toBeNull();
  });
});
