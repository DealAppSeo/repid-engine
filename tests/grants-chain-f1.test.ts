/**
 * [F1] The grant chain, at mint and at use (src/services/principal-grants.ts):
 *
 *  - A child grant hangs only under a grant its grantor HOLDS, and only while that parent's chain
 *    is live. Before F1 any caller could attach a child under anyone's grant.
 *  - A widening grant authorizes only while the agent at the top of its chain still has someone
 *    who answers for it. Computed on every check, so an unbind cuts every widening grant under that
 *    person at once, with no cascade write to forget.
 *  - A read that fails is NOT CHECKED, never "live".
 */

const PAI = 'aaaaaaaa-1111-2222-3333-444444444444';
const CMO = 'bbbbbbbb-1111-2222-3333-444444444444';
const SUB = 'cccccccc-1111-2222-3333-444444444444';
const STRANGER = 'eeeeeeee-1111-2222-3333-444444444444';
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

type Row = Record<string, unknown>;
const mockDb: {
  grants: Record<string, Row>;
  bound: Record<string, string>; // agent id -> owner wallet
  custodians: Record<string, string>;
  wallets: Record<string, string>; // agent id -> its own wallet
  failGrantReads: boolean;
  inserts: Row[];
} = { grants: {}, bound: {}, custodians: {}, wallets: {}, failGrantReads: false, inserts: [] };

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const filters: Record<string, unknown> = {};
    const c: any = {
      select: () => c,
      eq: (col: string, val: unknown) => { filters[col] = val; return c; },
      is: () => c,
      or: () => c,
      order: () => c,
      insert: (row: Row) => { mockDb.inserts.push(row); return c; },
      single: async () => ({ data: { id: 'new-grant', ...(mockDb.inserts[mockDb.inserts.length - 1] ?? {}) }, error: null }),
      maybeSingle: async () => {
        if (table === 'principal_grants') {
          if (mockDb.failGrantReads) return { data: null, error: { message: 'db down' } };
          return { data: mockDb.grants[String(filters.id)] ?? null, error: null };
        }
        if (table === 'human_agent_bindings') {
          const w = mockDb.bound[String(filters.agent_id)];
          return { data: w ? { human_wallet: w, owner_kind: 'builder' } : null, error: null };
        }
        if (table === 'repid_agents') {
          return { data: { wallet_address: mockDb.wallets[String(filters.id)] ?? null, conservator_address: mockDb.custodians[String(filters.id)] ?? null }, error: null };
        }
        return { data: null, error: null };
      },
      then: (r: any) => {
        if (table === 'repid_agents' && filters.id) return r({ data: [{ id: filters.id }], error: null });
        return r({ data: [], error: null });
      },
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t) } };
});
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/grantor-authority', () => ({
  resolveAuthorityInputs: jest.fn(async () => ({ ok: false, detail: 'not used by cold grants' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mintGrant, checkAuthorization } = require('../src/services/principal-grants');

function grant(id: string, over: Row): Row {
  return {
    id, parent_grant_id: null, depth: 0, grant_class: 'cold', capabilities: ['read:tool:github'], caveats: [],
    role: null, audit_for: null, not_before: PAST, expires_at: FUTURE, revoked_at: null, revoked_by: null,
    mint_reason: 't', created_at: PAST, idempotency_key: null, grantor_signature: null,
    grantor_wallet_address_used: null, signature_status: null, ...over,
  };
}

beforeEach(() => {
  mockDb.grants = {
    g1: grant('g1', { grantor_agent_id: PAI, grantee_agent_id: CMO }),
  };
  mockDb.bound = { [PAI]: '0x00000000000000000000000000000000000000a1' };
  mockDb.custodians = {};
  mockDb.wallets = {};
  mockDb.failGrantReads = false;
  mockDb.inserts = [];
});

const childMint = (grantor: string) =>
  mintGrant({
    grantorAgentId: grantor, granteeAgentId: SUB, grantClass: 'cold', capabilities: ['read:tool:github'],
    caveats: [], ttlSeconds: 60, parentGrantId: 'g1',
  });

describe('minting a child grant', () => {
  it('under a grant the grantor holds, live: minted at depth 1', async () => {
    const r = await childMint(CMO);
    expect(r.ok).toBe(true);
    expect(mockDb.inserts).toHaveLength(1);
    expect(mockDb.inserts[0]).toMatchObject({ parent_grant_id: 'g1', depth: 1 });
  });

  it("under SOMEONE ELSE'S grant: refused, nothing written", async () => {
    const r = await childMint(STRANGER);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/^parent_not_held_by_grantor/);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('under a revoked parent: refused', async () => {
    mockDb.grants.g1 = { ...mockDb.grants.g1, revoked_at: PAST, revoked_by: PAI };
    const r = await childMint(CMO);
    expect(r.error).toMatch(/^parent_chain_dead/);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('[root] a grantor owned by someone ELSE may not hang a child under this chain', async () => {
    mockDb.bound[CMO] = '0x00000000000000000000000000000000000000b2';
    const r = await childMint(CMO);
    expect(r.error).toMatch(/^root_mismatch/);
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('[root] a grantor owned by the SAME person may', async () => {
    mockDb.bound[CMO] = mockDb.bound[PAI]!;
    const r = await childMint(CMO);
    expect(r.ok).toBe(true);
  });

  it('when the parent cannot be read: NOT CHECKED, nothing written', async () => {
    mockDb.failGrantReads = true;
    const r = await childMint(CMO);
    expect(r.error).toMatch(/^parent_grant_not_checked/);
    expect(mockDb.inserts).toHaveLength(0);
  });
});

describe('using a widening grant: the unbind cut', () => {
  beforeEach(() => {
    mockDb.grants.w1 = grant('w1', { grantor_agent_id: PAI, grantee_agent_id: CMO, capabilities: ['write:tool:github'] });
  });

  it('while the top grantor has an owner, it authorizes', async () => {
    const d = await checkAuthorization('w1', 'write:tool:github', {});
    expect(d.authorized).toBe(true);
  });

  it('after the owner unbinds, the same grant authorizes nothing — computed, no cascade write', async () => {
    delete mockDb.bound[PAI];
    const d = await checkAuthorization('w1', 'write:tool:github', {});
    expect(d).toMatchObject({ authorized: false, outcome: 'FAILED' });
    expect(d.reason).toMatch(/no accountable root/);
  });

  it("a house agent's grant answers to the custodian", async () => {
    delete mockDb.bound[PAI];
    mockDb.custodians[PAI] = '0x00000000000000000000000000000000000000c1';
    expect((await checkAuthorization('w1', 'write:tool:github', {})).authorized).toBe(true);
  });

  it("a 'custodian' that is the agent's own wallet is not a root: an agent cannot answer for itself", async () => {
    // The self-owned ERC-8004 mint writes the agent's own wallet into conservator_address.
    delete mockDb.bound[PAI];
    mockDb.custodians[PAI] = '0x00000000000000000000000000000000000000c1';
    mockDb.wallets[PAI] = '0x00000000000000000000000000000000000000C1';
    const d = await checkAuthorization('w1', 'write:tool:github', {});
    expect(d).toMatchObject({ authorized: false, outcome: 'FAILED' });
    expect(d.reason).toMatch(/no accountable root/);
  });

  it('a read-only grant is not cut: reading carries no power', async () => {
    delete mockDb.bound[PAI];
    expect((await checkAuthorization('g1', 'read:tool:github', {})).authorized).toBe(true);
  });

  it('a child whose ancestor row is missing is chain_dead, not live (the old walk stopped and called it live)', async () => {
    mockDb.grants.orphan = grant('orphan', { grantor_agent_id: CMO, grantee_agent_id: SUB, parent_grant_id: 'gone', depth: 1 });
    const d = await checkAuthorization('orphan', 'read:tool:github', {});
    expect(d).toMatchObject({ authorized: false, outcome: 'FAILED' });
    expect(d.reason).toMatch(/^chain_dead/);
  });
});
