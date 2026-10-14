/**
 * GET /agents/:id/onchain and GET /agents/:id/owner accept a NAME as well as a uuid, like their
 * neighbours /repid/:id and /passport/:id. Before: "trinity-sophia" reached a uuid column and
 * Postgres raised 22P02, so on production /onchain answered 500 with the raw database error and
 * /owner answered 503 owner_not_checked ("we could not look") for what was malformed input
 * [measured 2026-10-14]. Names are not unique, so two matches are a 409, never a guess.
 */
import express from 'express';
import request from 'supertest';

const UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const OTHER = 'aaaaaaaa-1111-2222-3333-444444444444';
const names: Record<string, string[]> = {};
const bindingLookups: string[] = [];

// Module db for the byok router: the name lookup is awaited, bindings use maybeSingle.
jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const eqs: Record<string, unknown> = {};
    const c: any = {
      select: () => c,
      is: () => c,
      order: () => c,
      eq: (col: string, val: unknown) => {
        eqs[col] = val;
        if (table === 'human_agent_bindings' && col === 'agent_id') bindingLookups.push(String(val));
        return c;
      },
      maybeSingle: async () =>
        table === 'repid_agents' ? { data: { builder_id: null }, error: null } : { data: null, error: null },
      then: (r: any) =>
        r({ data: (names[String(eqs['agent_name'])] ?? []).map((id) => ({ id })), error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const byokRouter = require('../src/routes/v1/byok').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAgentsOnchainRouter } = require('../src/routes/agents-onchain');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Erc8004Minter } = require('../src/services/erc8004-minter');

/** Injected client for the onchain router: only the name lookup is ever awaited here. */
function fakeSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, val: string) =>
          Promise.resolve({ data: (names[val] ?? []).map((id) => ({ id })), error: null }),
      }),
    }),
  } as any;
}

beforeEach(() => {
  for (const k of Object.keys(names)) delete names[k];
  bindingLookups.length = 0;
  delete process.env.ERC8004_MINTER_PRIVATE_KEY;
});

describe('GET /agents/:id/onchain', () => {
  const app = () => {
    const a = express();
    a.use('/api/v1/agents', createAgentsOnchainRouter(fakeSupabase()));
    return a;
  };
  let verified: string[];
  beforeEach(() => {
    verified = [];
    jest.spyOn(Erc8004Minter.prototype, 'verifyOnChain').mockImplementation(async (id: unknown) => {
      verified.push(String(id));
      return { check: 'OWNER_FOUND', agent: String(id) };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('resolves a name to its uuid and reads that agent', async () => {
    names['trinity-sophia'] = [UUID];
    const res = await request(app()).get('/api/v1/agents/trinity-sophia/onchain');
    expect(res.status).toBe(200);
    expect(verified).toEqual([UUID]);
  });

  it('an unknown name is 404, not a 500 carrying a database error', async () => {
    const res = await request(app()).get('/api/v1/agents/nobody-here/onchain');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
    expect(JSON.stringify(res.body)).not.toMatch(/uuid|22P02|syntax/i);
    expect(verified).toEqual([]);
  });

  it('a name two agents share is 409, never a guess', async () => {
    names['dup'] = [UUID, OTHER];
    const res = await request(app()).get('/api/v1/agents/dup/onchain');
    expect(res.status).toBe(409);
    expect(verified).toEqual([]);
  });

  it('a uuid is passed through without a lookup', async () => {
    const res = await request(app()).get(`/api/v1/agents/${UUID}/onchain`);
    expect(res.status).toBe(200);
    expect(verified).toEqual([UUID]);
  });
});

describe('GET /api/v1/agents/:id/owner', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1', byokRouter);
    return a;
  };

  it('resolves a name to its uuid and asks the binding table about THAT uuid', async () => {
    names['trinity-sophia'] = [UUID];
    const res = await request(app()).get('/api/v1/agents/trinity-sophia/owner');
    expect(res.status).toBe(200);
    expect(res.body.owned).toBe(false);
    // linkedButUnbound asks ownerOfAgent too, so the table is read more than once: every read is the uuid.
    expect(bindingLookups.length).toBeGreaterThan(0);
    expect(new Set(bindingLookups)).toEqual(new Set([UUID]));
  });

  it('an unknown name is 404, not 503 "could not read"', async () => {
    const res = await request(app()).get('/api/v1/agents/nobody-here/owner');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
    expect(bindingLookups).toEqual([]);
  });

  it('a name two agents share is 409, never a guess', async () => {
    names['dup'] = [UUID, OTHER];
    const res = await request(app()).get('/api/v1/agents/dup/owner');
    expect(res.status).toBe(409);
    expect(bindingLookups).toEqual([]);
  });

  it('a uuid is used as-is', async () => {
    const res = await request(app()).get(`/api/v1/agents/${UUID}/owner`);
    expect(res.status).toBe(200);
    expect(new Set(bindingLookups)).toEqual(new Set([UUID]));
  });
});
