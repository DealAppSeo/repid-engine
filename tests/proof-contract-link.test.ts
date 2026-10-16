/**
 * E1: a daily exchange's proof must reach that exchange's receipt.
 *
 * MEASURED 2026-10-16 (prod, SELECT only): 17 contracts in 15 days, 68 contract score events with a
 * proof job, 68 real EAS-anchored proofs, and 0 queue rows or proof rows carrying contract_id. The
 * only queue rows that ever had one were the one-time 2026-08-01 backfill (newest 05:09Z): no
 * enqueue site wrote the column, so the drain had nothing to copy onto the proof, and the receipt,
 * which looks proofs up by contract, showed `zk_proofs: []` on every exchange.
 *
 * Pinned here as behaviour: contract score event -> queue row with contract_id -> proof row with
 * contract_id and the contract's work_statement_hash.
 */
const CONTRACT = 'c0ffee00-0000-4000-8000-000000000001';
const AGENT = '11111111-2222-4333-8444-555555555555';
const WSH = '0x' + 'd9'.repeat(32);

const g = global as any;
g.__plEvents = [];
g.__plQueue = [];
g.fetch = async () => ({ ok: true, json: async () => ({}) });

jest.mock('../src/db', () => ({
  db: {
    from: (t: string) => {
      const gg = global as any;
      if (t === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { id: '11111111-2222-4333-8444-555555555555', current_repid: 1000, tier: 'ESTABLISHED' }, error: null }) }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      if (t === 'repid_score_events') {
        return {
          insert: (row: any) => ({ select: () => ({ single: async () => { gg.__plEvents.push(row); return { data: { id: 4242 }, error: null }; } }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      if (t === 'repid_proof_queue') {
        return { insert: (row: any) => { gg.__plQueue.push(row); return Promise.resolve({ error: null }); } };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));
jest.mock('../src/services/auditChainWriter', () => ({ appendToAuditChain: async () => ({ ok: true }) }));

import { applyValidationEvent } from '../src/scoring/pipeline';
import { createProofDrainService } from '../src/services/proof-drain-service';

beforeEach(() => {
  g.__plEvents = [];
  g.__plQueue = [];
});

describe('enqueue: a contract score event queues its proof WITH the contract', () => {
  it.each(['SERVICE_FULFILLED', 'SERVICE_SATISFIED'] as const)('%s', async (eventType) => {
    // |delta| >= 5 always triggers a proof (shouldTriggerProof), as the live +15 deltas do.
    await applyValidationEvent(AGENT, eventType, 15, { role: 'provider', contract_id: CONTRACT });

    expect(g.__plEvents).toHaveLength(1);
    const ev = g.__plEvents[0];
    expect(ev.contract_id).toBe(CONTRACT);
    expect(ev.zk_proof_id).toEqual(expect.any(String));

    expect(g.__plQueue).toHaveLength(1);
    const q = g.__plQueue[0];
    expect(q.job_id).toBe(ev.zk_proof_id);
    expect(q.event_id).toBe(4242);
    expect(q.contract_id).toBe(CONTRACT);
  });

  it('an event with no contract queues contract_id null, never a guess', async () => {
    await applyValidationEvent(AGENT, 'VALIDATOR_REWARD', 15, { role: 'validator' });
    expect(g.__plQueue).toHaveLength(1);
    expect(g.__plQueue[0].contract_id).toBeNull();
  });
});

describe('drain: the proof row inherits contract_id and the work-statement hash', () => {
  function drainWith(job: Record<string, unknown>, contracts: Record<string, string | null>) {
    const inserts: Array<Record<string, unknown>> = [];
    const supabase: any = {
      from(t: string) {
        if (t === 'repid_score_events') {
          return { select: () => ({ eq: () => ({ single: async () => ({ data: { repid_after: 2280 }, error: null }) }) }) };
        }
        if (t === 'repid_proof_queue') return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        if (t === 'repid_agents') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tier: 'ESTABLISHED' }, error: null }) }) }) };
        }
        if (t === 'service_contracts') {
          return {
            select: () => ({
              eq: (_c: string, id: string) => ({
                maybeSingle: async () => ({ data: id in contracts ? { work_statement_hash: contracts[id] } : null, error: null }),
              }),
            }),
          };
        }
        if (t === 'repid_zkp_proofs') {
          return {
            insert: (row: Record<string, unknown>) => { inserts.push(row); return Promise.resolve({ error: null }); },
            update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }), is: () => Promise.resolve({ error: null }) }) }),
          };
        }
        throw new Error(`unexpected table ${t}`);
      },
    };
    const svc = createProofDrainService({
      supabase,
      pgQueryImpl: (async () => [job]) as any,
      zkpServiceUrl: 'http://zkp.test',
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
      fetchImpl: (async () => ({ ok: true, json: async () => ({ commitment: '0xreal' }), text: async () => '' })) as any,
    });
    return { svc, inserts };
  }

  it('a contract-linked job writes contract_id + work_statement_hash onto the proof', async () => {
    const { svc, inserts } = drainWith(
      { id: 'r1', job_id: 'job-1', agent_id: AGENT, event_id: '4242', contract_id: CONTRACT, status: 'pending' },
      { [CONTRACT]: WSH },
    );
    expect((await svc.drainOnce()).jobsCompleted).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ job_id: 'job-1', contract_id: CONTRACT, work_statement_hash: WSH });
  });

  it('a job with no contract writes neither, and does not look one up', async () => {
    const { svc, inserts } = drainWith(
      { id: 'r2', job_id: 'job-2', agent_id: AGENT, event_id: '4243', contract_id: null, status: 'pending' },
      {},
    );
    expect((await svc.drainOnce()).jobsCompleted).toBe(1);
    expect(inserts[0]).not.toHaveProperty('contract_id');
    expect(inserts[0]).not.toHaveProperty('work_statement_hash');
  });

  it('a contract settled before ZK BIND T1 (no hash) still links the contract, with no invented hash', async () => {
    const { svc, inserts } = drainWith(
      { id: 'r3', job_id: 'job-3', agent_id: AGENT, event_id: '4244', contract_id: CONTRACT, status: 'pending' },
      { [CONTRACT]: null },
    );
    expect((await svc.drainOnce()).jobsCompleted).toBe(1);
    expect(inserts[0]).toMatchObject({ contract_id: CONTRACT });
    expect(inserts[0]).not.toHaveProperty('work_statement_hash');
  });
});
