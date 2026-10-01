/**
 * memory-heat-evict-route.test.ts — HTTP contract for POST /memory/evict (item 13).
 * Mocks `evictAndUpdateRoot` so no DB or chain is needed.
 */
import express from 'express';
import request from 'supertest';

const mockEvict = jest.fn();
jest.mock('../src/memory/memory-heat-evict-root', () => ({
  evictAndUpdateRoot: (...args: any[]) => mockEvict(...args),
}));
jest.mock('../src/db', () => ({ db: {} }));

// eslint-disable-next-line import/first
import memoryHeatEvictRouter from '../src/routes/memory-heat-evict-route';

function makeApp(agentId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (agentId) req.agent_id = agentId;
    next();
  });
  app.use('/api/v1', memoryHeatEvictRouter);
  return app;
}

const AGENT_ID = 'agent-xyz';

beforeEach(() => {
  mockEvict.mockReset();
});

describe('POST /api/v1/memory/evict', () => {
  it('403s when no agent_id is bound (env-allowlist key)', async () => {
    const res = await request(makeApp(undefined)).post('/api/v1/memory/evict');
    expect(res.status).toBe(403);
    expect(mockEvict).not.toHaveBeenCalled();
  });

  it('returns skipped:true when HEAT_EVICTION_ENABLED is off', async () => {
    mockEvict.mockResolvedValueOnce({ skipped: true, evictedCount: 0, evictedIds: [] });
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/evict');
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.evicted_count).toBe(0);
    expect(res.body.new_root).toBeNull();
    expect(res.body.new_epoch).toBeNull();
  });

  it('returns eviction result with root when leaves are evicted', async () => {
    mockEvict.mockResolvedValueOnce({
      skipped: false,
      evictedCount: 3,
      evictedIds: ['a', 'b', 'c'],
      newRoot: '0xdeadbeef',
      newEpoch: 7,
    });
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/evict');
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(res.body.skipped).toBe(false);
    expect(res.body.evicted_count).toBe(3);
    expect(res.body.evicted_ids).toEqual(['a', 'b', 'c']);
    expect(res.body.new_root).toBe('0xdeadbeef');
    expect(res.body.new_epoch).toBe(7);
  });

  it('calls evictAndUpdateRoot with the auth-bound agent_id, not any client-supplied value', async () => {
    mockEvict.mockResolvedValueOnce({ skipped: true, evictedCount: 0, evictedIds: [] });
    await request(makeApp(AGENT_ID))
      .post('/api/v1/memory/evict')
      .send({ agent_id: 'attacker' });
    expect(mockEvict).toHaveBeenCalledWith(expect.anything(), AGENT_ID);
  });

  it('500s when evictAndUpdateRoot throws', async () => {
    mockEvict.mockRejectedValueOnce(new Error('eviction boom'));
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/evict');
    expect(res.status).toBe(500);
    expect(res.body.detail).toMatch(/eviction boom/);
  });
});
