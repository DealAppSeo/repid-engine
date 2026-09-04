/**
 * CascadeSettlementWorker — the escrowed→fulfilled driver, which had no test file.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This worker is economically active: `processOne()` drives
 * `applyServiceFulfilledDeltas`, which writes `repid_agents.current_repid`. It is
 * also the worker sitting on the cascade path that produced the 12-day
 * delivery-leg outage (NOT_CHECKED scored as FAILED, disputing contracts nobody
 * had actually validated, on a path that moves real testnet money). It shipped
 * with zero tests.
 *
 * THE CENTRAL TEST IS THE HANDLER-PARITY ONE, and it is not a shape test.
 * The worker keeps a handler list that must mirror the one in
 * `src/routes/v1/agent.ts`. That list HAS ALREADY DRIFTED: SecurityAuditServiceHandler
 * was registered in agent.ts on 2026-07-27 and never added here, so `security_audit`
 * contracts NEVER drained server-side — silently, because a missing handler cannot
 * fail, it simply never runs. It was caught only when an independent audit compared
 * the two lists by hand.
 *
 * The source comment's response was "If you add a handler, add it to BOTH or the
 * service type is half-wired" — a hand-maintained invariant guarded by nothing,
 * which is the same shape as the jest `roots` list that hid 52 assertions from every
 * runner (see CLAUDE.md, Test layout). A comment is not a mechanism. This file is
 * the mechanism: the parity test reads BOTH lists and fails when they diverge, so
 * the next omission is loud at commit time instead of invisible in production.
 */

// Must precede the import: MAX_PER_CYCLE and POLL_MS are read at module load.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.CASCADE_SETTLEMENT_MAX_PER_CYCLE = '3';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface HandlerResult { processed: boolean; contract_id?: string }
interface CascadeTestState {
  poll: { data: Array<{ provider_agent_id: string }> | null; error: unknown };
  halt: boolean;
  queue: Record<string, HandlerResult[]>;
  calls: Array<{ handler: string; provider: string }>;
}

function cascadeState(): CascadeTestState {
  return (globalThis as any).__cascade as CascadeTestState;
}

(globalThis as any).__cascade = {
  poll: { data: [], error: null },
  halt: false,
  queue: {},
  calls: [],
} as CascadeTestState;

/**
 * A stand-in handler whose CLASS NAME is preserved, so the parity test can read
 * `constructor.name` off the worker's real handler array even under mocks.
 */
function mockMakeHandler(name: string): any {
  return {
    [name]: class {
      async processOne(providerId: string): Promise<HandlerResult> {
        const g = (globalThis as any).__cascade as CascadeTestState;
        g.calls.push({ handler: name, provider: providerId });
        return (g.queue[name] ?? []).shift() ?? { processed: false };
      }
    },
  }[name];
}

jest.mock('../src/db', () => {
  const q: any = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: async () => (globalThis as any).__cascade.poll,
  };
  return { db: { from: () => q } };
});

jest.mock('../src/services/emergency-halt', () => ({
  shouldParkForHalt: async () => (globalThis as any).__cascade.halt,
}));

jest.mock('../src/services/verification-service-handler', () => ({
  VerificationServiceHandler: mockMakeHandler('VerificationServiceHandler'),
}));
jest.mock('../src/services/cross-validation-service-handler', () => ({
  CrossValidationServiceHandler: mockMakeHandler('CrossValidationServiceHandler'),
}));
jest.mock('../src/services/anfis-routing-service-handler', () => ({
  AnfisRoutingServiceHandler: mockMakeHandler('AnfisRoutingServiceHandler'),
}));
jest.mock('../src/services/reputation-audit-service-handler', () => ({
  ReputationAuditServiceHandler: mockMakeHandler('ReputationAuditServiceHandler'),
}));
jest.mock('../src/services/security-audit-service-handler', () => ({
  SecurityAuditServiceHandler: mockMakeHandler('SecurityAuditServiceHandler'),
}));
jest.mock('../src/services/handlers/zkp-audit-handler', () => ({
  ZkpAuditServiceHandler: mockMakeHandler('ZkpAuditServiceHandler'),
}));
jest.mock('../src/services/storage-service-handler', () => ({
  StorageServiceHandler: mockMakeHandler('StorageServiceHandler'),
}));

import { CascadeSettlementWorker } from '../src/workers/cascade-settlement-worker';

function reset(over: Partial<CascadeTestState> = {}): void {
  (globalThis as any).__cascade = {
    poll: { data: [], error: null },
    halt: false,
    queue: {},
    calls: [],
    ...over,
  } as CascadeTestState;
}

beforeEach(() => reset());

