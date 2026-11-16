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
import { settlementGate } from '../src/workers/feedback-loop-filters';

const REAL_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

/**
 * Minimal supabase-js query-builder stub. `agentRow` is what
 * repid_agents...maybeSingle() resolves to; `priorWrites` is what the
 * idempotency SELECT on erc8004_reputation_writes resolves to.
 */
const CONFIRMED = { status: 'settled', tx_hash: '0x' + 'ab'.repeat(32), is_simulated: false };

function makeDb(agentRow: any, priorWrites: any[] = [], settlement: any = CONFIRMED) {
  return {
    from(table: string) {
      if (table === 'x402_settlements') {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: settlement, error: null }),
        };
        return builder;
      }
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
      if (table === 'repid_events') {
        return { update: () => ({ eq: async () => ({ error: null }) }) };
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
      x402PaymentId: 'pay-1',
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
      x402PaymentId: 'pay-1',
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
      x402PaymentId: 'pay-1',
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
      x402PaymentId: 'pay-1',
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
      x402PaymentId: 'pay-1',
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
      x402PaymentId: 'pay-1',
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

  // Paid first (2026-10-16): the write ran at fulfil time, before /satisfy broadcast the payment —
  // 3 of 16 daily exchanges carried an on-chain RepID write mined before their USDC settled.
  test('does NOT write while the payment is only authorized (not yet settled)', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = { writeRepIDFeedback: jest.fn(), chainId: 84532, getContractAddress: () => '0xabc' };
    (global as any).__triggerDb = makeDb(REAL_AGENT, [], { status: 'authorized', tx_hash: null, is_simulated: false });
    const out = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1' });
    expect(out).toEqual({ attempted: false, reason: 'settlement_pending' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
  });

  test('does NOT write for a voided payment, a settled row with no real tx, or no payment at all', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = { writeRepIDFeedback: jest.fn(), chainId: 84532, getContractAddress: () => '0xabc' };
    for (const row of [{ status: 'voided', tx_hash: null }, { status: 'settled', tx_hash: null }, { status: 'settled', tx_hash: '0xmock' }]) {
      (global as any).__triggerDb = makeDb(REAL_AGENT, [], row);
      const out = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1' });
      expect(out).toEqual({ attempted: false, reason: 'settlement_never' });
    }
    const none = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false });
    expect(none).toEqual({ attempted: false, reason: 'settlement_never' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
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
      x402PaymentId: 'pay-1',
    });
    expect(out).toMatchObject({ attempted: true, ok: false });
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

describe('settlementGate (pure)', () => {
  test.each([
    [{ status: 'settled', tx_hash: '0x' + 'ab'.repeat(32), is_simulated: false }, 'confirmed'],
    [{ status: 'authorized', tx_hash: null }, 'pending'],
    [{ status: 'settling', tx_hash: null }, 'pending'],
    [{ status: 'voided', tx_hash: null }, 'never'],
    [{ status: 'settled', tx_hash: null }, 'never'],
    [{ status: 'settled', tx_hash: '0xmock' + 'a'.repeat(60) }, 'never'],
    [{ status: 'settled', tx_hash: '0x' + 'ab'.repeat(32), is_simulated: true }, 'never'],
    [null, 'never'],
  ])('%j → %s', (row, want) => {
    expect(settlementGate(row as never)).toBe(want);
  });
});

// R1 (2026-11-16): one RepID event, one on-chain write, linked to its contract.
// MEASURED: on 2026-07-08, repid_events row 1564 got TWO on-chain writes 4 s apart. One came from
// this inline trigger (no contract_id, so no receipt could link it); the other came from
// FeedbackLoopWorker, because the inline path never closed the outbox row it had already written.
describe('one event, one write, linked to its contract (R1)', () => {
  function recordingDb(prior: { contract_id?: string; repid_event_id?: number }[] = [], priorErr: { message: string } | null = null) {
    const updates: { table: string; patch: any; id: unknown }[] = [];
    const base = makeDb(REAL_AGENT);
    return {
      updates,
      from(table: string) {
        if (table === 'erc8004_reputation_writes') {
          const filters: Record<string, unknown> = {};
          const b: any = {
            select: () => b,
            eq: (col: string, val: unknown) => { filters[col] = val; return b; },
            limit: async () => (priorErr ? { data: null, error: priorErr } : {
              data: prior.filter((p) =>
                Object.entries(filters).every(([k, v]) => k === 'agent_id' || (p as any)[k] === v)),
              error: null,
            }),
          };
          return b;
        }
        if (table === 'repid_events') {
          return { update: (patch: any) => ({ eq: async (_c: string, id: unknown) => { updates.push({ table, patch, id }); return { error: null }; } }) };
        }
        return base.from(table);
      },
    };
  }
  const okWriter = () => ({
    writeRepIDFeedback: jest.fn().mockResolvedValue({ txHash: '0xbeef', blockNumber: 1, gasUsed: '1' }),
    chainId: 84532,
    getContractAddress: () => '0xabc',
  });

  test('the persisted row carries the contract, so a receipt can prove which exchange caused it', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = okWriter();
    (global as any).__triggerDb = recordingDb();
    await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1', repidEventId: 55 });
    expect(persistSpy.mock.calls[0][1]).toMatchObject({ contract_id: 'c-1', repid_event_id: 55 });
  });

  test('a successful write closes its outbox row, so FeedbackLoopWorker does not write the same event again', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = okWriter();
    const fake = recordingDb();
    (global as any).__triggerDb = fake;
    await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1', repidEventId: 55 });
    const closed = fake.updates.find((u) => u.id === 55);
    expect(closed?.patch.processed_at).toEqual(expect.any(String));
  });

  test('a prior write for the same (agent, contract) blocks a second one, even with no event id', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = okWriter();
    (global as any).__triggerDb = recordingDb([{ contract_id: 'c-1', repid_event_id: 7 }]);
    const out = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1' });
    expect(out).toEqual({ attempted: false, reason: 'already_written' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
  });

  test('an unreadable prior-write check writes nothing and leaves the outbox row open (Grok r1)', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = okWriter();
    const fake = recordingDb([], { message: 'connection reset' });
    (global as any).__triggerDb = fake;
    const out = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1', repidEventId: 55 });
    expect(out).toEqual({ attempted: false, reason: 'prior_write_unreadable' });
    expect(mockWriter.writeRepIDFeedback).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
    expect(fake.updates).toHaveLength(0);
  });

  test('a prior write for a DIFFERENT contract does not block this one', async () => {
    process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED = 'true';
    mockWriter = okWriter();
    (global as any).__triggerDb = recordingDb([{ contract_id: 'c-other', repid_event_id: 7 }]);
    const out = await maybeWriteOnChainReputation({ contractId: 'c-1', providerAgentId: REAL_UUID, isSimulated: false, x402PaymentId: 'pay-1' });
    expect(out).toMatchObject({ attempted: true, ok: true });
  });
});
