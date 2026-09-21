// Proves the cb_disable_onchain_writes circuit breaker actually blocks the
// on-chain reputation write, in BOTH directions, without touching a chain.
//
// Before this guard the flag was inert: it read `true` in repid_config while
// giveFeedback txs kept landing. The guard lives at writeRepIDFeedback() — the
// single chokepoint every RepID reputation write routes through — so this test
// exercises the real skip-vs-proceed decision, with the ethers contract stubbed.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

// Control the breaker verdict per-test.
jest.mock('../src/middleware/circuit-breaker', () => ({
  assertBreakerClosed: jest.fn(),
}));

import { ethers } from 'ethers';
import { assertBreakerClosed } from '../src/middleware/circuit-breaker';
import { Erc8004ReputationWriter } from '../src/services/erc8004-reputation';

const assertMock = assertBreakerClosed as jest.MockedFunction<typeof assertBreakerClosed>;

// Ephemeral throwaway key generated at runtime — no key-shaped literal in this
// PUBLIC repo. Never funded; the contract is stubbed so it never signs anything.
const TEST_KEY = ethers.Wallet.createRandom().privateKey;

function makeWriter(chainId = 84532) {
  const writer = new Erc8004ReputationWriter({
    provider: {} as any, // Wallet only stores it; the contract is stubbed below.
    privateKey: TEST_KEY,
    contractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    chainId,
  });
  const giveFeedback = jest.fn().mockResolvedValue({
    hash: '0xdeadbeef',
    wait: async () => ({ status: 1, hash: '0xdeadbeef', blockNumber: 123, gasUsed: { toString: () => '21000' } }),
  });
  (writer as any).contract = { giveFeedback };
  return { writer, giveFeedback };
}

const ARGS = { agentTokenId: '7', repid: 2177, tier: 'ESTABLISHED' };

describe('cb_disable_onchain_writes guard on writeRepIDFeedback', () => {
  beforeEach(() => {
    assertMock.mockReset();
    delete process.env.NODE_ENV; // NODE_ENV==='test' short-circuits writeRepIDCanonical, not this method
  });

  it('BLOCKS the on-chain write when the breaker is tripped (fail-closed)', async () => {
    assertMock.mockRejectedValue(new Error('circuit_breaker_open: cb_disable_onchain_writes — action refused (fail-closed).'));
    const { writer, giveFeedback } = makeWriter();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(writer.writeRepIDFeedback(ARGS)).rejects.toThrow(/circuit_breaker_open/);
    expect(giveFeedback).not.toHaveBeenCalled(); // no tx attempted
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped_write'));

    warn.mockRestore();
  });

  it('PROCEEDS with the write when the breaker is closed', async () => {
    assertMock.mockResolvedValue(undefined);
    const { writer, giveFeedback } = makeWriter();

    const result = await writer.writeRepIDFeedback(ARGS);
    expect(assertMock).toHaveBeenCalledWith('cb_disable_onchain_writes');
    expect(giveFeedback).toHaveBeenCalledTimes(1); // tx fired
    expect(result.txHash).toBe('0xdeadbeef');
  });
});

// Audit 2606.26028 — the two cheap pre-write guards. Breaker mocked to PASS so
// execution reaches them.
describe('on-chain write guards (audit 2606.26028)', () => {
  beforeEach(() => {
    assertMock.mockReset();
    assertMock.mockResolvedValue(undefined); // breaker closed → reach the guards below
    delete process.env.ALLOW_MAINNET_REPUTATION_WRITES;
    delete process.env.NODE_ENV;
  });

  it('#10 REFUSES a mainnet write (chainId != 84532) without the override flag', async () => {
    const { writer, giveFeedback } = makeWriter(8453); // Base mainnet
    await expect(writer.writeRepIDFeedback(ARGS)).rejects.toThrow(/mainnet reputation writes are disabled/);
    expect(giveFeedback).not.toHaveBeenCalled();
  });

  it('#10 allows a mainnet write when ALLOW_MAINNET_REPUTATION_WRITES=true', async () => {
    process.env.ALLOW_MAINNET_REPUTATION_WRITES = 'true';
    const { writer, giveFeedback } = makeWriter(8453);
    const result = await writer.writeRepIDFeedback(ARGS);
    expect(giveFeedback).toHaveBeenCalledTimes(1);
    expect(result.txHash).toBe('0xdeadbeef');
  });

  it('#2 REFUSES a value outside [10,10000]', async () => {
    const { writer, giveFeedback } = makeWriter(); // Sepolia — passes the mainnet guard
    await expect(writer.writeRepIDFeedback({ ...ARGS, repid: 99999 })).rejects.toThrow(/value out of range/);
    await expect(writer.writeRepIDFeedback({ ...ARGS, repid: 5 })).rejects.toThrow(/value out of range/);
    await expect(writer.writeRepIDFeedback({ ...ARGS, repid: 1000.5 })).rejects.toThrow(/value out of range/);
    expect(giveFeedback).not.toHaveBeenCalled();
  });

  it('#2 allows an in-range value', async () => {
    const { writer, giveFeedback } = makeWriter();
    const result = await writer.writeRepIDFeedback({ ...ARGS, repid: 10000 });
    expect(giveFeedback).toHaveBeenCalledTimes(1);
    expect(result.txHash).toBe('0xdeadbeef');
  });
});