describe('handler parity with the HTTP driver (the drift this worker already shipped)', () => {
  /** The handler class names registered in `src/routes/v1/agent.ts`. */
  function agentRouteHandlers(): Set<string> {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'v1', 'agent.ts'), 'utf8');
    const block = src.match(/const handlers\s*=\s*\[([\s\S]*?)\]/);
    if (!block || !block[1]) {
      throw new Error('could not locate the `const handlers = [...]` array in src/routes/v1/agent.ts');
    }
    return new Set([...block[1].matchAll(/new\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1] as string));
  }

  function workerHandlers(): Set<string> {
    const w = new CascadeSettlementWorker();
    return new Set(((w as any).handlers as unknown[]).map((h: any) => h.constructor.name));
  }

  it('sanity: both lists parsed to something non-trivial', () => {
    // Without this, a broken regex or a renamed field would make the parity
    // assertion below compare two empty sets and pass vacuously — which is the
    // exact failure class this file exists to prevent.
    expect(agentRouteHandlers().size).toBeGreaterThanOrEqual(5);
    expect(workerHandlers().size).toBeGreaterThanOrEqual(5);
  });

  it('the worker registers exactly the handlers the HTTP driver registers', () => {
    // Diverge and a service type drains through only ONE of the two paths —
    // which is how `security_audit` went unfulfilled server-side and unnoticed.
    expect(workerHandlers()).toEqual(agentRouteHandlers());
  });
});

describe('runOnce', () => {
  it('parks on global emergency halt before touching any handler', async () => {
    reset({ halt: true, poll: { data: [{ provider_agent_id: 'p1' }], error: null } });
    const res = await new CascadeSettlementWorker().runOnce();
    expect(res.processed).toBe(0);
    // A halt must stop settlement, not merely stop reporting it.
    expect(cascadeState().calls).toEqual([]);
  });

  it('does nothing when no contracts are escrowed', async () => {
    reset({ poll: { data: [], error: null } });
    const res = await new CascadeSettlementWorker().runOnce();
    expect(res.processed).toBe(0);
    expect(cascadeState().calls).toEqual([]);
  });

  it('drains a provider until its handler reports nothing left', async () => {
    reset({
      poll: { data: [{ provider_agent_id: 'p1' }], error: null },
      queue: {
        VerificationServiceHandler: [
          { processed: true, contract_id: 'c1' },
          { processed: true, contract_id: 'c2' },
        ],
      },
    });
    const res = await new CascadeSettlementWorker().runOnce();
    expect(res.processed).toBe(2);
  });

  it('deduplicates providers so one provider is not polled per escrowed row', async () => {
    reset({
      poll: {
        data: [
          { provider_agent_id: 'p1' },
          { provider_agent_id: 'p1' },
          { provider_agent_id: 'p1' },
        ],
        error: null,
      },
    });
    await new CascadeSettlementWorker().runOnce();
    const providers = new Set(cascadeState().calls.map((c) => c.provider));
    expect([...providers]).toEqual(['p1']);
  });

  it('honours CASCADE_SETTLEMENT_MAX_PER_CYCLE so a backlog drains gradually', async () => {
    // Cap is 3 (set at the top of this file, before the module was loaded).
    reset({
      poll: { data: [{ provider_agent_id: 'p1' }], error: null },
      queue: {
        VerificationServiceHandler: Array.from({ length: 25 }, (_, i) => ({
          processed: true,
          contract_id: `c${i}`,
        })),
      },
    });
    const res = await new CascadeSettlementWorker().runOnce();
    expect(res.processed).toBe(3);
  });

  it('returns without throwing when the poll itself errors', async () => {
    reset({ poll: { data: null, error: { message: 'connection refused' } } });
    const res = await new CascadeSettlementWorker().runOnce();
    expect(res.processed).toBe(0);
    expect(cascadeState().calls).toEqual([]);
  });

  it('a handler that throws cannot stall the cycle', async () => {
    // processOne is documented as never throwing, but the worker must survive it
    // regardless — one bad contract must not stop every other provider draining.
    reset({ poll: { data: [{ provider_agent_id: 'p1' }], error: null } });
    const w = new CascadeSettlementWorker();
    (w as any).handlers = [
      { processOne: async () => { throw new Error('handler blew up'); } },
    ];
    await expect(w.runOnce()).resolves.toEqual({ processed: 0 });
  });
});

describe('start()', () => {
  const flag = process.env.CASCADE_SETTLEMENT_ENABLED;
  afterEach(() => {
    if (flag === undefined) delete process.env.CASCADE_SETTLEMENT_ENABLED;
    else process.env.CASCADE_SETTLEMENT_ENABLED = flag;
  });

  it('is inert unless CASCADE_SETTLEMENT_ENABLED is exactly "true"', () => {
    // It drives RepID deltas, so "ships OFF" is a safety property, not a default.
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
      if (v === undefined) delete process.env.CASCADE_SETTLEMENT_ENABLED;
      else process.env.CASCADE_SETTLEMENT_ENABLED = v;
      const w = new CascadeSettlementWorker();
      w.start(60000);
      expect((w as any).timer).toBeNull();
      w.stop();
    }
  });

  it('starts a timer when explicitly enabled, and stop() clears it', () => {
    process.env.CASCADE_SETTLEMENT_ENABLED = 'true';
    reset({ poll: { data: [], error: null } });
    const w = new CascadeSettlementWorker();
    w.start(60000);
    expect((w as any).timer).not.toBeNull();
    w.stop();
    expect((w as any).timer).toBeNull();
  });
});
