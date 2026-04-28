/**
 * onchain-oracle.ts — Base Sepolia block-hash oracle tests.
 *
 * Mocks ethers.JsonRpcProvider.getBlock to verify:
 *   - happy path returns oracle_source: 'onchain_blockhash'
 *   - outcome derives deterministically from lastByte(block.hash) mod 2
 *   - basescan_url contains the block number
 *   - RPC error → oracle_source: 'fallback_hmac' (no throw)
 *   - malformed block (no hash) → 'fallback_hmac'
 *   - timeout → 'fallback_hmac'
 *
 * Plus a roundtrip test for deriveAndSignOracleOutcome via
 * linked-bet-resolver.
 */

const ORIG_RPC = process.env.BASE_SEPOLIA_RPC_URL;
afterAll(() => {
  if (ORIG_RPC === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
  else process.env.BASE_SEPOLIA_RPC_URL = ORIG_RPC;
});

let mockGetBlock: jest.Mock;
let mockDestroy: jest.Mock;

beforeEach(() => {
  jest.resetModules();
  mockGetBlock = jest.fn();
  mockDestroy = jest.fn();
  process.env.BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
  jest.doMock('ethers', () => {
    const actual = jest.requireActual('ethers');
    class MockProvider {
      constructor(_url: string) {}
      getBlock = mockGetBlock;
      destroy = mockDestroy;
    }
    return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider: MockProvider }, JsonRpcProvider: MockProvider };
  });
});

describe('onchain-oracle — deriveOutcomeFromChain', () => {
  it('returns oracle_source=onchain_blockhash with deterministic outcome', async () => {
    // hash ends in 0x..A4 → 0xA4 = 164 → 164 % 2 = 0
    // 64 hex chars total: 8 ('deadbeef') + 54 (27 reps of '00') + 2 ('a4')
    mockGetBlock.mockResolvedValue({ number: 21500000, hash: '0xdeadbeef' + '00'.repeat(27) + 'a4' });
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const r = await deriveOutcomeFromChain('seed-1');
    expect(r.oracle_source).toBe('onchain_blockhash');
    expect(r.outcome).toBe(0);
    expect(r.block_number).toBe(21500000);
    expect(r.block_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(r.basescan_url).toBe('https://sepolia.basescan.org/block/21500000');
  });

  it('lastByte odd → outcome 1', async () => {
    // 0xA5 = 165 → 165 % 2 = 1
    // 64 hex chars: 4 ('feed') + 58 (29 reps of '00') + 2 ('a5')
    mockGetBlock.mockResolvedValue({ number: 21500001, hash: '0xfeed' + '00'.repeat(29) + 'a5' });
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const r = await deriveOutcomeFromChain('seed-2');
    expect(r.outcome).toBe(1);
  });

  it('falls back to HMAC on RPC error (no throw)', async () => {
    mockGetBlock.mockRejectedValue(new Error('connection refused'));
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const r = await deriveOutcomeFromChain('bet-abc');
    expect(r.oracle_source).toBe('fallback_hmac');
    expect(r.outcome === 0 || r.outcome === 1).toBe(true);
    expect(r.block_number).toBe(0);
    expect(r.basescan_url).toBe('');
    expect(r.notes).toMatch(/fallback_hmac/);
  });

  it('falls back on malformed block (missing hash)', async () => {
    mockGetBlock.mockResolvedValue({ number: 1, hash: null });
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const r = await deriveOutcomeFromChain('bet-xyz');
    expect(r.oracle_source).toBe('fallback_hmac');
  });

  it('falls back on timeout', async () => {
    mockGetBlock.mockImplementation(() => new Promise(() => {}));   // hangs forever
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const before = Date.now();
    const r = await deriveOutcomeFromChain('bet-timeout');
    const elapsed = Date.now() - before;
    expect(r.oracle_source).toBe('fallback_hmac');
    expect(elapsed).toBeLessThan(7000);                              // 5s timeout + slack
  }, 10000);

  it('HMAC fallback is deterministic per seed', async () => {
    mockGetBlock.mockRejectedValue(new Error('boom'));
    const { deriveOutcomeFromChain } = require('../src/services/onchain-oracle');
    const a = await deriveOutcomeFromChain('seed-x');
    const b = await deriveOutcomeFromChain('seed-x');
    expect(a.outcome).toBe(b.outcome);
    expect(a.block_hash).toBe(b.block_hash);
  });
});

describe('linked-bet-resolver — deriveAndSignOracleOutcome', () => {
  it('roundtrips: outcome + signature + oracle_source from chain', async () => {
    mockGetBlock.mockResolvedValue({ number: 99, hash: '0x' + 'ab'.repeat(32) });
    const { deriveAndSignOracleOutcome, verifyOracleSignature } = require('../src/services/linked-bet-resolver');
    const r = await deriveAndSignOracleOutcome('bet_xyz_1');
    expect(r.oracle_source).toBe('onchain_blockhash');
    expect(typeof r.outcome).toBe('boolean');
    expect(verifyOracleSignature('bet_xyz_1', r.outcome, r.signature)).toBe(true);
    expect(r.block_number).toBe(99);
  });

  it('falls back to HMAC oracle when RPC fails (signature still verifies)', async () => {
    mockGetBlock.mockRejectedValue(new Error('rpc down'));
    const { deriveAndSignOracleOutcome, verifyOracleSignature } = require('../src/services/linked-bet-resolver');
    const r = await deriveAndSignOracleOutcome('bet_fallback_1');
    expect(r.oracle_source).toBe('fallback_hmac');
    expect(verifyOracleSignature('bet_fallback_1', r.outcome, r.signature)).toBe(true);
  });
});
