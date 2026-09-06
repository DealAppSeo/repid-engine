/**
 * claimNextContract must not let ONE undeliverable contract starve the queue.
 *
 * THE LIVE FAILURE THIS PINS [MEASURED 2026-09-05]. A contract whose
 * `work_statement_hash` is NULL can never reach `fulfilled` — the DB refuses the
 * transition (#607). The failure path writes metadata only, so the row stays
 * `escrowed` and plain FIFO selects it again on the very next cycle. Forever.
 *
 * Because selection is per-provider and oldest-first, one such row starves every
 * later contract for that provider. Measured live: the undeliverable row was
 * re-claimed and re-failed about once a minute while a perfectly deliverable
 * contract sat at `claimed_at: null`, never attempted once. Every surface looked
 * healthy — a busy retry loop, a contract in a normal state, no red anywhere.
 * The work just never got a turn.
 *
 * THE SECOND HALF, WHICH THE FIRST FIX MISSED [MEASURED 2026-09-05, hours later].
 * Ordering alone was not enough, because the failure is not free. It happens
 * inside `fulfill()`, AFTER peer validation has run — three LLM calls for the
 * verification handler. Once a minute that is 4,320 calls a day: `llm_call_log`
 * showed 356 of 360 consecutive minutes carrying exactly 3 `pcp_validation`
 * calls, 3,892 of 4,362 daily calls FAILING on the provider's daily token cap.
 * One un-hashed row was spending the whole account's verification budget, so the
 * first contract the ordering fix finally let through settled with `0 of 3
 * validator(s) answered`. Deliverability is a PRECONDITION: it is checked before
 * the work, not discovered after paying for it.
 */
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: (...a: unknown[]) => dbFrom(...a) } }));
jest.mock('../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../src/services/service-quality-hook', () => ({
  recordServiceQuality: jest.fn(async () => ({ mode: 'off', checked: false, reason: 'hook_disabled', observed_at: '' })),
}));

import { ServiceHandlerBase } from '../src/services/service-handler-base';

class TestHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'verification';
  protected async fulfill(): Promise<Record<string, unknown>> { return { ok: true }; }
  public claim(agentId: string) { return (this as any).claimNextContract(agentId); }
}

/**
 * Minimal PostgREST-shaped double. It records whether `.not('work_statement_hash',
 * 'is', null)` was applied, and serves rows accordingly — which is exactly the
 * distinction under test.
 */
const updates: Array<{ id: string; payload: Record<string, any> }> = [];

function mockContracts(
  rows: Array<{
    id: string;
    work_statement_hash: string | null;
    created_at: string;
    metadata?: Record<string, unknown>;
  }>
) {
  const oldest = (hashedOnly: boolean) => {
    const pool = hashedOnly ? rows.filter((r) => r.work_statement_hash !== null) : rows;
    return [...pool].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  };

  updates.length = 0;

  dbFrom.mockImplementation((table: string) => {
    if (table !== 'service_contracts') throw new Error(`unexpected table ${table}`);

    // `hashedOnly` flips the moment `.not('work_statement_hash','is',null)` is
    // applied — that call IS the distinction under test, so the double models it
    // rather than pretending the filter does nothing.
    const chain = (hashedOnly: boolean): any => ({
      eq: () => chain(hashedOnly),
      not: () => chain(true),
      order: () => chain(hashedOnly),
      limit: () => chain(hashedOnly),
      maybeSingle: async () => ({ data: oldest(hashedOnly), error: null }),
    });

    return {
      select: () => chain(false),
      // The optimistic-concurrency claim UPDATE echoes back the row it targeted.
      // It MUST honour the `.eq('id', …)` it is given: an earlier version of this
      // double returned the oldest row regardless, which made the assertion pass
      // or fail for reasons unrelated to the ordering under test.
      // Two callers share this chain and they terminate DIFFERENTLY: the claim
      // ends `.eq().eq().select().maybeSingle()`, while markUndeliverable awaits
      // `.eq().eq()` directly. The inner handle is therefore BOTH thenable and
      // `.select()`-able — modelling only one shape would let the other pass for
      // the wrong reason (an awaited plain object yields `error: undefined`,
      // which reads as success without any code having run).
      update: (payload: Record<string, unknown>) => ({
        eq: (col: string, val: string) => ({
          eq: () => {
            const handle: any = {
              select: () => ({
                maybeSingle: async () => ({
                  data: col === 'id' ? (rows.find((r) => r.id === val) ?? null) : oldest(false),
                  error: null,
                }),
              }),
            };
            handle.then = (resolve: (v: unknown) => unknown) => {
              updates.push({ id: val, payload });
              return Promise.resolve(resolve({ data: null, error: null }));
            };
            return handle;
          },
        }),
      }),
    };
  });
}

