import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeatTier } from '../../src/memory/memory-heat';
import { writeHeatTiers } from '../../src/memory/memory-heat-tier-writer';

/** Build a minimal Supabase mock that intercepts .from().update().eq().eq().in().select(). */
function makeDb(returnValue: { error: null | { message: string }; data: Array<{ id: string }> | null }): SupabaseClient {
  const chain = {
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(returnValue),
  };
  return { from: jest.fn().mockReturnValue(chain) } as unknown as SupabaseClient;
}

describe('writeHeatTiers', () => {
  it('empty map → no-op, returns 0', async () => {
    const db = makeDb({ error: null, data: [] });
    const result = await writeHeatTiers(db, 'agent-1', new Map());
    expect(result).toBe(0);
    expect((db.from as jest.Mock)).not.toHaveBeenCalled();
  });

  it('single leaf → calls update with correct tier and returns 1', async () => {
    const db = makeDb({ error: null, data: [{ id: 'leaf-1' }] });
    const tiers: Map<string, HeatTier> = new Map([['leaf-1', 'hot']]);
    const result = await writeHeatTiers(db, 'agent-2', tiers);
    expect(result).toBe(1);
    const fromMock = db.from as jest.Mock;
    expect(fromMock).toHaveBeenCalledWith('agent_memory_leaves');
    // chain: update({ heat_tier: 'hot' }) → .eq('agent_id') → .eq('tombstoned') → .in('id') → .select
    const chain = fromMock.mock.results[0]!.value as ReturnType<typeof makeDb>['from'] & {
      update: jest.Mock;
      eq: jest.Mock;
      in: jest.Mock;
    };
    expect(chain.update).toHaveBeenCalledWith({ heat_tier: 'hot' });
    expect(chain.eq).toHaveBeenCalledWith('agent_id', 'agent-2');
    expect(chain.eq).toHaveBeenCalledWith('tombstoned', false);
    expect(chain.in).toHaveBeenCalledWith('id', ['leaf-1']);
  });

  it('multiple leaves same tier → one UPDATE call', async () => {
    const db = makeDb({ error: null, data: [{ id: 'a' }, { id: 'b' }] });
    const tiers: Map<string, HeatTier> = new Map([['a', 'warm'], ['b', 'warm']]);
    const result = await writeHeatTiers(db, 'agent-3', tiers);
    expect(result).toBe(2);
    expect((db.from as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('multiple leaves different tiers → one UPDATE per tier group', async () => {
    let callCount = 0;
    const dataBatches: Array<Array<{ id: string }>> = [[{ id: 'hot-leaf' }], [{ id: 'cold-leaf' }]];
    const chain = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      select: jest.fn().mockImplementation(() => {
        const batch = dataBatches[callCount++];
        return Promise.resolve({ error: null, data: batch ?? [] });
      }),
    };
    const db = { from: jest.fn().mockReturnValue(chain) } as unknown as SupabaseClient;

    const tiers: Map<string, HeatTier> = new Map([['hot-leaf', 'hot'], ['cold-leaf', 'cold']]);
    const result = await writeHeatTiers(db, 'agent-4', tiers);
    expect(result).toBe(2);
    expect(chain.update).toHaveBeenCalledTimes(2);
  });

  it('tombstoned leaves excluded — .eq("tombstoned", false) always applied', async () => {
    const db = makeDb({ error: null, data: [] });
    const tiers: Map<string, HeatTier> = new Map([['leaf-x', 'cold']]);
    await writeHeatTiers(db, 'agent-5', tiers);
    const chain = (db.from as jest.Mock).mock.results[0]!.value as { eq: jest.Mock };
    expect(chain.eq).toHaveBeenCalledWith('tombstoned', false);
  });

  it('DB error → throws with tier label', async () => {
    const db = makeDb({ error: { message: 'connection refused' }, data: null });
    const tiers: Map<string, HeatTier> = new Map([['leaf-y', 'warm']]);
    await expect(writeHeatTiers(db, 'agent-6', tiers)).rejects.toThrow('update failed for tier warm');
  });

  it('returns rows affected count from data array length', async () => {
    const db = makeDb({ error: null, data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const tiers: Map<string, HeatTier> = new Map([['a', 'on_chain'], ['b', 'on_chain'], ['c', 'on_chain']]);
    const result = await writeHeatTiers(db, 'agent-7', tiers);
    expect(result).toBe(3);
  });
});
