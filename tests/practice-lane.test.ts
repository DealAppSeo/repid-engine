/**
 * Practice lane, slice P1 (services/practice-lane.ts, GET /api/v1/lane/:agent).
 * The rule under test: a gate that cannot be measured is never passed, so the lane stays 'practice'
 * until every gate is VERIFIED; and a read that fails is NOT CHECKED, never FAILED or VERIFIED.
 */
jest.mock('../src/db', () => {
  const chainFor = (table: string) => {
    const filters: Record<string, unknown> = {};
    const c: any = {
      select: () => c, is: () => c,
      eq: (col: string, val: unknown) => { filters[col] = val; return c; },
      maybeSingle: async () => ({ data: table === 'human_agent_bindings' ? { human_wallet: '0x00000000000000000000000000000000000000b1' } : null, error: null }),
      then: (r: any) => r({
        data: table === 'repid_agents' && filters.id === 'aaaaaaaa-1111-2222-3333-444444444444'
          ? [{ id: filters.id, agent_name: 'my-agent', wallet_address: '0x00000000000000000000000000000000000000a9' }]
          : [],
        error: null,
      }),
    };
    return c;
  };
  return { db: { from: (t: string) => chainFor(t) } };
});

import express from 'express';
import request from 'supertest';
import { laneReport, combine, laneOf, type LaneReader, type Gate } from '../src/services/practice-lane';
import { createLaneRouter } from '../src/routes/lane';
import type { SpendChain } from '../src/services/agent-spend';

const AGENT = { id: 'aaaaaaaa-1111-2222-3333-444444444444', agent_name: 'my-agent', wallet_address: '0x00000000000000000000000000000000000000a9' };
const OWNER = '0x00000000000000000000000000000000000000b1';

function reader(over: Partial<{ agents: LaneReader['agents']; binding: LaneReader['binding'] }> = {}): LaneReader {
  return {
    agents: over.agents ?? (async () => [AGENT]),
    binding: over.binding ?? (async () => ({ human_wallet: OWNER })),
  };
}
function chain(allowance: bigint | Error, chainId = 84532n): SpendChain {
  return {
    chainId: async () => chainId,
    allowance: async () => { if (allowance instanceof Error) throw allowance; return allowance; },
    balanceOf: async () => 0n, ethBalance: async () => 0n,
    gasCost: async () => 0n, send: async () => { throw new Error('never sends'); },
  };
}
const gate = (r: Awaited<ReturnType<typeof laneReport>>, id: string) => (r.ok ? r.report.gates.find((g) => g.id === id)! : undefined);
const part = (g: Gate | undefined, id: string) => g?.parts?.find((p) => p.id === id);

