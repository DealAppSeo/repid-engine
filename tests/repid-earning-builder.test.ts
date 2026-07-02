/**
 * Builder-RepID feedback (Task 6) — recomputeBuilderRepIdForAgent.
 *
 * Mocks db (agent lookup) and builder-registry.recomputeBuilderRepID. Verifies:
 *   - no builder_id → { updated: false, reason: 'no_builder' } (non-blocking)
 *   - builder present → delegates to recomputeBuilderRepID and returns its result
 *   - agent lookup error → { updated: false } (never throws)
 */

(global as any).__agentRow = null;
(global as any).__agentErr = null;
(global as any).__recomputeCalledWith = null;

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: (global as any).__agentRow, error: (global as any).__agentErr }),
      };
      return chain;
    },
  },
}));

jest.mock('../src/services/builder-registry', () => ({
  recomputeBuilderRepID: async (builderId: string) => {
    (global as any).__recomputeCalledWith = builderId;
    return { builder_id: builderId, builder_repid: 4200, active_count: 3, ghost_count: 0, mean_active_repid: 4200 };
  },
}));

import { recomputeBuilderRepIdForAgent } from '../src/services/repid-earning';

beforeEach(() => {
  (global as any).__agentRow = null;
  (global as any).__agentErr = null;
  (global as any).__recomputeCalledWith = null;
});

describe('recomputeBuilderRepIdForAgent (Task 6)', () => {
  it('returns updated=false with no_builder when the agent has no builder_id', async () => {
    (global as any).__agentRow = { builder_id: null };
    const r = await recomputeBuilderRepIdForAgent('agent-1');
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('no_builder');
    expect((global as any).__recomputeCalledWith).toBeNull();
  });

  it('delegates to recomputeBuilderRepID and returns the builder repid when a builder exists', async () => {
    (global as any).__agentRow = { builder_id: 'builder-9' };
    const r = await recomputeBuilderRepIdForAgent('agent-1');
    expect(r.updated).toBe(true);
    expect(r.builder_id).toBe('builder-9');
    expect(r.builder_repid).toBe(4200);
    expect((global as any).__recomputeCalledWith).toBe('builder-9');
  });

  it('is non-blocking: an agent lookup error returns updated=false, never throws', async () => {
    (global as any).__agentRow = null;
    (global as any).__agentErr = { message: 'db down' };
    const r = await recomputeBuilderRepIdForAgent('agent-1');
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/agent_lookup_failed/);
  });
});
