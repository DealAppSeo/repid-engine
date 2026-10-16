/**
 * Owner-distinct counterparty rule — SHADOW. Three properties:
 *   1. ownerRelation answers 'same' / 'distinct' / 'unknown' per the definition in the module
 *      header, including the production shapes measured 2026-10-16.
 *   2. The flag is strict and default OFF; ON adds exactly one log line, never a throw.
 *   3. applyServiceFulfilledDeltas does the SAME writes with the flag off and on.
 */
const mockOps: Array<{ table: string; op: string; payload?: unknown }> = [];

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
      insert: (payload: unknown) => { mockOps.push({ table, op: 'insert', payload }); return q; },
      then: (ok: any, bad: any) => Promise.resolve({ data: rows[table] ?? null, error: null }).then(ok, bad),
    };
    mockOps.push({ table, op: 'from' });
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
import { resolveOwner, type OwnerClaim, type OwnerResolution } from '../agent-owner-resolver';
import { applyServiceFulfilledDeltas } from '../validation-repid-delta';
import { ownerRelation, logOwnerDistinctShadow } from '../owner-distinct-shadow';

const claim = (ownerKeyKind: OwnerClaim['ownerKeyKind'], ownerKey: string | null, assurance: OwnerClaim['assurance']): OwnerClaim =>
  ({ source: 'repid_agents.builder_id', assurance, ownerKey, ownerKeyKind, capUsdcPerTx: null, capUsdcTotal: null });
const res = (agentId: string | null, ...claims: OwnerClaim[]): OwnerResolution =>
  ({ status: claims.length ? 'resolved' : 'unknown', agentId, owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] });

const FLEET = 'd8e47f71-61b6-45ef-af16-bc5de20b1234';
const B1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const B2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const KYA = claim('opaque', 'qualified_investor', 'declared');

