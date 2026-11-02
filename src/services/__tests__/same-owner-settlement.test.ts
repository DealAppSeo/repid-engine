/**
 * SAME_OWNER_SETTLEMENT_MODE on the A2A settlement deltas (Sean, option M2, 2026-11-02).
 * The writers under test are the live ones: applyServiceFulfilledDeltas (+10 provider / +5 buyer)
 * and applyServiceSatisfiedDeltas (+30*s / +15*s). Owners come from the #1470 verifier rule
 * (bounty-authorization verifierIndependence) over a mocked resolveOwner. SYNTHETIC fixtures.
 *   unset    exactly today: same deltas, no new metadata key, no owner lookup.
 *   shadow   same deltas; each row records would_not_count.
 *   enforce  same owner or unknown owner earns 0; a stranger still earns in full.
 */
const mockOps: Array<{ table: string; payload: any }> = [];

jest.mock('../../db', () => {
  const rows: Record<string, unknown> = {
    service_contracts: {
      id: 'c-1', service_id: 's-1', provider_agent_id: 'prov', buyer_agent_id: 'buy',
      x402_payment_id: 'pay-1', payload: { content: 'deliverable', task_type: 'research' },
      metadata: {}, result: { verdict: 'PASS' }, agent_services: { service_type: 'research' },
    },
    x402_settlements: { is_simulated: false },
    repid_events: { id: 'ev-1' },
  };
  const from = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q, maybeSingle: () => q, single: () => q,
      insert: (payload: unknown) => { mockOps.push({ table, payload }); return q; },
      then: (ok: any, bad: any) => Promise.resolve({ data: rows[table] ?? null, error: null }).then(ok, bad),
    };
    return q;
  };
  return { db: { from } };
});
jest.mock('../../scoring/pipeline', () => ({ applyValidationEvent: jest.fn(async () => undefined), deriveHalDecision: jest.fn() }));
jest.mock('../onchain-reputation-trigger', () => ({ maybeWriteOnChainReputation: jest.fn(async () => ({ skipped: true })) }));
jest.mock('../agent-owner-resolver', () => ({
  ...jest.requireActual('../agent-owner-resolver'),
  resolveOwner: jest.fn(),
}));

import { applyValidationEvent } from '../../scoring/pipeline';
import { maybeWriteOnChainReputation } from '../onchain-reputation-trigger';
import { resolveOwner, type OwnerClaim, type OwnerResolution } from '../agent-owner-resolver';
import {
  applyServiceFulfilledDeltas, applyServiceSatisfiedDeltas, applyServiceOutcomeDeltas, applyServiceDisputeResolution,
} from '../validation-repid-delta';

const claim = (ownerKey: string): OwnerClaim =>
  ({ source: 'repid_agents.builder_id', assurance: 'administrative', ownerKey, ownerKeyKind: 'builder_id', capUsdcPerTx: null, capUsdcTotal: null });
const res = (agentId: string, ...claims: OwnerClaim[]): OwnerResolution =>
  ({ status: claims.length ? 'resolved' : 'unknown', agentId, owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] });

const FLEET = 'd8e47f71-61b6-45ef-af16-bc5de20b1234'; // the shape measured 2026-11-02: nexus and hdm share this builder
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const contract = { id: 'c-1', service_id: 's-1', provider_agent_id: 'prov', buyer_agent_id: 'buy' };

const resolve = resolveOwner as jest.MockedFunction<typeof resolveOwner>;
const apply = applyValidationEvent as jest.MockedFunction<typeof applyValidationEvent>;
const onchain = maybeWriteOnChainReputation as jest.MockedFunction<typeof maybeWriteOnChainReputation>;
/** The repid_events bridge (outbox) row that FeedbackLoopWorker drains into the on-chain write. */
const bridge = () => mockOps.find((o) => o.table === 'repid_events')?.payload;
const owners = (buyer: OwnerResolution, provider: OwnerResolution) =>
  resolve.mockImplementation(async (ref) => (ref.id === 'buy' ? buyer : provider));
const SAME = () => owners(res('buy', claim(FLEET)), res('prov', claim(FLEET)));
const STRANGERS = () => owners(res('buy', claim(FLEET)), res('prov', claim(OTHER)));
const PROVIDER_UNKNOWN = () => owners(res('buy', claim(FLEET)), res('prov'));

