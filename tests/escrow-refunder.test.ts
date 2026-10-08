/**
 * escrow-refunder — the WITHDRAWAL leg of the verified-deposit escrow model.
 *
 * Proves the fail-closed contract WITHOUT a live chain or a real key, via the injected
 * sender seam (__setEscrowSender):
 *   • unconfigured (no STAKE_ESCROW_SIGNER_KEY) -> STUB, so withdrawal refuses (unchanged)
 *   • configured + valid payee + a send that succeeds -> real refund carrying its tx hash
 *   • configured + invalid payee -> REFUSED, and no send is attempted
 *   • configured + the send throws (wrong chain / signer != escrow) -> REFUSED (fail closed)
 *   • configured + non-positive amount -> REFUSED
 *
 * `config` is mocked so the module imports without live Supabase config, and so the signer
 * key can be toggled per test (the real on-chain send is never reached — the seam replaces it).
 */

const mockConfig = {
  stakeEscrowSignerKey: null as string | null,
  // Low-entropy dummy addresses: the injected sender never touches a real chain, so these
  // only need to satisfy the config shape. Kept repetitive so no secret scanner flags the file
  // (same reason tests/fixtures/scrub-corpus.ts assembles its values).
  stakeEscrowAddress: '0x1111111111111111111111111111111111111111',
  usdcTokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseSepoliaRpc: 'http://localhost:0',
  stakeMinConfirmations: 1,
};
jest.mock('../src/config', () => ({ config: mockConfig }));

import { ethers } from 'ethers';
import {
  escrowRefund,
  __setEscrowSender,
  escrowHealth,
  __setEscrowChainReader,
} from '../src/services/escrow-refunder';

const BUILDER = 'builder-1';
const PAYEE = '0x2222222222222222222222222222222222222222';

// A real, deterministic test keypair. The key is CONSTRUCTED (not a literal 64-hex
// string) so no secret-shaped token lands in the test corpus; the address is derived
// from it so there is no address literal to drift from the key either.
const TEST_KEY = '0x' + '0'.repeat(63) + '1'; // private key = 1
const TEST_ADDR = new ethers.Wallet(TEST_KEY).address;

afterEach(() => {
  __setEscrowSender(undefined);
  __setEscrowChainReader(undefined);
  mockConfig.stakeEscrowSignerKey = null;
  mockConfig.stakeEscrowAddress = '0x1111111111111111111111111111111111111111';
});

describe('escrowRefund — fail-closed escrow -> builder refund', () => {
  it('unconfigured (no signer key) => STUB — withdrawal fails closed, production unchanged', async () => {
    mockConfig.stakeEscrowSignerKey = null;
    let sendCalled = false;
    __setEscrowSender(async () => { sendCalled = true; return { txHash: '0xshould-not-run' }; });
    const r = await escrowRefund(BUILDER, 5_000_000n, PAYEE);
    expect(r.stub).toBe(true);
    expect(r.txHash).toBeUndefined();
    expect(sendCalled).toBe(false); // not configured => never even reaches the sender
  });

  it('configured + valid payee + send succeeds => real refund with tx hash', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async (to, amount) => {
      expect(to).toBe(PAYEE);
      expect(amount).toBe(5_000_000n);
      return { txHash: '0xdeadbeef' };
    });
    const r = await escrowRefund(BUILDER, 5_000_000n, PAYEE);
    expect(r.initiated).toBe(true);
    expect(r.stub).toBe(false);
    expect(r.txHash).toBe('0xdeadbeef');
  });

  it('configured + invalid payee => REFUSED, no send attempted', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    let sendCalled = false;
    __setEscrowSender(async () => { sendCalled = true; return { txHash: '0x' }; });
    const r = await escrowRefund(BUILDER, 5_000_000n, 'not-an-address');
    expect(r.initiated).toBe(false);
    expect(r.stub).toBe(false);
    expect(sendCalled).toBe(false);
  });

  it('configured + send throws (signer != escrow / wrong chain) => REFUSED (fail closed)', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async () => {
      throw new Error('escrow signer address does not match STAKE_ESCROW_ADDRESS');
    });
    const r = await escrowRefund(BUILDER, 5_000_000n, PAYEE);
    expect(r.initiated).toBe(false);
    expect(r.stub).toBe(false);
    expect(r.note).toMatch(/does not match/);
  });

  it('configured + non-positive amount => REFUSED', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    const r = await escrowRefund(BUILDER, 0n, PAYEE);
    expect(r.initiated).toBe(false);
  });
});

