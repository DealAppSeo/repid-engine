/**
 * One contract, one SERVICE_FULFILLED round, however many runs hold it (2026-11-16).
 *
 * MEASURED: contract 7ca47a1d (2026-07-08) went through applyServiceFulfilledDeltas twice, 3.5 s
 * apart. Two outbox rows, three on-chain writes, and the buyer took +5 twice (1030→1035→1040). The
 * claim leaves status 'escrowed', so two concurrent runs both hold the contract, and the
 * escrowed → fulfilled update had no status guard, so both ran the economy.
 *
 * The fake table below honours the update's filters, the way PostgREST does: an update whose
 * `.eq('status','escrowed')` no longer matches changes nothing and returns no row.
 */
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

const dbFrom = jest.fn();
const applyDeltas = jest.fn(async () => undefined);
jest.mock('../src/db', () => ({ db: { from: (...a: unknown[]) => dbFrom(...a) } }));
jest.mock('../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: (...a: unknown[]) => (applyDeltas as any)(...a) }));
jest.mock('../src/services/service-quality-hook', () => ({
  recordServiceQuality: jest.fn(async () => ({ mode: 'off', checked: false, reason: 'hook_disabled', observed_at: '' })),
}));

import { ServiceHandlerBase } from '../src/services/service-handler-base';

type Row = Record<string, any>;
let row: Row;
const disputeRows: Row[] = [];

function table() {
  dbFrom.mockImplementation((name: string) => {
    if (name === 'dispute_validation_queue') {
      const q: any = {
        insert: (r: Row) => { const added = { ...r, id: `dq-${disputeRows.length + 1}` }; disputeRows.push(added); q.added = added; return q; },
        select: () => q,
        single: async () => ({ data: q.added, error: null }),
      };
      return q;
    }
    if (name !== 'service_contracts') throw new Error(`unexpected table ${name}`);
    const filters: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    const matches = () => filters.every(([k, v]) => k.includes('.') || row[k] === v);
    const run = () => {
      if (!matches()) return null;
      if (patch) Object.assign(row, patch);
      return { ...row };
    };
    const q: any = {
      select: () => q,
      update: (p: Row) => { patch = p; return q; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
      not: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: run(), error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: null, error: null, _: run() }).then(ok, bad),
    };
    return q;
  });
}

let release!: () => void;
let gate: Promise<void>;

let verdict: Record<string, unknown> = { verdict: 'PASS' };

class GatedHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'verification';
  protected async fulfill(): Promise<Record<string, unknown>> {
    await gate; // both runs have claimed before either transitions
    return verdict;
  }
}

beforeEach(() => {
  applyDeltas.mockClear();
  disputeRows.length = 0;
  verdict = { verdict: 'PASS' };
  row = {
    id: 'c-1', status: 'escrowed', work_statement_hash: '0x' + 'ab'.repeat(32), created_at: '2026-07-08T20:17:31Z',
    provider_agent_id: 'p-1', buyer_agent_id: 'b-1', service_id: 's-1', metadata: {},
  };
  gate = new Promise<void>((r) => (release = r));
  table();
});

test('two concurrent runs on one contract: both claim, ONE fulfils and applies the deltas', async () => {
  const h = new GatedHandler();
  const a = h.processOne('p-1');
  const b = h.processOne('p-1');
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(row.status).toBe('fulfilled');
  expect(applyDeltas).toHaveBeenCalledTimes(1);
  expect([ra.processed, rb.processed].sort()).toEqual([false, true]);
});

test('a single run still fulfils and applies the deltas once (control)', async () => {
  release();
  const out = await new GatedHandler().processOne('p-1');
  expect(out).toEqual({ processed: true, contract_id: 'c-1' });
  expect(applyDeltas).toHaveBeenCalledTimes(1);
});

test('a contract that moved on (e.g. disputed by another run) is not fulfilled and earns nothing', async () => {
  const h = new GatedHandler();
  const p = h.processOne('p-1');
  await new Promise((r) => setImmediate(r));
  row.status = 'disputed';
  release();
  const out = await p;
  expect(out.processed).toBe(false);
  expect(row.status).toBe('disputed');
  expect(applyDeltas).not.toHaveBeenCalled();
});

test('two concurrent runs that both route to DISPUTE file ONE dispute row (Strix on #1560)', async () => {
  verdict = { verdict: 'VETO' };
  const h = new GatedHandler();
  const a = h.processOne('p-1');
  const b = h.processOne('p-1');
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(row.status).toBe('disputed');
  expect(disputeRows).toHaveLength(1);
  expect([ra.processed, rb.processed].sort()).toEqual([false, true]);
  expect(applyDeltas).not.toHaveBeenCalled();
});

test('a contract another run already FULFILLED is not flipped to disputed, and files no dispute', async () => {
  verdict = { verdict: 'VETO' };
  const p = new GatedHandler().processOne('p-1');
  await new Promise((r) => setImmediate(r));
  row.status = 'fulfilled';
  release();
  const out = await p;
  expect(out.processed).toBe(false);
  expect(row.status).toBe('fulfilled');
  expect(disputeRows).toHaveLength(0);
});

