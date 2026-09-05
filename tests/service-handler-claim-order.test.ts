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
function mockContracts(rows: Array<{ id: string; work_statement_hash: string | null; created_at: string }>) {
  const oldest = (hashedOnly: boolean) => {
    const pool = hashedOnly ? rows.filter((r) => r.work_statement_hash !== null) : rows;
    return [...pool].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  };

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
      update: () => ({
        eq: (col: string, val: string) => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: col === 'id' ? (rows.find((r) => r.id === val) ?? null) : oldest(false),
                error: null,
              }),
            }),
          }),
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

  it('still falls back to the un-hashed row when nothing deliverable is waiting', async () => {
    // Ordering, not exclusion. A silently-skipped contract would be worse than a
    // wedged one: the loud failure is what makes a stuck row visible at all.
    mockContracts([
      { id: 'stuck-only', work_statement_hash: null, created_at: '2026-09-04T12:00:13Z' },
    ]);

    const claimed = await new TestHandler().claim('provider-1');
    expect((claimed as any)?.id).toBe('stuck-only');
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