describe('ownerRelation', () => {
  test('the same agent on both sides is same-owner', () => {
    expect(ownerRelation(res('a'), res('a'))).toEqual({ relation: 'same', evidence: 'strong' });
  });

  test('a shared builder is same-owner, case-insensitively, on administrative evidence', () => {
    expect(ownerRelation(res('a', claim('builder_id', B1, 'administrative')), res('b', claim('builder_id', B1.toUpperCase(), 'administrative'))))
      .toEqual({ relation: 'same', evidence: 'administrative' });
  });

  test('a shared signed claim is same-owner on strong evidence', () => {
    expect(ownerRelation(res('a', claim('wallet', '0xAA', 'proven_wallet')), res('b', claim('wallet', '0xaa', 'attested_unverified'))))
      .toEqual({ relation: 'same', evidence: 'strong' });
  });

  test('a shared LOWER-ranked claim still makes it same-owner', () => {
    const buyer = res('a', claim('human_sbt_token', 'T1', 'proven_human'), claim('builder_id', B1, 'administrative'));
    expect(ownerRelation(buyer, res('b', claim('builder_id', B1, 'administrative'))).relation).toBe('same');
  });

  test('different builders are distinct, but only on ADMINISTRATIVE evidence (a fixture builder reads the same)', () => {
    expect(ownerRelation(res('a', claim('builder_id', B1, 'administrative')), res('b', claim('builder_id', B2, 'administrative'))))
      .toEqual({ relation: 'distinct', evidence: 'administrative' });
  });

  test('distinct is strong only when BOTH sides rest on a signed claim', () => {
    expect(ownerRelation(res('a', claim('wallet', '0xA', 'proven_wallet')), res('b', claim('wallet', '0xB', 'attested_unverified'))))
      .toEqual({ relation: 'distinct', evidence: 'strong' });
    expect(ownerRelation(res('a', claim('builder_id', B1, 'proven_wallet')), res('b', claim('builder_id', B2, 'administrative'))))
      .toEqual({ relation: 'distinct', evidence: 'administrative' });
  });

  test('a wallet carried under kind builder_id (resolver quirk) is never compared with a builder', () => {
    expect(ownerRelation(res('a', claim('builder_id', '0xabc', 'proven_wallet')), res('b', claim('builder_id', B2, 'administrative'))))
      .toEqual({ relation: 'unknown', evidence: 'none' });
  });

  test('two equal KYA tiers are NOT one owner: opaque is a category, so unknown', () => {
    expect(ownerRelation(res('a', KYA), res('b', KYA))).toEqual({ relation: 'unknown', evidence: 'none' });
  });

  test('a side with no identity claim is unknown, never distinct', () => {
    expect(ownerRelation(res('a', claim('builder_id', B1, 'administrative')), res('b')).relation).toBe('unknown');
    expect(ownerRelation(res('a', claim('builder_id', null, 'proven_wallet')), res('b', claim('builder_id', B2, 'administrative'))).relation).toBe('unknown');
  });

  test('strongest claims in different namespaces are unknown (a builder can hold an SBT)', () => {
    expect(ownerRelation(res('a', claim('human_sbt_token', 'T1', 'proven_human')), res('b', claim('builder_id', B2, 'administrative'))).relation).toBe('unknown');
  });

  test('claim order does not matter: the strongest identity claim is chosen by rank', () => {
    const buyer = res('a', claim('builder_id', B1, 'administrative'), claim('wallet', '0xA', 'attested_unverified'));
    expect(ownerRelation(buyer, res('b', claim('wallet', '0xB', 'attested_unverified')))).toEqual({ relation: 'distinct', evidence: 'strong' });
  });

  // The three shapes behind the 2026-10-16 measurement (30d settled: 25 same, 3 distinct, 4 unknown,
  // every answer administrative).
  test.each([
    ['nexus -> veritas: KYA tier + fleet builder on both', res('p', KYA, claim('builder_id', FLEET, 'administrative')), 'same', 'administrative'],
    ['nexus -> apm: a different builder', res('p', claim('builder_id', '44cebb64-f4f2-46d1-8782-d83c5bf23202', 'administrative')), 'distinct', 'administrative'],
    ['nexus -> orch: KYA tier only, no builder', res('p', KYA), 'unknown', 'none'],
  ])('%s', (_name, provider, relation, evidence) => {
    const nexus = res('n', KYA, claim('builder_id', FLEET, 'administrative'));
    expect(ownerRelation(nexus, provider)).toEqual({ relation, evidence });
  });
});

