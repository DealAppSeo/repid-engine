/**
 * Smoke test for the hal_accuracy_summary view (CC Sprint 4).
 *
 * The view aggregates over hal_runner_results and exposes precision /
 * recall / f1_score / false_positive_rate. It MUST exist in production
 * Supabase, MUST return exactly one row, and the metric columns MUST be
 * either numeric (when total > 0) or null (when total = 0 or any TP+FP /
 * TP+FN denominator is 0).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE GATES ON LIVENESS, NOT PRESENCE
 * ---------------------------------------------------------------------------
 * This suite used to gate on
 *
 *     const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
 *
 * which asks whether the variables are SET, not whether they WORK. A key can be
 * present and dead. With the documented local stubs exported
 * (`SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=dummy`) that check
 * passed, all four tests then ran against a URL with nothing behind it, and each
 * died with
 *
 *     thrown: "Exceeded timeout of 5000 ms for a test."
 *
 * pointing at the `it(...)` line. Four red tests whose message implicates the
 * view. Nothing in that output says "no database was reachable", so the failure
 * reads as a defect in `hal_accuracy_summary` — the same misread that once sent
 * someone hunting a scoring bug that did not exist, when in fact a provider
 * credential had died.
 *
 * The rule (see src/hal/measurement-integrity.ts): an environment fault must
 * never be reportable as a quality regression. So:
 *
 *   - credentials ABSENT or a recognised local placeholder -> SKIP, with the
 *     reason printed. Nothing was promised, so nothing failed.
 *   - credentials DECLARED but the database does not answer -> FAIL, with a
 *     message that leads "ENVIRONMENT FAILURE - this is NOT a HAL quality
 *     regression" and says which credential to check. This is the dangerous
 *     case and it must be loud, not skipped.
 *
 * The reachability probe runs ONCE and is bounded, so a dead endpoint costs one
 * short timeout rather than 5 s per test.
 */

import { db } from '../src/db';
import {
  formatIntegrityFailure,
  type EnvironmentFault,
  type IntegrityVerdict,
} from '../src/hal/measurement-integrity';

const RAW_URL = process.env.SUPABASE_URL ?? '';
const RAW_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  '';

/** Values the repo's own docs tell developers to export for local work. Not real credentials. */
const PLACEHOLDER_KEY = /^(dummy|dummy[-_]?key|test|testing|changeme|placeholder|none|xxx+|your[-_ ]?(api[-_ ]?)?key)$/i;
const PLACEHOLDER_HOST = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)|example\.(com|org)/i;

function credentialStatus(): { declared: boolean; reason: string } {
  if (!RAW_URL && !RAW_KEY) return { declared: false, reason: 'SUPABASE_URL and a service key are both unset' };
  if (!RAW_URL) return { declared: false, reason: 'SUPABASE_URL is unset' };
  if (!RAW_KEY) return { declared: false, reason: 'no Supabase service key is set' };
  if (PLACEHOLDER_HOST.test(RAW_URL)) {
    return {
      declared: false,
      reason: `SUPABASE_URL points at a local placeholder (${RAW_URL}) — the documented local stub, not a real project`,
    };
  }
  if (PLACEHOLDER_KEY.test(RAW_KEY.trim())) {
    return { declared: false, reason: 'the Supabase service key is a documented placeholder value, not a real key' };
  }
  return { declared: true, reason: 'credentials declared' };
}

const CREDENTIALS = credentialStatus();

/** How long the one-off reachability probe may take before the endpoint counts as unreachable. */
const PROBE_TIMEOUT_MS = 8000;

/** Set when credentials were declared but the database did not answer. */
let probeFault: EnvironmentFault | null = null;

function environmentFailureMessage(fault: EnvironmentFault, context: string): string {
  const verdict: IntegrityVerdict = {
    measurable: false,
    faults: [fault],
    summary: `the database backing hal_accuracy_summary was not reachable, so the view could not be observed at all`,
  };
  return formatIntegrityFailure(verdict, context);
}

/**
 * Fail every assertion with the environment banner rather than a view-shaped error.
 * Called first in each test so a dead endpoint can never masquerade as a bad view.
 */
function assertDatabaseReachable(): void {
  if (probeFault) {
    throw new Error(
      environmentFailureMessage(probeFault, 'probing the hal_accuracy_summary view before asserting on it'),
    );
  }
}

if (!CREDENTIALS.declared) {
  // Printed at collection time: a skipped suite with no explanation is its own small lie.
  console.warn(
    `[hal-accuracy-summary] SKIPPING the hal_accuracy_summary view suite: ${CREDENTIALS.reason}.\n` +
      `  This is NOT a HAL quality result and NOT a view defect — the view was never observed.\n` +
      `  To run it, set SUPABASE_URL + SUPABASE_SERVICE_KEY to a real project. A key can be PRESENT and\n` +
      `  DEAD, so this suite probes with a real query rather than checking that the variables are set.`,
  );
}

const describeIfDb = CREDENTIALS.declared ? describe : describe.skip;

describeIfDb('hal_accuracy_summary view', () => {
  beforeAll(async () => {
    // ONE bounded probe. A real query, because "the variable is set" proves nothing.
    const probe = db.from('hal_accuracy_summary').select('source_table').limit(1);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS));
    let outcome: unknown;
    try {
      outcome = await Promise.race([probe, timeout]);
    } catch (e: unknown) {
      outcome = { error: { message: e instanceof Error ? e.message : String(e) } };
    }

    if (outcome === 'timeout') {
      probeFault = {
        kind: 'network',
        provider: 'supabase',
        detail:
          `SUPABASE_URL (${RAW_URL}) did not answer within ${PROBE_TIMEOUT_MS} ms. The credential is SET but the ` +
          `endpoint is unreachable — nothing about hal_accuracy_summary was observed.`,
      };
      return;
    }

    const err = (outcome as { error?: { message?: string } } | null)?.error;
    if (err) {
      const msg = err.message ?? String(err);
      const isAuth = /jwt|api key|unauthor|forbidden|invalid.*(key|token)|401|403/i.test(msg);
      probeFault = {
        kind: isAuth ? 'auth' : 'network',
        provider: 'supabase',
        detail:
          `querying hal_accuracy_summary failed: ${msg}. The credential is SET but ` +
          `${isAuth ? 'was REJECTED — it is present and dead' : 'the request did not succeed'}. ` +
          `Nothing about the view was observed.`,
      };
    }
  }, PROBE_TIMEOUT_MS + 4000);

  it('exists and returns exactly one row', async () => {
    assertDatabaseReachable();
    const { data, error } = await db.from('hal_accuracy_summary').select('*');
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data).toHaveLength(1);
  });

  it('metric columns are numeric (or string-numeric) or null', async () => {
    assertDatabaseReachable();
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
    assertDatabaseReachable();
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
    assertDatabaseReachable();
    const { data } = await db.from('hal_accuracy_summary').select('source_table');
    if (!data || data.length === 0) return;
    expect((data[0] as any).source_table).toBe('hal_runner_results');
  });
});
