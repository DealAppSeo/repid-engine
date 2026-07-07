/**
 * Buy-loop last mile (2026-07-06) — unit tests for maybeWriteOnChainReputation.
 *
 * The trigger MUST:
 *   - do nothing when the feature flag is off (ships OFF),
 *   - NOT write on-chain for a simulated settlement (is_simulated=true),
 *   - NOT write when the agent has no erc8004_token_id or is below the floor,
 *   - be idempotent (skip when an erc8004_reputation_writes row already exists),
 *   - NOT throw / NOT call the writer when key resolution returns null,
 *   - and only on a clean, real, eligible path invoke the writer + persist.
 *
 * db is mocked via a call-time global handle (no jest hoist/TDZ). The ERC-8004
 * writer factory is mocked so no real chain/env is touched.
 */

// --- mocks (must precede the SUT import) ---
jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__triggerDb;
  },
}));

let mockWriter: any = null;
const persistSpy = jest.fn();
jest.mock('../src/services/erc8004-reputation', () => ({
  getReputationWriter: () => mockWriter,
  persistReputationWrite: (...args: any[]) => persistSpy(...args),
}));

import { maybeWriteOnChainReputation } from '../src/services/onchain-reputation-trigger';

const REAL_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

/**
 * Minimal supabase-js query-builder stub. `agentRow` is what
 * repid_agents...maybeSingle() resolves to; `priorWrites` is what the
 * idempotency SELECT on erc8004_reputation_writes resolves to.
 */
function makeDb(agentRow: any, priorWrites: any[] = []) {
  return {
    from(table: string) {
      if (table === 'repid_agents') {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: agentRow, error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
        return builder;
      }
      if (table === 'erc8004_reputation_writes') {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          limit: async () => ({ data: priorWrites, error: null }),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const REAL_AGENT = {
  id: REAL_UUID,
  agent_name: 'shofet',
  current_repid: 1200,
  tier: 'ESTABLISHED',
  erc8004_token_id: '42',
};

beforeEach(() => {
  persistSpy.mockReset();
  mockWriter = null;
  delete process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED;
  (global as any).__triggerDb = makeDb(REAL_AGENT);
});

describe('maybeWriteOnChainReputation gating', () => {
  test('does nothing when the feature flag is off', async () => {
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
    });
    expect(out).toEqual({ attempted: false, reason: 'disabled' });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  test('does NOT write on-chain for a simulated settlement', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = { writeRepIDFeedback: jest.fn() };
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: true,
    });
    expect(out).toEqual({ attempted: false, reason: 'simulated' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  test('skips when agent has no erc8004_token_id', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    (global as any).__triggerDb = makeDb({ ...REAL_AGENT, erc8004_token_id: null });
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
    });
    expect(out).toEqual({ attempted: false, reason: 'no_token_id' });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  test('skips when agent is below the Established floor', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    (global as any).__triggerDb = makeDb({ ...REAL_AGENT, current_repid: 500 });
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
    });
    expect(out).toEqual({ attempted: false, reason: 'below_floor' });
  });

  test('is idempotent — skips when a prior write exists for the event', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = { writeRepIDFeedback: jest.fn() };
    (global as any).__triggerDb = makeDb(REAL_AGENT, [{ id: 7, tx_hash: '0xdead' }]);
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
      repidEventId: 99,
    });
    expect(out).toEqual({ attempted: false, reason: 'already_written' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
  });

  test('degrades loudly (no throw, no write) when no signing key is set', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = null; // getReputationWriter() returns null == no key
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
    });
    expect(out).toEqual({ attempted: false, reason: 'no_writer' });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  test('writes on-chain + persists on the clean real eligible path', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    const writeSpy = jest.fn().mockResolvedValue({
      txHash: '0xbeef',
      blockNumber: 123,
      gasUsed: '21000',
    });
    mockWriter = {
      writeRepIDFeedback: writeSpy,
      chainId: 84532,
      getContractAddress: () => '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    };
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
      repidEventId: 55,
    });
    expect(out).toEqual({ attempted: true, ok: true, txHash: '0xbeef' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({
      agentTokenId: '42',
      repid: 1200,
      tier: 'ESTABLISHED',
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const persistArgs = persistSpy.mock.calls[0][1];
    expect(persistArgs).toMatchObject({
      agent_id: REAL_UUID,
      agent_token_id: '42',
      repid_value: 1200,
      tx_hash: '0xbeef',
      block_number: 123,
      gas_used: 21000,
      chain_id: 84532,
      repid_event_id: 55,
    });
  });

  test('is non-fatal when the on-chain write throws', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = {
      writeRepIDFeedback: jest.fn().mockRejectedValue(new Error('rpc exploded')),
      chainId: 84532,
      getContractAddress: () => '0xabc',
    };
    const out = await maybeWriteOnChainReputation({
      contractId: 'c-1',
      providerAgentId: REAL_UUID,
      isSimulated: false,
    });
    expect(out).toMatchObject({ attempted: true, ok: false });
    expect(persistSpy).not.toHaveBeenCalled();
  });
});