/** [agent, event, delta, metadata.same_owner_settlement] for every canonical row written. */
const rows = () => apply.mock.calls.map((c) => [c[0], c[1], c[2], (c[3] as any)?.same_owner_settlement]);
const run = async () => {
  await applyServiceFulfilledDeltas(contract);
  await applyServiceSatisfiedDeltas(contract, 1);
};

const prior = process.env.SAME_OWNER_SETTLEMENT_MODE;
let log: jest.SpyInstance;
beforeEach(() => {
  apply.mockClear();
  onchain.mockClear();
  resolve.mockReset();
  mockOps.length = 0;
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  log.mockRestore();
  if (prior === undefined) delete process.env.SAME_OWNER_SETTLEMENT_MODE;
  else process.env.SAME_OWNER_SETTLEMENT_MODE = prior;
});

describe('unset (default): today exactly', () => {
  test.each([undefined, 'off', ' OFF '])('mode=%p: full deltas, no owner lookup, no new metadata key', async (mode) => {
    if (mode === undefined) delete process.env.SAME_OWNER_SETTLEMENT_MODE;
    else process.env.SAME_OWNER_SETTLEMENT_MODE = mode;
    SAME();
    await run();
    expect(resolve).not.toHaveBeenCalled();
    expect(rows()).toEqual([
      ['prov', 'SERVICE_FULFILLED', 10, undefined],
      ['buy', 'SERVICE_FULFILLED', 5, undefined],
      ['prov', 'SERVICE_SATISFIED', 30, undefined],
      ['buy', 'SERVICE_SATISFIED', 15, undefined],
    ]);
    for (const c of apply.mock.calls) expect(c[3]).not.toHaveProperty('same_owner_settlement');
    expect(mockOps.find((o) => o.table === 'repid_events')?.payload.reputation_delta).toBe(10);
  });
});

describe('shadow: records would-not-count, moves no canonical number', () => {
  beforeEach(() => { process.env.SAME_OWNER_SETTLEMENT_MODE = 'shadow'; });

  test('same owner: every delta unchanged, every row says same_owner', async () => {
    SAME();
    await run();
    const tag = (d: number) => ({ mode: 'shadow', would_not_count: 'same_owner', counted: true, ungated_delta: d });
    expect(rows()).toEqual([
      ['prov', 'SERVICE_FULFILLED', 10, tag(10)],
      ['buy', 'SERVICE_FULFILLED', 5, tag(5)],
      ['prov', 'SERVICE_SATISFIED', 30, tag(30)],
      ['buy', 'SERVICE_SATISFIED', 15, tag(15)],
    ]);
    expect(mockOps.find((o) => o.table === 'repid_events')?.payload.reputation_delta).toBe(10);
  });

  test('owner unknown on one side: unchanged, recorded as owner_unknown', async () => {
    PROVIDER_UNKNOWN();
    await run();
    expect(rows().map((r) => r[2])).toEqual([10, 5, 30, 15]);
    expect(rows().every((r) => r[3]?.would_not_count === 'owner_unknown')).toBe(true);
  });
});

