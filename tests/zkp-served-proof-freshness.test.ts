/**
 * HYP-7 — serving a proof older than 7 days must be FAILED, not silent.
 *
 * Trustshell harness-acceptance.mjs records zkrepid.freshness FAILED when
 * ageDays > 7. Passport / verify-proof today is `order created_at desc limit 1`
 * with no age bound, so an 8-day-old row is served as if current.
 *
 * No remint. No MODE=full. No Supabase apply.
 */
import { proofFreshnessVerdict } from '../src/zkp/proof-freshness';
import { buildAgentPassport } from '../src/services/agent-passport';

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__passportDb;
  },
}));

function chainResult(result: any) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'or', 'order', 'limit', 'not']) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
  return chain;
}

function makeDb(script: Record<string, any[]>) {
  const queues: Record<string, any[]> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...v]]),
  );
  return {
    from: (table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) throw new Error(`unexpected query on table ${table}`);
      return chainResult(q.shift());
    },
  } as any;
}

const AGENT = {
  id: '11111111-2222-3333-4444-555555555555',
  agent_name: 'trinity-shofet',
  current_repid: 1390,
  tier: 'ESTABLISHED',
  erc8004_token_id: '5863',
};

function scriptWithProofCreatedAt(createdAt: string) {
  return {
    repid_agents: [{ data: AGENT, error: null }],
    x402_settlements: [
      { count: 0, error: null },
      { count: 0, error: null },
      { data: null, error: null },
    ],
    erc8004_reputation_writes: [
      { count: 0, error: null },
      { data: null, error: null },
    ],
    repid_zkp_proofs: [
      {
        data: {
          scheme: 'plonky3_range_check',
          proof_bytes: 'AAAA',
          eas_attestation_uid: null,
          is_real: true,
          zk_commitment: '0xcommitment',
          created_at: createdAt,
        },
        error: null,
      },
    ],
  };
}

describe('served-proof freshness (HYP-7)', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('ageDays > 7 is FAILED, not silent', () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * 86400000).toISOString();
    const v = proofFreshnessVerdict(eightDaysAgo, now);
    expect(v.verdict).toBe('FAILED');
    expect(v.ageDays).toBeGreaterThan(7);
  });

  it('a proof from yesterday is MEASURED', () => {
    const yesterday = new Date(now.getTime() - 1 * 86400000).toISOString();
    const v = proofFreshnessVerdict(yesterday, now);
    expect(v.verdict).toBe('MEASURED');
    expect(v.ageDays).toBeLessThanOrEqual(7);
  });

  it('missing createdAt is NOT_CHECKED', () => {
    expect(proofFreshnessVerdict(null, now).verdict).toBe('NOT_CHECKED');
  });

  it('passport serving an 8-day-old proof labels freshness FAILED', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    const p = await buildAgentPassport(makeDb(scriptWithProofCreatedAt(eightDaysAgo)), AGENT.id);
    expect(p!.zkp.latest_proof).not.toBeNull();
    expect(p!.zkp.latest_proof!.freshness).toBe('FAILED');
    expect(p!.zkp.latest_proof!.age_days).toBeGreaterThan(7);
  });

  it('passport serving a 1-day-old proof labels freshness MEASURED', async () => {
    const yesterday = new Date(Date.now() - 1 * 86400000).toISOString();
    const p = await buildAgentPassport(makeDb(scriptWithProofCreatedAt(yesterday)), AGENT.id);
    expect(p!.zkp.latest_proof!.freshness).toBe('MEASURED');
    expect(p!.zkp.latest_proof!.age_days).toBeLessThanOrEqual(7);
  });
});
