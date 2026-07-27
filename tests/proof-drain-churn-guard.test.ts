/**
 * L4 breaker — consumer-side proof-churn guard.
 *
 * The properties that matter, and why each is tested:
 *  1. 'off' is BYTE-IDENTICAL to the statement the drain has run since 2026-05-21.
 *     (If this ever drifts, the "default changes nothing" claim is false.)
 *  2. A typo / empty / unset lever resolves to 'off', never to 'enforce'.
 *  3. 'enforce' only ever NARROWS: the predicate is ANDed on, and the guard has
 *     no code path that writes, deletes, or adds a row.
 *  4. 'shadow' returns the legacy result set (nothing excluded) plus is_churn.
 *  5. The churn classification has exactly one source of truth, shared with the
 *     producer-side filter.
 *  6. End-to-end through the real service: the SQL and params that reach pgQuery
 *     are the ones the mode promises.
 */
import { createProofDrainService } from '../src/services/proof-drain-service';
import {
  buildPendingBatchQuery,
  churnEventTypeList,
  describeChurnGuard,
  parseProofDrainChurnMode,
  CHURN_AWARE_PENDING_BATCH_SQL,
  LEGACY_PENDING_BATCH_SQL
} from '../src/services/proof-drain-churn-guard';
import { CHURN_PROOF_EVENT_TYPES } from '../src/services/proof-enqueue-filter';

const ARGS = { status: 'pending', zkpServiceUrl: 'http://zkp.test', batchSize: 20 };

describe('parseProofDrainChurnMode', () => {
  it('resolves the three canonical spellings, case/whitespace-insensitively', () => {
    expect(parseProofDrainChurnMode('off')).toBe('off');
    expect(parseProofDrainChurnMode('shadow')).toBe('shadow');
    expect(parseProofDrainChurnMode('enforce')).toBe('enforce');
    expect(parseProofDrainChurnMode('  ENFORCE  ')).toBe('enforce');
    expect(parseProofDrainChurnMode('Shadow')).toBe('shadow');
  });

  it('defaults to off for unset / empty / whitespace', () => {
    expect(parseProofDrainChurnMode(undefined)).toBe('off');
    expect(parseProofDrainChurnMode(null)).toBe('off');
    expect(parseProofDrainChurnMode('')).toBe('off');
    expect(parseProofDrainChurnMode('   ')).toBe('off');
  });

  it('resolves a typo to off, NEVER to enforce (a mistyped lever must not change behaviour)', () => {
    for (const typo of ['enforc', 'enfore', 'ENFORCE=true', 'true', '1', 'yes', 'on', 'shadowy', 'of']) {
      expect(parseProofDrainChurnMode(typo)).toBe('off');
    }
  });
});

describe('buildPendingBatchQuery', () => {
  it("mode 'off' emits the legacy statement and the legacy 3 params, unchanged", () => {
    const plan = buildPendingBatchQuery('off', ARGS);
    expect(plan.sql).toBe(LEGACY_PENDING_BATCH_SQL);
    expect(plan.params).toEqual(['pending', 'http://zkp.test', 20]);
    expect(plan.excludesChurn).toBe(false);
    expect(plan.reportsChurn).toBe(false);
    // Regression guard on the literal itself: no join, no churn predicate.
    expect(plan.sql).not.toMatch(/repid_score_events/);
    expect(plan.sql).not.toMatch(/is_churn/);
    expect(plan.sql).toContain('FROM repid_proof_queue');
    expect(plan.sql).toContain('WHERE status = $1 AND zkp_service_url = $2');
  });

  it("mode 'shadow' reports churn but does not exclude it (enforce switch false)", () => {
    const plan = buildPendingBatchQuery('shadow', ARGS);
    expect(plan.sql).toBe(CHURN_AWARE_PENDING_BATCH_SQL);
    expect(plan.excludesChurn).toBe(false);
    expect(plan.reportsChurn).toBe(true);
    expect(plan.params[4]).toBe(false);
    expect(plan.sql).toContain('AS is_churn');
  });

  it("mode 'enforce' excludes churn (enforce switch true)", () => {
    const plan = buildPendingBatchQuery('enforce', ARGS);
    expect(plan.sql).toBe(CHURN_AWARE_PENDING_BATCH_SQL);
    expect(plan.excludesChurn).toBe(true);
    expect(plan.reportsChurn).toBe(true);
    expect(plan.params[4]).toBe(true);
  });

  it('passes the churn event-type list as a SQL array param in both non-off modes', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const plan = buildPendingBatchQuery(mode, ARGS);
      expect(plan.params[3]).toEqual(churnEventTypeList());
      expect(plan.params[3]).toContain('HAL_SCORE_EVENT');
    }
  });

  it('preserves status / url / batchSize positionally in every mode', () => {
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      const plan = buildPendingBatchQuery(mode, { status: 'pending', zkpServiceUrl: 'http://x', batchSize: 7 });
      expect(plan.params.slice(0, 3)).toEqual(['pending', 'http://x', 7]);
    }
  });
});

