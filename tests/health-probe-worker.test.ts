/**
 * health-probe-worker — the three guards, each tested as the failure it exists to prevent.
 *
 * No real HTTP and no real database: this must be provable without touching the fleet or prod.
 */
const inserted: any[][] = [];
let insertError: { message: string } | null = null;
let halted = false;

jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: (rows: any[]) => { inserted.push(rows); return Promise.resolve({ error: insertError }); } }) },
}));
jest.mock('../src/services/emergency-halt', () => ({
  shouldParkForHalt: () => Promise.resolve(halted),
}));

let probeCalls = 0;
let probeDelayMs = 0;
jest.mock('../src/observability/health-probe', () => ({
  probeFleet: async () => {
    probeCalls++;
    if (probeDelayMs) await new Promise((r) => setTimeout(r, probeDelayMs));
    return [{ agent_name: 'trinity-orch', url: 'u', http_status: 200, ok: true, latency_ms: 5, error: null }];
  },
  summarise: () => '1/1 up',
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const worker = require('../src/workers/health-probe-worker');

beforeEach(() => {
  inserted.length = 0; insertError = null; halted = false;
  probeCalls = 0; probeDelayMs = 0;
  worker.stopHealthProbeWorker();
  delete process.env.HEALTH_PROBE_ENABLED;
  jest.restoreAllMocks();
});
afterAll(() => worker.stopHealthProbeWorker());

describe('guard 1 — default OFF', () => {
  it('does not start unless the flag is exactly "true"', () => {
    expect(worker.startHealthProbeWorker()).toBe(false);
    process.env.HEALTH_PROBE_ENABLED = 'yes';
    expect(worker.startHealthProbeWorker()).toBe(false);
    process.env.HEALTH_PROBE_ENABLED = '1';
    expect(worker.startHealthProbeWorker()).toBe(false);
  });

  it('starts when explicitly enabled, and starting twice is idempotent', () => {
    process.env.HEALTH_PROBE_ENABLED = 'true';
    expect(worker.startHealthProbeWorker(60_000)).toBe(true);
    expect(worker.startHealthProbeWorker(60_000)).toBe(true);
  });

  it('does NOT probe on boot — a crash-loop would otherwise hammer 12 hosts per restart', () => {
    process.env.HEALTH_PROBE_ENABLED = 'true';
    worker.startHealthProbeWorker(60_000);
    expect(probeCalls).toBe(0);
  });
});

describe('guard 2 — honours the L0 halt', () => {
  it('parks without probing or writing when halted', async () => {
    halted = true;
    await worker.runOnce();
    expect(probeCalls).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('runs normally when not halted', async () => {
    await worker.runOnce();
    expect(probeCalls).toBe(1);
    expect(inserted).toHaveLength(1);
  });
});

describe('guard 3 — re-entrancy', () => {
  it('THE OVERLAP CASE: a slow tick does not let a second one start', async () => {
    probeDelayMs = 50;
    const a = worker.runOnce();
    const b = worker.runOnce(); // fires while the first is still in flight
    await Promise.all([a, b]);
    expect(probeCalls).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('releases the guard so the next tick runs', async () => {
    await worker.runOnce();
    await worker.runOnce();
    expect(probeCalls).toBe(2);
  });
});

describe('it can never break the request path', () => {
  it('a failed WRITE does not throw, and is reported as a write failure', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    insertError = { message: 'permission denied' };
    await expect(worker.runOnce()).resolves.toBeUndefined();
    expect(err.mock.calls.flat().join(' ')).toMatch(/NOT persisted/);
  });

  it('a write failure is NOT reported as a fleet failure', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    insertError = { message: 'boom' };
    await worker.runOnce();
    // the probes themselves succeeded; the message must say so rather than implying agents died
    expect(err.mock.calls.flat().join(' ')).toMatch(/probes ran/);
  });

  it('the guard is released even when a tick throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    insertError = { message: 'x' };
    await worker.runOnce();
    await worker.runOnce();
    expect(probeCalls).toBe(2); // not wedged by the previous failure
  });
});
