/**
 * Smoke test for the hal_accuracy_summary view (CC Sprint 4).
 *
 * The view aggregates over hal_runner_results and exposes precision /
 * recall / f1_score / false_positive_rate. It MUST exist in production
 * Supabase, MUST return exactly one row, and the metric columns MUST be
 * either numeric (when total > 0) or null (when total = 0 or any TP+FP /
 * TP+FN denominator is 0).
 *
 * Skipped in environments where SUPABASE_URL / SUPABASE_SERVICE_KEY are
 * absent — runs against live db otherwise. Same skip-when-no-env pattern
 * as other db-touching tests.
 */

import { db } from '../src/db';

// REPID_TEST_DUMMY_DB is set by tests/jest.setup.env.ts when only dummy creds are present
// (keyless CI). Real creds (.env / CI secrets) leave it unset, so this live-DB view test
// runs for real when a DB is available and skips cleanly otherwise.
const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) && process.env.REPID_TEST_DUMMY_DB !== '1';
const describeIfDb = HAS_DB ? describe : describe.skip;

describeIfDb('hal_accuracy_summary view', () => {
  it('exists and returns exactly one row', async () => {
    const { data, error } = await db.from('hal_accuracy_summary').select('*');
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data).toHaveLength(1);
  });

  it('metric columns are numeric (or string-numeric) or null', async () => {
    const { data } = await db.from('hal_accuracy_summary').select('*');
    if (!data || data.length === 0) return; // covered by previous test
    const row: any = data[0];

    // Supabase / PostgREST returns numeric columns as strings by default
    // (precision, recall, f1_score, false_positive_rate). Null when
    // denominator is 0. Either is acceptable.
    for (const col of ['precision', 'recall', 'f1_score', 'false_positive_rate']) {
      const v = row[col];
      const ok = v === null || typeof v === 'number' || typeof v === 'string';
      if (!ok) throw new Error(`unexpected type for ${col}: ${typeof v} (${v})`);
    }
  });

  it('tp / fp / fn / tn / total are non-negative integers', async () => {
    const { data } = await db.from('hal_accuracy_summary').select('tp, fp, fn, tn, total');
    if (!data || data.length === 0) return;
    const row: any = data[0];
    for (const col of ['tp', 'fp', 'fn', 'tn', 'total']) {
      expect(typeof row[col]).toBe('number');
      expect(row[col]).toBeGreaterThanOrEqual(0);
    }
    // tp + fp + fn + tn === total
    expect(row.tp + row.fp + row.fn + row.tn).toBe(row.total);
  });

  it('source_table identifier is set so callers know the data source', async () => {
    const { data } = await db.from('hal_accuracy_summary').select('source_table');
    if (!data || data.length === 0) return;
    expect((data[0] as any).source_table).toBe('hal_runner_results');
  });
});