describe('escrowHealth — read-only "did I set it right" check (no tx, no key in output)', () => {
  // A funded, correct chain reading. 100 USDC (6dp) + 0.05 ETH (wei), chain 84532.
  const fundedBaseSepolia = async () => ({ chainId: 84532, usdc: 100_000_000n, eth: 50_000_000_000_000_000n });

  it('unconfigured => NOT_CHECKED signer, not ready, says so', async () => {
    mockConfig.stakeEscrowSignerKey = null;
    __setEscrowChainReader(fundedBaseSepolia);
    const h = await escrowHealth();
    expect(h.configured).toBe(false);
    expect(h.signerMatchesAddress).toBe('NOT_CHECKED');
    expect(h.ready).toBe(false);
    expect(h.notes.join(' ')).toMatch(/not set/i);
  });

  it('key matches address + chain agrees + funded => VERIFIED and ready, key never in output', async () => {
    mockConfig.stakeEscrowSignerKey = TEST_KEY;
    mockConfig.stakeEscrowAddress = TEST_ADDR;
    __setEscrowChainReader(fundedBaseSepolia);
    const h = await escrowHealth();
    expect(h.signerMatchesAddress).toBe('VERIFIED');
    expect(h.chain.agrees).toBe(true);
    expect(h.balances.usdc).toBe('100.0');
    expect(h.ready).toBe(true);
    expect(h.escrowAddress).toBe(TEST_ADDR);
    // The private key must never appear anywhere in the output.
    expect(JSON.stringify(h)).not.toContain(TEST_KEY);
    expect(JSON.stringify(h)).not.toContain(TEST_KEY.slice(2));
  });

  it('key derives a DIFFERENT address => FAILED, not ready', async () => {
    mockConfig.stakeEscrowSignerKey = TEST_KEY;
    mockConfig.stakeEscrowAddress = '0x2222222222222222222222222222222222222222'; // not TEST_ADDR
    __setEscrowChainReader(fundedBaseSepolia);
    const h = await escrowHealth();
    expect(h.signerMatchesAddress).toBe('FAILED');
    expect(h.ready).toBe(false);
    expect(h.notes.join(' ')).toMatch(/DIFFERENT address|same wallet/i);
  });

  it('wrong chain => agrees:false, not ready', async () => {
    mockConfig.stakeEscrowSignerKey = TEST_KEY;
    mockConfig.stakeEscrowAddress = TEST_ADDR;
    __setEscrowChainReader(async () => ({ chainId: 1, usdc: 100_000_000n, eth: 1n }));
    const h = await escrowHealth();
    expect(h.chain.agrees).toBe(false);
    expect(h.ready).toBe(false);
    expect(h.notes.join(' ')).toMatch(/not Base Sepolia/i);
  });

  it('zero balances => not ready, tells operator to fund', async () => {
    mockConfig.stakeEscrowSignerKey = TEST_KEY;
    mockConfig.stakeEscrowAddress = TEST_ADDR;
    __setEscrowChainReader(async () => ({ chainId: 84532, usdc: 0n, eth: 0n }));
    const h = await escrowHealth();
    expect(h.ready).toBe(false);
    expect(h.notes.join(' ')).toMatch(/0 USDC/);
    expect(h.notes.join(' ')).toMatch(/0 ETH/);
  });

  it('RPC unreachable => chain + balances NOT_CHECKED (null), never a stand-in zero', async () => {
    mockConfig.stakeEscrowSignerKey = TEST_KEY;
    mockConfig.stakeEscrowAddress = TEST_ADDR;
    __setEscrowChainReader(async () => ({ chainId: null, usdc: null, eth: null }));
    const h = await escrowHealth();
    expect(h.chain.agrees).toBeNull();
    expect(h.balances.usdc).toBeNull();
    expect(h.balances.eth).toBeNull();
    expect(h.ready).toBe(false);
  });
});
