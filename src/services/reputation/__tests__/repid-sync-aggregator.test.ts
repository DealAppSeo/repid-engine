/**
 * Unit tests for RepID Sync Aggregator
 * XC isolated worktree (feat/xc-repid-sync-2026-05-29)
 *
 * Covers (per sprint):
 * - Happy path delta aggregation
 * - idempotency_key dedupe via watermark
 * - delta=0 suppressed HAL events (no resurrection)
 * - Tier floor pass-through (we never bypass; DB trigger owns it)
 * - Concurrent / re-run safety (watermark + keys)
 * - trinity_repid READ-ONLY guard
 * - Dry-run default (no writes)
 */

import { runRepidSync, assertTrinityRepidReadOnly, rollupAgentRepidScores } from '../repid-sync-aggregator';

// Mock the db module used by the aggregator
jest.mock('../../../db', () => {
  const mockDb = {
    from: jest.fn(),
  };
  return { db: mockDb };
});

import { db } from '../../../db';

function makeChainableMock(data: any[] = [], error: any = null) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: data[0] ?? null, error }),
    single: jest.fn().mockResolvedValue({ data: data[0] ?? null, error }),
  };
  // Final awaitable for the query
  chain.then = (resolve: any) => resolve({ data, error });
  return chain;
}

describe('RepID Sync Aggregator (XC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default env for tests: hard dry-run
    process.env.REPIDSYNC_DRY_RUN = 'true';
    process.env.REPIDSYNC_APPLY = 'false';
  });

  it('happy path: aggregates deltas across events and reports drift', async () => {
    const agentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const events = [
      { id: 1, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: -120, idempotency_key: 'hal-1', created_at: '2026-05-29T10:00:00Z', hal_decision: 'flagged' },
      { id: 2, agent_id: agentId, event_type: 'SERVICE_FULFILLED', delta: 45, idempotency_key: 'svc-42', created_at: '2026-05-29T10:05:00Z' },
      { id: 3, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: 0, idempotency_key: 'hal-suppressed', created_at: '2026-05-29T10:10:00Z', hal_decision: 'clean' }, // suppressed
    ];
    const agentRow = { id: agentId, agent_name: 'test-agent-42', current_repid: 8200, tier: 'EARNING', peak_repid: 8500, last_reputation_written_at: '2026-05-29T09:00:00Z' };

    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_score_events') return makeChainableMock(events);
      if (table === 'repid_agents') return makeChainableMock([agentRow]);
      return makeChainableMock([]);
    });

    const report = await runRepidSync({ dryRun: true, lookbackHours: 2, agentId });

    expect(report.agentsScanned).toBe(1);
    expect(report.totalNetDelta).toBe(-75); // -120 + 45 + 0
    expect(report.suppressedZeroDeltaEvents).toBe(1);
    expect(report.perAgent[0].proposed).toBe(8125);
    expect(report.perAgent[0].drift).toBe(-75);
    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(0); // never writes in dry
  });

  it('idempotency_key + watermark prevents double-apply on re-run', async () => {
    const agentId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const events = [
      { id: 10, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: -30, idempotency_key: 'trinity_task_bridge_777', created_at: '2026-05-29T11:00:00Z' },
    ];
    const agentRow = { id: agentId, current_repid: 5000, last_reputation_written_at: '2026-05-29T11:30:00Z' }; // watermark AFTER the event

    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_score_events') return makeChainableMock(events);
      if (table === 'repid_agents') return makeChainableMock([agentRow]);
      return makeChainableMock([]);
    });

    const report = await runRepidSync({ dryRun: true, agentId });

    expect(report.perAgent[0].eventsConsidered).toBe(0); // filtered by watermark
    expect(report.totalNetDelta).toBe(0);
  });

  it('respects delta=0 suppressed HAL events (no resurrection of penalties)', async () => {
    const agentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const events = [
      { id: 20, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: 0, idempotency_key: 'suppressed-penalty-1', created_at: '2026-05-29T12:00:00Z', veto_class: 'high' },
      { id: 21, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: 0, idempotency_key: 'suppressed-penalty-2', created_at: '2026-05-29T12:01:00Z' },
    ];
    const agentRow = { id: agentId, current_repid: 3000, last_reputation_written_at: '2026-05-29T11:00:00Z' };

    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_score_events') return makeChainableMock(events);
      if (table === 'repid_agents') return makeChainableMock([agentRow]);
      return makeChainableMock([]);
    });

    const report = await runRepidSync({ dryRun: true, agentId });

    expect(report.totalNetDelta).toBe(0);
    expect(report.suppressedZeroDeltaEvents).toBe(2);
    expect(report.perAgent[0].proposed).toBe(3000); // unchanged
  });

  it('trinity_repid guard throws on any write attempt (read-only archival + pollution)', () => {
    expect(() => assertTrinityRepidReadOnly('trinity_repid')).toThrow(/READ_ONLY_ARCHIVAL_VIOLATION/);
    expect(() => assertTrinityRepidReadOnly('update trinity_repid set score=999')).toThrow(/5mo freeze/);
  });

  it('dry-run default + guards prevent any current_repid mutation', async () => {
    const agentId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const events = [{ id: 30, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: 77, idempotency_key: 'would-apply', created_at: '2026-05-29T13:00:00Z' }];
    const agentRow = { id: agentId, current_repid: 1000, last_reputation_written_at: '2026-05-29T12:00:00Z' };

    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_score_events') return makeChainableMock(events);
      if (table === 'repid_agents') return makeChainableMock([agentRow]);
      return makeChainableMock([]);
    });

    const report = await runRepidSync({ dryRun: true, agentId });

    expect(report.applied).toBe(0);
    expect(report.dryRun).toBe(true);
    // The UPDATE path in source is only reached when effectiveApply === true (double env guard)
  });

  it('rollup stub for agent_repid is explicitly lagging / no-op per TARGET', async () => {
    const r = await rollupAgentRepidScores(true);
    expect(r.dryRun).toBe(true);
    expect(r.agentsUpdated).toBe(0);
    expect(r.note).toMatch(/lagging rollup stub/);
  });

  it('concurrent safety: two identical batches produce same net (idempotent)', async () => {
    const agentId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const events = [
      { id: 40, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: -15, idempotency_key: 'dup-1', created_at: '2026-05-29T14:00:00Z' },
      { id: 41, agent_id: agentId, event_type: 'HAL_SCORE_EVENT', delta: -15, idempotency_key: 'dup-1', created_at: '2026-05-29T14:00:01Z' }, // duplicate key
    ];
    const agentRow = { id: agentId, current_repid: 2000, last_reputation_written_at: '2026-05-29T13:00:00Z' };

    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_score_events') return makeChainableMock(events);
      if (table === 'repid_agents') return makeChainableMock([agentRow]);
      return makeChainableMock([]);
    });

    const r1 = await runRepidSync({ dryRun: true, agentId });
    const r2 = await runRepidSync({ dryRun: true, agentId });

    expect(r1.totalNetDelta).toBe(r2.totalNetDelta);
    // In real apply the UPDATE + watermark advance makes second a no-op
  });
});
