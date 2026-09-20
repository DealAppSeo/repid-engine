import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeatEvictionReport } from '../../src/memory/memory-heat-sweep';
import { logHeatSweepShadow } from '../../src/memory/memory-heat-shadow';

const mockSupabase = {} as SupabaseClient;

const baseReport: HeatEvictionReport = {
  hot: [],
  warm: [],
  cold: [],
  onChain: [],
  evictionCandidates: [],
  reactivationCandidates: [],
  stats: { total: 0, hotCount: 0, warmCount: 0, coldCount: 0, onChainCount: 0 },
};

function makeSweepFn(report: HeatEvictionReport) {
  return jest.fn().mockResolvedValue(report);
}

describe('logHeatSweepShadow', () => {
  const originalEnv = process.env['HEAT_EVICTION_SHADOW_ENABLED'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['HEAT_EVICTION_SHADOW_ENABLED'];
    else process.env['HEAT_EVICTION_SHADOW_ENABLED'] = originalEnv;
    jest.restoreAllMocks();
  });

  it('flag off → no-op, sweep not called', async () => {
    delete process.env['HEAT_EVICTION_SHADOW_ENABLED'];
    const sweepFn = makeSweepFn(baseReport);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await logHeatSweepShadow(mockSupabase, 'agent-1', undefined, sweepFn);
    expect(sweepFn).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('flag on → sweep called and summary logged', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const report: HeatEvictionReport = {
      ...baseReport,
      evictionCandidates: [{ id: 'x', tier: 'cold', heat: 0.1, lastAccessedMs: Date.now(), accessCount: 1, isAnchored: false }],
      reactivationCandidates: [],
      stats: { total: 3, hotCount: 1, warmCount: 1, coldCount: 1, onChainCount: 0 },
    };
    const sweepFn = makeSweepFn(report);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await logHeatSweepShadow(mockSupabase, 'trinity-sophia', undefined, sweepFn);
    expect(sweepFn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('[HEAT-EVICTION-SHADOW]');
    expect(msg).toContain('trinity-sophia');
    expect(msg).toContain('hot=1');
    expect(msg).toContain('evict=1');
  });

  it('agentId is forwarded to sweepFn', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const sweepFn = makeSweepFn(baseReport);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await logHeatSweepShadow(mockSupabase, 'trinity-nexus', undefined, sweepFn);
    expect(sweepFn).toHaveBeenCalledWith(mockSupabase, 'trinity-nexus', undefined);
  });

  it('opts forwarded to sweepFn', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const sweepFn = makeSweepFn(baseReport);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const opts = { evictionLimit: 5 };
    await logHeatSweepShadow(mockSupabase, 'agent-2', opts, sweepFn);
    expect(sweepFn).toHaveBeenCalledWith(mockSupabase, 'agent-2', opts);
  });

  it('sweep error → console.warn, does not throw', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const sweepFn = jest.fn().mockRejectedValue(new Error('DB down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(logHeatSweepShadow(mockSupabase, 'agent-3', undefined, sweepFn)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[HEAT-EVICTION-SHADOW]'), expect.any(Error));
  });

  it('supabase is forwarded to sweepFn', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const specificDb = { from: jest.fn() } as unknown as SupabaseClient;
    const sweepFn = makeSweepFn(baseReport);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await logHeatSweepShadow(specificDb, 'agent-4', undefined, sweepFn);
    expect(sweepFn).toHaveBeenCalledWith(specificDb, 'agent-4', undefined);
  });

  it('returns undefined (fire-and-forget compatible)', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const sweepFn = makeSweepFn(baseReport);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await logHeatSweepShadow(mockSupabase, 'agent-5', undefined, sweepFn);
    expect(result).toBeUndefined();
  });

  it('log line contains all required fields: hot/warm/cold/on_chain/evict/reactivate', async () => {
    process.env['HEAT_EVICTION_SHADOW_ENABLED'] = 'true';
    const report: HeatEvictionReport = {
      ...baseReport,
      reactivationCandidates: [{ id: 'y', tier: 'cold', heat: 0.28, lastAccessedMs: Date.now(), accessCount: 2, isAnchored: false }],
      stats: { total: 6, hotCount: 2, warmCount: 1, coldCount: 2, onChainCount: 1 },
    };
    const sweepFn = makeSweepFn(report);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await logHeatSweepShadow(mockSupabase, 'agent-6', undefined, sweepFn);
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/hot=\d+/);
    expect(msg).toMatch(/warm=\d+/);
    expect(msg).toMatch(/cold=\d+/);
    expect(msg).toMatch(/on_chain=\d+/);
    expect(msg).toMatch(/evict=\d+/);
    expect(msg).toMatch(/reactivate=\d+/);
  });
});
