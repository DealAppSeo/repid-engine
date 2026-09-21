/**
 * Tests for src/memory/memory-leaf-access.ts — fire-and-forget access tracking.
 *
 * All tests inject a mock Supabase client; no DB or RPC is called.
 * The module under test is pure async (no global state).
 */
import { recordLeafAccess } from '../../src/memory/memory-leaf-access';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeClient(rpcResult: { data?: unknown; error?: { message: string } | null }): SupabaseClient {
  return {
    rpc: jest.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient;
}

describe('recordLeafAccess', () => {
  it('returns 0 when rpc reports 0 rows affected', async () => {
    const client = makeClient({ data: 0, error: null });
    const result = await recordLeafAccess(client, 'agent-uuid-1');
    expect(result).toBe(0);
    expect((client.rpc as jest.Mock)).toHaveBeenCalledWith('record_leaf_access', { p_agent_id: 'agent-uuid-1' });
  });

  it('returns positive row count on success', async () => {
    const client = makeClient({ data: 5, error: null });
    const result = await recordLeafAccess(client, 'agent-uuid-2');
    expect(result).toBe(5);
  });

  it('passes the agentId to the rpc correctly', async () => {
    const client = makeClient({ data: 2, error: null });
    await recordLeafAccess(client, 'test-agent-id');
    expect((client.rpc as jest.Mock)).toHaveBeenCalledWith('record_leaf_access', { p_agent_id: 'test-agent-id' });
  });

  it('returns -1 and logs warning on rpc error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({ data: null, error: { message: 'connection refused' } });
    const result = await recordLeafAccess(client, 'agent-uuid-3');
    expect(result).toBe(-1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[MEMORY-LEAF-ACCESS]'), expect.any(String));
    warnSpy.mockRestore();
  });

  it('returns -1 and logs warning when rpc throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { rpc: jest.fn().mockRejectedValue(new Error('network timeout')) } as unknown as SupabaseClient;
    const result = await recordLeafAccess(client, 'agent-uuid-4');
    expect(result).toBe(-1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[MEMORY-LEAF-ACCESS]'), expect.any(String));
    warnSpy.mockRestore();
  });

  it('returns -1 when rpc returns non-numeric data', async () => {
    const client = makeClient({ data: 'unexpected', error: null });
    const result = await recordLeafAccess(client, 'agent-uuid-5');
    expect(result).toBe(-1);
  });

  it('calls rpc with the correct function name (regression: wrong function name silently no-ops)', async () => {
    const client = makeClient({ data: 3, error: null });
    await recordLeafAccess(client, 'any-agent');
    const [[fnName]] = (client.rpc as jest.Mock).mock.calls;
    expect(fnName).toBe('record_leaf_access');
  });
});
