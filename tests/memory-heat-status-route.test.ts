/**
 * memory-heat-status-route.test.ts — HTTP contract for GET /memory/heat-status (item 13).
 * Mocks `runHeatEvictionSweepForAgent` so no DB or chain is needed.
 */
import express from 'express';
import request from 'supertest';

const mockSweep = jest.fn();
jest.mock('../src/memory/memory-heat-db-sweep', () => ({
  runHeatEvictionSweepForAgent: (...args: any[]) => mockSweep(...args),
}));
jest.mock('../src/db', () => ({ db: {} }));

// eslint-disable-next-line import/first
import memoryHeatStatusRouter from '../src/routes/memory-heat-status';

function makeApp(agentId?: string) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (agentId) req.agent_id = agentId;
    next();
  });
  app.use('/api/v1', memoryHeatStatusRouter);
  return app;
}

const AGENT_ID = 'agent-abc';

const FULL_REPORT = {
  hot: [],
  warm: [],
  cold: [],
  onChain: [],
  evictionCandidates: [{ id: '1' }, { id: '2' }],
  reactivationCandidates: [{ id: '3' }],
  stats: { total: 5, hotCount: 2, warmCount: 1, coldCount: 1, onChainCount: 1 },
};

beforeEach(() => {
  mockSweep.mockReset();
});

describe('GET /api/v1/memory/heat-status', () => {
  it('403s when no agent_id is attached (env-allowlist key)', async () => {
    const res = await request(makeApp(undefined)).get('/api/v1/memory/heat-status');
    expect(res.status).toBe(403);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('returns tier counts and candidate counts for a valid agent', async () => {
    mockSweep.mockResolvedValueOnce(FULL_REPORT);
    const res = await request(makeApp(AGENT_ID)).get('/api/v1/memory/heat-status');
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(res.body.tiers).toEqual({ hot: 2, warm: 1, cold: 1, on_chain: 1, total: 5 });
    expect(res.body.eviction_candidates).toBe(2);
    expect(res.body.reactivation_candidates).toBe(1);
  });

  it('calls sweep with the auth-bound agent_id, not any client-supplied value', async () => {
    mockSweep.mockResolvedValueOnce(FULL_REPORT);
    await request(makeApp(AGENT_ID)).get('/api/v1/memory/heat-status').query({ agent_id: 'attacker' });
    expect(mockSweep).toHaveBeenCalledWith(expect.anything(), AGENT_ID);
  });

  it('500s when the sweep throws', async () => {
    mockSweep.mockRejectedValueOnce(new Error('db gone'));
    const res = await request(makeApp(AGENT_ID)).get('/api/v1/memory/heat-status');
    expect(res.status).toBe(500);
    expect(res.body.detail).toMatch(/db gone/);
  });
});