describe('enforce: same owner or unknown owner earns no canonical RepID', () => {
  beforeEach(() => { process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce'; });

  test('same owner: all four deltas are 0, the ungated delta is kept for audit', async () => {
    SAME();
    await run();
    const tag = (d: number) => ({ mode: 'enforce', would_not_count: 'same_owner', counted: false, ungated_delta: d });
    expect(rows()).toEqual([
      ['prov', 'SERVICE_FULFILLED', 0, tag(10)],
      ['buy', 'SERVICE_FULFILLED', 0, tag(5)],
      ['prov', 'SERVICE_SATISFIED', 0, tag(30)],
      ['buy', 'SERVICE_SATISFIED', 0, tag(15)],
    ]);
    expect(mockOps.find((o) => o.table === 'repid_events')?.payload.reputation_delta).toBe(0);
  });

  test('owner unknown on one side: not independent, 0', async () => {
    PROVIDER_UNKNOWN();
    await run();
    expect(rows().map((r) => r[2])).toEqual([0, 0, 0, 0]);
    expect(rows().every((r) => r[3]?.would_not_count === 'owner_unknown')).toBe(true);
  });

  test('the owner lookup throwing fails closed (owner_unknown, 0)', async () => {
    resolve.mockRejectedValue(new Error('db down'));
    await run();
    expect(rows().map((r) => r[2])).toEqual([0, 0, 0, 0]);
    expect(rows().every((r) => r[3]?.would_not_count === 'owner_unknown')).toBe(true);
  });

  test('a stranger (different owner) still earns in full: the gate does not refuse everything', async () => {
    STRANGERS();
    await run();
    const tag = (d: number) => ({ mode: 'enforce', would_not_count: null, counted: true, ungated_delta: d });
    expect(rows()).toEqual([
      ['prov', 'SERVICE_FULFILLED', 10, tag(10)],
      ['buy', 'SERVICE_FULFILLED', 5, tag(5)],
      ['prov', 'SERVICE_SATISFIED', 30, tag(30)],
      ['buy', 'SERVICE_SATISFIED', 15, tag(15)],
    ]);
  });

  test('a contract with the same agent on both sides is same_owner', async () => {
    owners(res('x', claim(FLEET)), res('x', claim(FLEET)));
    await applyServiceSatisfiedDeltas({ id: 'c-1', provider_agent_id: 'x', buyer_agent_id: 'x' }, 1);
    expect(rows().map((r) => [r[2], r[3]?.would_not_count])).toEqual([[0, 'same_owner'], [0, 'same_owner']]);
  });
});

// ── On-chain: the ERC-8004 reputation write a settlement triggers ────────────────────────────────
// Two paths write it, both from the repid_events `service_fulfilled_settled` bridge row: the inline
// maybeWriteOnChainReputation call, and FeedbackLoopWorker, which polls rows with processed_at NULL
// (and is the one that actually writes under pay-on-verified-delivery). Skipping means: no inline
// call AND the bridge row is born processed, so the worker never picks it up.
describe('on-chain reputation write', () => {
  test.each([undefined, 'off'])('mode=%p: called as today, bridge row byte-identical, no owner lookup', async (mode) => {
    if (mode === undefined) delete process.env.SAME_OWNER_SETTLEMENT_MODE;
    else process.env.SAME_OWNER_SETTLEMENT_MODE = mode;
    SAME();
    await applyServiceFulfilledDeltas(contract);
    expect(resolve).not.toHaveBeenCalled();
    expect(onchain).toHaveBeenCalledTimes(1);
    expect(bridge()).toEqual({
      subject_id: 'prov', subject_type: 'agent', event_type: 'service_fulfilled_settled', reputation_delta: 10,
      event_data: {
        is_simulated: false, tx_hash: null, contract_id: 'c-1',
        metadata: { contract_id: 'c-1', x402_payment_id: 'pay-1', task_type: 'research', verdict: 'PASS' },
      },
    });
  });

  test.each(['same_owner', 'owner_unknown'] as const)('enforce + %s: no on-chain call, reason recorded, bridge row closed', async (why) => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    (why === 'same_owner' ? SAME : PROVIDER_UNKNOWN)();
    await applyServiceFulfilledDeltas(contract);
    expect(onchain).not.toHaveBeenCalled();
    expect(bridge().event_data.onchain_skipped).toBe(why);
    expect(typeof bridge().processed_at).toBe('string'); // FeedbackLoopWorker polls processed_at IS NULL only
    expect(log.mock.calls.flat().join('\n')).toContain(`onchain_skipped: ${why}`);
  });

  test('enforce + different owners: on-chain write still called, bridge row as today', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    STRANGERS();
    await applyServiceFulfilledDeltas(contract);
    expect(onchain).toHaveBeenCalledTimes(1);
    expect(bridge()).not.toHaveProperty('processed_at');
    expect(bridge().event_data).not.toHaveProperty('onchain_skipped');
    expect(bridge().event_data).not.toHaveProperty('onchain_would_skip');
  });

  test('shadow + same owner: still written, would-skip recorded, bridge row left open', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'shadow';
    SAME();
    await applyServiceFulfilledDeltas(contract);
    expect(onchain).toHaveBeenCalledTimes(1);
    expect(bridge()).not.toHaveProperty('processed_at');
    expect(bridge().event_data.onchain_would_skip).toBe('same_owner');
    expect(bridge().event_data).not.toHaveProperty('onchain_skipped');
  });
});