describe('logOwnerDistinctShadow', () => {
  const contract = { id: 'c-1', buyer_agent_id: 'buy', provider_agent_id: 'prov' };
  const resolve = jest.fn(async (ref: { id?: string }) => res(ref.id ?? null, claim('builder_id', B1, 'administrative')));
  let log: jest.SpyInstance;
  beforeEach(() => { resolve.mockClear(); log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); delete process.env.OWNER_DISTINCT_SHADOW; });

  test.each([undefined, 'TRUE', '1', 'yes', ''])('flag %p is OFF: no read, no line', async (v) => {
    if (v !== undefined) process.env.OWNER_DISTINCT_SHADOW = v;
    expect(await logOwnerDistinctShadow(contract, resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test("flag 'true': exactly one structured line with what the rule would do", async () => {
    process.env.OWNER_DISTINCT_SHADOW = 'true';
    const line = await logOwnerDistinctShadow(contract, resolve);
    expect(line).toEqual({ event: 'owner_distinct_shadow', contract_id: 'c-1', relation: 'same', evidence: 'administrative', would: 'refuse_same_owner' });
    expect(resolve.mock.calls.map((c) => c[0])).toEqual([{ id: 'buy' }, { id: 'prov' }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(line);
  });

  // Each `would` arm pinned: flipping any entry of OWNER_DISTINCT_WOULD turns one of these red.
  test.each([
    ['distinct (administrative) -> credit', B2, { relation: 'distinct', evidence: 'administrative', would: 'credit' }],
    ['unknown -> refuse_unknown', null, { relation: 'unknown', evidence: 'none', would: 'refuse_unknown' }],
  ])('%s', async (_name, providerBuilder, want) => {
    process.env.OWNER_DISTINCT_SHADOW = 'true';
    const r = async (ref: { id?: string }) =>
      ref.id === 'buy' ? res('buy', claim('builder_id', B1, 'administrative'))
        : providerBuilder ? res('prov', claim('builder_id', providerBuilder, 'administrative')) : res('prov');
    expect(await logOwnerDistinctShadow(contract, r)).toEqual({ event: 'owner_distinct_shadow', contract_id: 'c-1', ...want });
  });

  test('a strong distinct pair is logged with evidence "strong" and would "credit"', async () => {
    process.env.OWNER_DISTINCT_SHADOW = 'true';
    const r = async (ref: { id?: string }) => res(ref.id ?? null, claim('wallet', ref.id === 'buy' ? '0xA' : '0xB', 'proven_wallet'));
    expect(await logOwnerDistinctShadow(contract, r)).toMatchObject({ relation: 'distinct', evidence: 'strong', would: 'credit' });
  });

  test('a resolver that throws is swallowed: null, never a throw into the settle path', async () => {
    process.env.OWNER_DISTINCT_SHADOW = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(logOwnerDistinctShadow(contract, async () => { throw new Error('db down'); })).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('applyServiceFulfilledDeltas: flag off and flag on make the same writes', () => {
  const run = async (flag: string | undefined) => {
    if (flag === undefined) delete process.env.OWNER_DISTINCT_SHADOW;
    else process.env.OWNER_DISTINCT_SHADOW = flag;
    mockOps.length = 0;
    (applyValidationEvent as jest.Mock).mockClear();
    (resolveOwner as jest.Mock).mockReset().mockImplementation(async (ref: { id: string }) =>
      res(ref.id, claim('builder_id', FLEET, 'administrative')));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await applyServiceFulfilledDeltas({ id: 'c-1', service_id: 's-1', provider_agent_id: 'prov', buyer_agent_id: 'buy' });
    await new Promise((r) => setImmediate(r)); // let the un-awaited shadow finish
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    return {
      writes: JSON.stringify({ mockOps, events: (applyValidationEvent as jest.Mock).mock.calls }),
      otherLogs: lines.filter((l) => !l.includes('owner_distinct_shadow')),
      shadowLines: lines.filter((l) => l.includes('owner_distinct_shadow')),
      resolverCalls: (resolveOwner as jest.Mock).mock.calls.length,
    };
  };
  afterAll(() => { delete process.env.OWNER_DISTINCT_SHADOW; delete process.env.HAL_ENRICHMENT_ENABLED; });
  beforeAll(() => { delete process.env.HAL_ENRICHMENT_ENABLED; });

  test('OFF: the resolver is never called and no shadow line is written', async () => {
    const off = await run(undefined);
    expect(off.resolverCalls).toBe(0);
    expect(off.shadowLines).toEqual([]);
    // Real deltas still flow: provider +10, buyer +5 (non-simulated contract).
    expect((applyValidationEvent as jest.Mock).mock.calls.map((c) => [c[0], c[2]])).toEqual([['prov', 10], ['buy', 5]]);
  });

  test('ON: byte-identical writes and logs, plus exactly one shadow line', async () => {
    const off = await run(undefined);
    const on = await run('true');
    expect(on.writes).toBe(off.writes);
    expect(on.otherLogs).toEqual(off.otherLogs);
    expect(on.shadowLines.map((l) => JSON.parse(l))).toEqual([
      { event: 'owner_distinct_shadow', contract_id: 'c-1', relation: 'same', evidence: 'administrative', would: 'refuse_same_owner' },
    ]);
  });
});