describe('the churn-aware statement can only narrow', () => {
  const sql = CHURN_AWARE_PENDING_BATCH_SQL;

  it('adds its predicate with AND onto the pre-existing WHERE, never OR', () => {
    const where = sql.slice(sql.indexOf('WHERE'), sql.indexOf('LIMIT'));
    // The only OR is the one INSIDE the guarded clause ($5 = false OR <not churn>),
    // which is what makes shadow a no-op; the clause itself is ANDed on.
    expect(where).toContain('AND (');
    expect(where.indexOf('AND (')).toBeLessThan(where.indexOf('OR coalesce'));
    expect(where).toContain('q.status = $1 AND q.zkp_service_url = $2');
  });

  it('LEFT-joins and coalesces, so an unclassifiable job is kept rather than swallowed', () => {
    // A NULL event_id (or a missing score event) must survive the enforce filter:
    // coalesce(NULL,'') <> ALL(churn) is TRUE. An inner join, or a bare
    // `e.event_type <> ALL(...)`, would drop those rows silently.
    expect(sql).toContain('LEFT JOIN repid_score_events e ON e.id = q.event_id');
    expect(sql).toContain("coalesce(e.event_type, '') <> ALL($4::text[])");
    expect(sql).not.toMatch(/\bINNER JOIN\b/i);
  });

  it('does not use the NOT EXISTS shape that measured 394ms/2 seq scans on prod', () => {
    // Guard against a well-meaning "simplification" back to the slow formulation.
    expect(sql).not.toMatch(/NOT EXISTS/i);
  });

  it('is a read: no INSERT / UPDATE / DELETE anywhere in either statement', () => {
    for (const s of [LEGACY_PENDING_BATCH_SQL, CHURN_AWARE_PENDING_BATCH_SQL]) {
      expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
      expect(s.trimStart().startsWith('SELECT')).toBe(true);
    }
  });

  it('keys the churn subquery on the FK column, so a NULL event_id can never be churn', () => {
    expect(sql).toContain('e.id = q.event_id');
  });
});

describe('single source of truth for "churn"', () => {
  it('reuses the producer-side set rather than redeclaring it', () => {
    expect(new Set(churnEventTypeList())).toEqual(new Set([...CHURN_PROOF_EVENT_TYPES]));
  });
});

describe('describeChurnGuard', () => {
  it('names the mode and the event types in every mode', () => {
    expect(describeChurnGuard('off')).toMatch(/OFF \(legacy\)/);
    expect(describeChurnGuard('off')).toContain('HAL_SCORE_EVENT');
    expect(describeChurnGuard('shadow')).toMatch(/SHADOW/);
    // The shadow banner must not read as protection — it still proves everything.
    expect(describeChurnGuard('shadow')).toMatch(/still fetched AND PROVED/);
    expect(describeChurnGuard('enforce')).toMatch(/ENFORCE/);
    expect(describeChurnGuard('enforce')).toMatch(/left pending/);
  });
});