describe('laneReport', () => {
  it('a claimed agent with a limit set: bound VERIFIED, limit VERIFIED, still practice (two gates have no record yet)', async () => {
    const r = await laneReport(AGENT.id, { reader: reader(), chain: chain(5_000_000n) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(gate(r, 'bound_both_ways')!.status).toBe('VERIFIED');
    expect(part(gate(r, 'limit_payee_stop'), 'limit')).toMatchObject({ status: 'VERIFIED' });
    expect(part(gate(r, 'limit_payee_stop'), 'limit')!.detail).toMatch(/5 test USDC/);
    expect(gate(r, 'limit_payee_stop')!.status).toBe('NOT_CHECKED'); // payee and stop are unmeasurable
    expect(gate(r, 'seen_a_caught')!.status).toBe('NOT_CHECKED');
    expect(gate(r, 'signed_acknowledgement')!.status).toBe('NOT_CHECKED');
    expect(r.report.lane).toBe('practice');
    expect(r.report.summary).toEqual({ VERIFIED: 1, FAILED: 0, NOT_CHECKED: 3 });
  });

  it('an unclaimed agent: bound FAILED, and the limit is NOT CHECKED (it needs an owner to read)', async () => {
    const r = await laneReport(AGENT.id, { reader: reader({ binding: async () => null }), chain: chain(5_000_000n) });
    expect(gate(r, 'bound_both_ways')!.status).toBe('FAILED');
    expect(part(gate(r, 'limit_payee_stop'), 'limit')!.status).toBe('NOT_CHECKED');
  });

  it('a limit of 0 (none set, or stopped) is measured: the gate is FAILED', async () => {
    const r = await laneReport(AGENT.id, { reader: reader(), chain: chain(0n) });
    expect(part(gate(r, 'limit_payee_stop'), 'limit')!.status).toBe('FAILED');
    expect(gate(r, 'limit_payee_stop')!.status).toBe('FAILED');
  });

  it('the owner read fails: NOT CHECKED, never FAILED ("nobody owns it") or VERIFIED', async () => {
    const r = await laneReport(AGENT.id, { reader: reader({ binding: async () => { throw new Error('db down'); } }), chain: chain(5_000_000n) });
    expect(gate(r, 'bound_both_ways')!.status).toBe('NOT_CHECKED');
    expect(r.ok && r.report.lane).toBe('practice');
  });

  it('the chain read fails, or answers for another chain: the limit is NOT CHECKED', async () => {
    const down = await laneReport(AGENT.id, { reader: reader(), chain: chain(new Error('rpc timeout')) });
    expect(part(gate(down, 'limit_payee_stop'), 'limit')!.status).toBe('NOT_CHECKED');
    const wrong = await laneReport(AGENT.id, { reader: reader(), chain: chain(5_000_000n, 1n) });
    expect(part(gate(wrong, 'limit_payee_stop'), 'limit')!.status).toBe('NOT_CHECKED');
  });

  it('an agent with no wallet of its own: the limit is FAILED (measured: nothing to set it on)', async () => {
    const r = await laneReport(AGENT.id, { reader: reader({ agents: async () => [{ ...AGENT, wallet_address: null }] }), chain: chain(5_000_000n) });
    expect(part(gate(r, 'limit_payee_stop'), 'limit')!.status).toBe('FAILED');
  });

  it('unknown agent 404, ambiguous name 409, lookup failure 503', async () => {
    expect(await laneReport('nobody', { reader: reader({ agents: async () => [] }) })).toMatchObject({ ok: false, status: 404 });
    expect(await laneReport('twins', { reader: reader({ agents: async () => [AGENT, { ...AGENT, id: 'other' }] }) })).toMatchObject({ ok: false, status: 409 });
    expect(await laneReport('x', { reader: reader({ agents: async () => { throw new Error('db down'); } }) })).toMatchObject({ ok: false, status: 503 });
  });
});

describe('the lane rule', () => {
  const g = (status: Gate['status']): Gate => ({ id: 'seen_a_caught', title: 't', status, detail: 'd' });
  it('combine: FAILED beats NOT_CHECKED beats VERIFIED', () => {
    expect(combine(['VERIFIED', 'NOT_CHECKED', 'FAILED'])).toBe('FAILED');
    expect(combine(['VERIFIED', 'NOT_CHECKED'])).toBe('NOT_CHECKED');
    expect(combine(['VERIFIED', 'VERIFIED'])).toBe('VERIFIED');
  });
  it("'eligible' only when every gate is VERIFIED; one unmeasured gate keeps it on paper", () => {
    expect(laneOf([g('VERIFIED'), g('VERIFIED')])).toBe('eligible');
    expect(laneOf([g('VERIFIED'), g('NOT_CHECKED')])).toBe('practice');
    expect(laneOf([])).toBe('practice');
  });
});

describe('GET /api/v1/lane/:agent', () => {
  const app = () => {
    const a = express();
    a.use('/api/v1', createLaneRouter(chain(5_000_000n)));
    return a;
  };

  it('answers without a key, never cached, and says practice', async () => {
    const res = await request(app()).get(`/api/v1/lane/${AGENT.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.lane).toBe('practice');
    expect(res.body.gates).toHaveLength(4);
  });

  it('404 for an unknown agent', async () => {
    const res = await request(app()).get('/api/v1/lane/nobody-by-this-name');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
  });
});
