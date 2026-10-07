/**
 * [F1] Only the operator can name a custodian.
 *
 * repid_agents.conservator_address is one of the three things that make an agent answerable
 * (src/services/accountable-root.ts). POST /agents wrote it straight from the request body, and any
 * agent key passes the global auth — the public register hands one out. So anyone could name their
 * own wallet as custodian of a fresh agent and pass every root check as if the operator had vouched.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('../src/engine/repid-update', () => ({
  ...jest.requireActual('../src/engine/repid-update'),
  registerAgent: jest.fn(async () => ({ agentId: 'new-agent', repId: 200, tier: 'PROBATIONARY' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerAgent } = require('../src/engine/repid-update');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentsRouter = require('../src/routes/agents').default;

const app = () => {
  const a = express();
  a.use(express.json());
  // Stands in for the global authMiddleware: the key is already valid; the route decides what it may do.
  a.use((req, _res, next) => { (req as any).apiKey = { key: String(req.headers['x-api-key'] ?? ''), tier: 'pro' }; next(); });
  a.use(agentsRouter);
  return a;
};

const body = { erc8004Address: '0x00000000000000000000000000000000000000e1', agentName: 'fresh-agent' };
const MINE = '0x00000000000000000000000000000000000000f1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REPID_API_KEYS = 'operator-key:pro';
});

describe('POST /agents', () => {
  it('an agent key naming its own wallet as custodian: 403, nothing registered', async () => {
    const res = await request(app()).post('/agents').set('x-api-key', 'ts_live_some_agent_key').send({ ...body, conservatorAddress: MINE });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('custodian_is_operator_only');
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it('the operator key may name a custodian', async () => {
    const res = await request(app()).post('/agents').set('x-api-key', 'operator-key').send({ ...body, conservatorAddress: MINE });
    expect(res.status).toBe(201);
    expect(registerAgent).toHaveBeenCalledWith(expect.objectContaining({ conservatorAddress: MINE }));
  });

  it('an agent key registering without a custodian is unchanged', async () => {
    const res = await request(app()).post('/agents').set('x-api-key', 'ts_live_some_agent_key').send(body);
    expect(res.status).toBe(201);
  });
});
