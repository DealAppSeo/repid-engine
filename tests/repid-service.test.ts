/**
 * Sprint R-C Phase B4 — RepID lookup service unit tests with mocked DB.
 *
 * Mocks `src/db.ts` so the supabase client never makes a real call. Tests
 * the shape of the service responses for found / not-found / db-error /
 * autonomous-cap and the history aggregation logic.
 */
jest.mock('../src/db', () => {
  const chain: any = {};
  return {
    db: {
      from: jest.fn().mockReturnValue(chain),
      __chain: chain, // expose for tests to configure
    },
  };
});

import { db } from '../src/db';
import {
  getRepIDForAgent,
  getRepIDHistory,
  AUTONOMOUS_CAP,
} from '../src/repid/repid-service';

const mockedDb = db as any;

function setMaybeSingleResponse(data: any, error: any = null) {
  // chained: db.from('repid_agents').select(...).eq(...).maybeSingle()
  const result = { data, error };
  mockedDb.__chain.select = jest.fn().mockReturnThis();
  mockedDb.__chain.eq = jest.fn().mockReturnThis();
  mockedDb.__chain.maybeSingle = jest.fn().mockResolvedValue(result);
}

function setHistoryResponse(rows: any[], error: any = null) {
  // chained: db.from('repid_score_events').select(...).eq(...).order(...).gte?(...)
  // The query chain is build-style; we make every link return `chain` and
  // the terminal call returns the data via thenable.
  const result = { data: rows, error };
  mockedDb.__chain.select = jest.fn().mockReturnThis();
  mockedDb.__chain.eq = jest.fn().mockReturnThis();
  mockedDb.__chain.order = jest.fn().mockReturnThis();
  mockedDb.__chain.gte = jest.fn().mockReturnThis();
  // The chain object itself is awaited as the final result
  mockedDb.__chain.then = (resolve: any) => resolve(result);
}

describe('RepID service (Sprint R-C Phase B1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getRepIDForAgent returns cached when score is below cap', async () => {
    setMaybeSingleResponse({
      id: 'agent-A',
      current_repid: 4500,
      tier: 'EARNING_AUTONOMY',
      updated_at: '2026-05-05T10:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const r = await getRepIDForAgent('agent-A');
    expect(r.agent_id).toBe('agent-A');
    expect(r.repid_score).toBe(4500);
    expect(r.tier).toBe('EARNING_AUTONOMY');
    expect(r.last_updated).toBe('2026-05-05T10:00:00.000Z');
    expect(r.source).toBe('cached');
  });

  test('getRepIDForAgent returns autonomous_cap when score == cap', async () => {
    setMaybeSingleResponse({
      id: 'sophia',
      current_repid: AUTONOMOUS_CAP,
      tier: 'AUTONOMOUS',
      updated_at: '2026-05-05T10:00:00.000Z',
    });
    const r = await getRepIDForAgent('sophia');
    expect(r.repid_score).toBe(AUTONOMOUS_CAP);
    expect(r.source).toBe('autonomous_cap');
  });

  test('getRepIDForAgent throws AGENT_NOT_FOUND when row missing', async () => {
    setMaybeSingleResponse(null);
    await expect(getRepIDForAgent('ghost')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  test('getRepIDForAgent throws DATABASE_ERROR on supabase error', async () => {
    setMaybeSingleResponse(null, { message: 'connection refused' });
    await expect(getRepIDForAgent('any')).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
  });

  test('getRepIDForAgent rejects empty agent id', async () => {
    await expect(getRepIDForAgent('')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  test('getRepIDHistory returns ordered events with computed deltas', async () => {
    setHistoryResponse([
      { repid_after: 4500, repid_before: 4400, created_at: '2026-05-05T12:00:00Z', event_type: 'STAKE' },
      { repid_after: 4400, repid_before: 4380, created_at: '2026-05-04T08:00:00Z', event_type: 'PEACEMAKER' },
      { repid_after: 4380, repid_before: null, created_at: '2026-05-01T00:00:00Z', event_type: 'BOOTSTRAP' },
    ]);
    const events = await getRepIDHistory('agent-A');
    expect(events).toHaveLength(3);
    expect(events[0]!.repid_score).toBe(4500);
    expect(events[0]!.delta_from_previous).toBe(100);
    expect(events[0]!.event_type).toBe('STAKE');
    expect(events[1]!.delta_from_previous).toBe(20);
    expect(events[2]!.delta_from_previous).toBeNull(); // null repid_before
  });

  test('getRepIDHistory returns empty array when no events', async () => {
    setHistoryResponse([]);
    const events = await getRepIDHistory('agent-A');
    expect(events).toEqual([]);
  });

  test('getRepIDHistory passes since cursor when supplied', async () => {
    setHistoryResponse([]);
    await getRepIDHistory('agent-A', '2026-05-01');
    // Verify that gte was called with the cursor
    expect(mockedDb.__chain.gte).toHaveBeenCalledWith('created_at', '2026-05-01');
  });

  test('getRepIDHistory ignores malformed since cursor', async () => {
    setHistoryResponse([]);
    await getRepIDHistory('agent-A', 'not-a-date');
    // gte should NOT be called for malformed cursor
    expect(mockedDb.__chain.gte).not.toHaveBeenCalled();
  });

  test('getRepIDHistory throws DATABASE_ERROR on supabase error', async () => {
    setHistoryResponse([], { message: 'timeout' });
    await expect(getRepIDHistory('agent-A')).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
  });
});