describe('wired into the real drain service', () => {
  function svcWith(churnMode: 'off' | 'shadow' | 'enforce' | undefined, captured: { text?: string; params?: any[] }) {
    return createProofDrainService({
      supabase: { from() { throw new Error('unused'); } } as any,
      zkpServiceUrl: 'http://zkp.test',
      churnMode,
      pgQueryImpl: (async (text: string, params: any[]) => {
        captured.text = text;
        captured.params = params;
        return [];
      }) as any,
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'stub' })) as any,
      fetchImpl: (async () => { throw new Error('unused'); }) as any
    });
  }

  it('default (no churnMode, no env) runs the legacy statement', async () => {
    const prior = process.env.PROOF_DRAIN_CHURN_MODE;
    delete process.env.PROOF_DRAIN_CHURN_MODE;
    try {
      const captured: { text?: string; params?: any[] } = {};
      await svcWith(undefined, captured).drainOnce();
      expect(captured.text).toBe(LEGACY_PENDING_BATCH_SQL);
      expect(captured.params).toEqual(['pending', 'http://zkp.test', 20]);
    } finally {
      if (prior === undefined) delete process.env.PROOF_DRAIN_CHURN_MODE;
      else process.env.PROOF_DRAIN_CHURN_MODE = prior;
    }
  });

  it('enforce reaches pgQuery with the exclusion switch on', async () => {
    const captured: { text?: string; params?: any[] } = {};
    await svcWith('enforce', captured).drainOnce();
    expect(captured.text).toBe(CHURN_AWARE_PENDING_BATCH_SQL);
    expect(captured.params![4]).toBe(true);
    expect(captured.params![3]).toContain('HAL_SCORE_EVENT');
  });

  it('shadow reaches pgQuery with the exclusion switch off (same rows as legacy)', async () => {
    const captured: { text?: string; params?: any[] } = {};
    await svcWith('shadow', captured).drainOnce();
    expect(captured.text).toBe(CHURN_AWARE_PENDING_BATCH_SQL);
    expect(captured.params![4]).toBe(false);
  });

  /**
   * Minimal supabase mock whose score lookup always misses, so every job
   * short-circuits to markFailed('Score event not found') WITHOUT touching the
   * prover. That keeps these two tests off the withRetry backoff ladder
   * (1s/4s/16s/64s/256s) — the fetch log is all they are about.
   */
  function scorelessSupabase() {
    return {
      from(table: string) {
        if (table === 'repid_score_events') {
          return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'not found' } }) }) }) };
        }
        if (table === 'repid_proof_queue') {
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      }
    } as any;
  }

  it('shadow logs the churn composition of a batch it is about to prove', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svc = createProofDrainService({
        supabase: scorelessSupabase(),
        zkpServiceUrl: 'http://zkp.test',
        churnMode: 'shadow',
        pgQueryImpl: (async () => [
          { id: '1', job_id: 'j1', agent_id: 'a', event_id: '10', status: 'pending', is_churn: true },
          { id: '2', job_id: 'j2', agent_id: 'a', event_id: '11', status: 'pending', is_churn: false }
        ]) as any,
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'stub' })) as any,
        fetchImpl: (async () => { throw new Error('prover must not be reached'); }) as any
      });
      await svc.drainOnce();
      const line = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('churn-guard SHADOW'));
      expect(line).toBeDefined();
      expect(line).toContain('1/2');
    } finally {
      warn.mockRestore();
    }
  });

  it('off does NOT log a shadow line even when rows carry is_churn', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svc = createProofDrainService({
        supabase: scorelessSupabase(),
        zkpServiceUrl: 'http://zkp.test',
        churnMode: 'off',
        pgQueryImpl: (async () => [
          { id: '1', job_id: 'j1', agent_id: 'a', event_id: '10', status: 'pending', is_churn: true }
        ]) as any,
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'stub' })) as any,
        fetchImpl: (async () => { throw new Error('prover must not be reached'); }) as any
      });
      await svc.drainOnce();
      expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes('churn-guard SHADOW'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