// ── T3 SERVICE_OUTCOME (provider only, rater-weighted) ───────────────────────────────────────────
describe('T3 SERVICE_OUTCOME', () => {
  const outcome = (rating: 'good' | 'bad' = 'good') => applyServiceOutcomeDeltas(contract, rating, 1000);

  test.each([undefined, 'off'])('mode=%p: today exactly, no owner lookup', async (mode) => {
    if (mode === undefined) delete process.env.SAME_OWNER_SETTLEMENT_MODE;
    else process.env.SAME_OWNER_SETTLEMENT_MODE = mode;
    SAME();
    const r = await outcome();
    expect(resolve).not.toHaveBeenCalled();
    expect(rows()).toEqual([['prov', 'SERVICE_OUTCOME', 60, undefined]]);
    expect(r.providerDelta).toBe(60);
  });

  test('shadow + same owner: 60 unchanged, recorded', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'shadow';
    SAME();
    await outcome();
    expect(rows()).toEqual([['prov', 'SERVICE_OUTCOME', 60, { mode: 'shadow', would_not_count: 'same_owner', counted: true, ungated_delta: 60 }]]);
  });

  test.each(['same_owner', 'owner_unknown'] as const)('enforce + %s: withheld (0), recorded, good and bad alike', async (why) => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    (why === 'same_owner' ? SAME : PROVIDER_UNKNOWN)();
    const good = await outcome('good');
    const bad = await outcome('bad');
    expect(rows()).toEqual([
      ['prov', 'SERVICE_OUTCOME', 0, { mode: 'enforce', would_not_count: why, counted: false, ungated_delta: 60 }],
      ['prov', 'SERVICE_OUTCOME', 0, { mode: 'enforce', would_not_count: why, counted: false, ungated_delta: -80 }],
    ]);
    expect([good.providerDelta, bad.providerDelta]).toEqual([0, 0]);
    expect(bad.disputeEligible).toBe(true); // a flag, not a score move
  });

  test('enforce + different owners: full 60', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    STRANGERS();
    await outcome();
    expect(rows()).toEqual([['prov', 'SERVICE_OUTCOME', 60, { mode: 'enforce', would_not_count: null, counted: true, ungated_delta: 60 }]]);
  });
});

// ── Dispute deltas (BFT verdict from dispute-resolution-worker) ──────────────────────────────────
describe('dispute deltas', () => {
  const dispute = () => applyServiceDisputeResolution(contract, 'provider_at_fault');

  test.each([undefined, 'off'])('mode=%p: today exactly, no owner lookup', async (mode) => {
    if (mode === undefined) delete process.env.SAME_OWNER_SETTLEMENT_MODE;
    else process.env.SAME_OWNER_SETTLEMENT_MODE = mode;
    SAME();
    await dispute();
    expect(resolve).not.toHaveBeenCalled();
    expect(rows()).toEqual([['prov', 'VALIDATION_FAILED', -100, undefined], ['buy', 'SERVICE_FULFILLED', 20, undefined]]);
  });

  test('shadow + same owner: unchanged, recorded', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'shadow';
    SAME();
    await dispute();
    const tag = (d: number) => ({ mode: 'shadow', would_not_count: 'same_owner', counted: true, ungated_delta: d });
    expect(rows()).toEqual([['prov', 'VALIDATION_FAILED', -100, tag(-100)], ['buy', 'SERVICE_FULFILLED', 20, tag(20)]]);
  });

  test.each(['same_owner', 'owner_unknown'] as const)('enforce + %s: no canonical movement either side, recorded', async (why) => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    (why === 'same_owner' ? SAME : PROVIDER_UNKNOWN)();
    await dispute();
    const tag = (d: number) => ({ mode: 'enforce', would_not_count: why, counted: false, ungated_delta: d });
    expect(rows()).toEqual([['prov', 'VALIDATION_FAILED', 0, tag(-100)], ['buy', 'SERVICE_FULFILLED', 0, tag(20)]]);
  });

  test('enforce + different owners: full -100 / +20', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    STRANGERS();
    await dispute();
    expect(rows().map((r) => r[2])).toEqual([-100, 20]);
  });

  test('no_fault writes nothing', async () => {
    process.env.SAME_OWNER_SETTLEMENT_MODE = 'enforce';
    SAME();
    await applyServiceDisputeResolution(contract, 'no_fault');
    expect(rows()).toEqual([]);
  });
});