describe('claimNextContract — one stuck contract must not starve the queue', () => {
  beforeEach(() => dbFrom.mockReset());

  it('claims the DELIVERABLE contract even when an older un-hashed one exists', async () => {
    // Exactly the live shape: the undeliverable row is OLDER, so plain FIFO picks
    // it every time and the newer, deliverable one is never attempted.
    mockContracts([
      { id: 'stuck-older',      work_statement_hash: null,     created_at: '2026-09-04T12:00:13Z' },
      { id: 'deliverable-newer', work_statement_hash: '0xabc', created_at: '2026-09-05T12:02:25Z' },
    ]);

    const claimed = await new TestHandler().claim('provider-1');
    expect((claimed as any)?.id).toBe('deliverable-newer');
  });

  it('does NOT hand an un-hashed row to fulfill(), even when it is the only one', async () => {
    // This assertion is INVERTED from the first version of this file, on purpose.
    // It used to assert the fallback claimed the stuck row, reasoning that the
    // loud failure is what makes it visible. The loud failure costs three LLM
    // calls per cycle and cannot ever succeed, so the queue was buying visibility
    // with the whole account's daily quota. Returning null is what stops that.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockContracts([
      { id: 'stuck-only', work_statement_hash: null, created_at: '2026-09-04T12:00:13Z' },
    ]);

    expect(await new TestHandler().claim('provider-1')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('marks the un-hashed row undeliverable so skipping it is not silent', async () => {
    // Skipping without a trace WOULD be the silent queue the old comment feared.
    // The row is written once with a reason and a first-seen timestamp, which is
    // queryable — unlike `metadata.last_error`, which the attempt-and-fail path
    // overwrote every minute and so only ever recorded the latest retry.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockContracts([
      { id: 'stuck-only', work_statement_hash: null, created_at: '2026-09-04T12:00:13Z' },
    ]);

    await new TestHandler().claim('provider-1');

    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe('stuck-only');
    const marker = updates[0]?.payload?.['metadata']?.['undeliverable'];
    expect(marker?.reason).toMatch(/WORK_STATEMENT_REQUIRED/);
    expect(typeof marker?.first_seen_at).toBe('string');
    warn.mockRestore();
  });

  it('does not rewrite the marker — first_seen_at is the AGE of the problem', async () => {
    // Re-marking every cycle would reset the one field that says how long this
    // has been stuck, and turn a once-per-row write into once-per-minute churn.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockContracts([
      {
        id: 'stuck-only',
        work_statement_hash: null,
        created_at: '2026-09-04T12:00:13Z',
        metadata: {
          undeliverable: {
            reason: 'WORK_STATEMENT_REQUIRED: work_statement_hash is NULL and nothing backfills it',
            detected_by: 'verification',
            first_seen_at: '2026-09-04T12:01:00.000Z',
          },
        },
      },
    ]);

    expect(await new TestHandler().claim('provider-1')).toBeNull();
    expect(updates).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is plain FIFO when every contract is deliverable', async () => {
    // No behaviour change in the ordinary case.
    mockContracts([
      { id: 'older',  work_statement_hash: '0xaaa', created_at: '2026-09-01T00:00:00Z' },
      { id: 'newer',  work_statement_hash: '0xbbb', created_at: '2026-09-02T00:00:00Z' },
    ]);

    const claimed = await new TestHandler().claim('provider-1');
    expect((claimed as any)?.id).toBe('older');
  });

  it('returns null when the provider has nothing escrowed', async () => {
    mockContracts([]);
    expect(await new TestHandler().claim('provider-1')).toBeNull();
  });
});
