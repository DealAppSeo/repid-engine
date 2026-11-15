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
  RefundBroadcastUnconfirmed,
  refundWaitFailure,
  broadcastFailure,
  nonceExpiredOutcome,
  escrowPayout,
  configuredEscrowAddress,
} from '../src/services/escrow-refunder';

const BUILDER = 'builder-1';
/** The JSON-RPC request ethers names on an error from the send itself. */
const SEND = { method: 'eth_sendRawTransaction', params: ['0xsigned'], id: 1 };
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

  it('broadcast, then the receipt wait failed => INITIATED + unconfirmed, never "did not happen"', async () => {
    // The USDC may already have left the shared escrow; reporting it as not sent let the same stake
    // be withdrawn again (found reviewing #1550).
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async () => {
      throw new RefundBroadcastUnconfirmed('0xabc', 'timeout');
    });
    const r = await escrowRefund(BUILDER, 5_000_000n, PAYEE);
    expect(r).toMatchObject({ initiated: true, stub: false, unconfirmed: true, txHash: '0xabc' });
  });

  it('refundWaitFailure: only a status-0 receipt is a revert; anything else after broadcast is unconfirmed', () => {
    expect(refundWaitFailure({ code: 'CALL_EXCEPTION', receipt: { status: 0, blockNumber: 1 } }, '0x1')).not.toBeInstanceOf(RefundBroadcastUnconfirmed);
    for (const e of [{ code: 'TIMEOUT' }, new Error('socket hang up'), { code: 'TRANSACTION_REPLACED' }, null]) {
      const out = refundWaitFailure(e, '0x2');
      expect(out).toBeInstanceOf(RefundBroadcastUnconfirmed);
      expect((out as RefundBroadcastUnconfirmed).txHash).toBe('0x2');
    }
  });

  it('broadcastFailure: only an explicit node rejection is "not sent"; a lost reply is unconfirmed, with the hash', () => {
    for (const code of ['INSUFFICIENT_FUNDS', 'REPLACEMENT_UNDERPRICED']) {
      expect(broadcastFailure({ code, message: 'rejected', info: { payload: SEND } }, '0x3')).not.toBeInstanceOf(RefundBroadcastUnconfirmed);
    }
    for (const e of [{ code: 'TIMEOUT' }, { code: 'NETWORK_ERROR' }, { code: 'SERVER_ERROR' }, { code: 'NONCE_EXPIRED' }, new Error('socket hang up'), null]) {
      const out = broadcastFailure(e, '0x4');
      expect(out).toBeInstanceOf(RefundBroadcastUnconfirmed);
      expect((out as RefundBroadcastUnconfirmed).txHash).toBe('0x4');
    }
  });

  it('broadcastFailure: a refusal carrying the node\'s own reply is "not sent"; "already known" and no reply are unconfirmed', () => {
    // Strix on #1550: ethers reports most refusals as UNKNOWN_ERROR with the node's reply attached.
    for (const e of [
      { code: 'UNKNOWN_ERROR', error: { code: -32000, message: 'transaction underpriced' }, payload: SEND },
      { code: 'UNKNOWN_ERROR', error: { code: -32000, message: 'intrinsic gas too low' }, payload: SEND },
      { code: 'UNKNOWN_ERROR', info: { error: { code: -32000, message: 'max fee per gas less than block base fee' }, payload: SEND } },
    ]) {
      const out = broadcastFailure(e, '0x7');
      expect(out).toBeInstanceOf(Error);
      expect(out).not.toBeInstanceOf(RefundBroadcastUnconfirmed);
    }
    expect(broadcastFailure({ code: 'UNKNOWN_ERROR', error: { message: 'already known' }, payload: SEND }, '0x7')).toBeInstanceOf(RefundBroadcastUnconfirmed);
    expect(broadcastFailure({ code: 'TIMEOUT' }, '0x7')).toBeInstanceOf(RefundBroadcastUnconfirmed);
    expect(broadcastFailure({ code: 'SERVER_ERROR', info: { responseStatus: '502 Bad Gateway' } }, '0x7')).toBeInstanceOf(RefundBroadcastUnconfirmed);
  });

  it('broadcastFailure: an error on a CO-BATCHED read is not a refusal of the send (it may have been accepted)', () => {
    // Strix on #1550: ethers resolves eth_blockNumber / eth_chainId together with the send.
    for (const method of ['eth_blockNumber', 'eth_chainId']) {
      const out = broadcastFailure({ code: 'UNKNOWN_ERROR', error: { code: -32005, message: 'limit exceeded' }, payload: { method } }, '0x8');
      expect(out).toBeInstanceOf(RefundBroadcastUnconfirmed);
    }
    // ...and a named rejection code with no request named is not trusted either.
    expect(broadcastFailure({ code: 'INSUFFICIENT_FUNDS' }, '0x8')).toBeInstanceOf(RefundBroadcastUnconfirmed);
  });

  it('refundWaitFailure: a replacement is settled by its proof, not assumed to have landed', () => {
    // Strix on #1550: a cancelled refund was booked as paid.
    for (const reason of ['cancelled', 'replaced']) {
      const out = refundWaitFailure({ code: 'TRANSACTION_REPLACED', cancelled: true, reason, receipt: { status: 1, hash: '0xother' } }, '0x6');
      expect(out).toBeInstanceOf(Error);
      expect(out).not.toBeInstanceOf(RefundBroadcastUnconfirmed); // nothing was sent
    }
    expect(refundWaitFailure({ code: 'TRANSACTION_REPLACED', cancelled: false, reason: 'repriced', receipt: { status: 1, hash: '0xnew' } }, '0x6')).toEqual({ txHash: '0xnew' });
    expect(refundWaitFailure({ code: 'TRANSACTION_REPLACED', cancelled: false, reason: 'repriced', receipt: { status: 0, hash: '0xnew' } }, '0x6')).not.toBeInstanceOf(RefundBroadcastUnconfirmed);
    expect(refundWaitFailure({ code: 'TRANSACTION_REPLACED', cancelled: false, reason: 'repriced' }, '0x6')).toBeInstanceOf(RefundBroadcastUnconfirmed); // no receipt: unclear
  });

  it('nonceExpiredOutcome: our own receipt decides; no receipt means another tx took the nonce (not sent)', () => {
    expect(nonceExpiredOutcome(null, '0x5')).not.toBeInstanceOf(RefundBroadcastUnconfirmed); // never minable: not sent
    expect(nonceExpiredOutcome(null, '0x5')).toBeInstanceOf(Error);
    expect(nonceExpiredOutcome({ status: 1 }, '0x5')).toEqual({ txHash: '0x5' }); // ours, and it landed
    expect(nonceExpiredOutcome({ status: 0 }, '0x5')).not.toBeInstanceOf(RefundBroadcastUnconfirmed); // ours, reverted
    expect(nonceExpiredOutcome(undefined, '0x5')).toBeInstanceOf(RefundBroadcastUnconfirmed); // lookup failed
  });

  it('refunds from the one escrow wallet run one at a time, whatever builder they are for', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    const log: string[] = [];
    __setEscrowSender(async (to) => {
      log.push(`start ${to.slice(-1)}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`end ${to.slice(-1)}`);
      return { txHash: '0xok' };
    });
    await Promise.all([
      escrowRefund('builder-a', 1n, '0x' + '2'.repeat(39) + 'a'),
      escrowRefund('builder-b', 1n, '0x' + '2'.repeat(39) + 'b'),
    ]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
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

describe('escrowPayout — an agent paid from the stake goes through the refund send and its guards', () => {
  it('sends to the payee, and shares the one-at-a-time queue with refunds (one escrow nonce)', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    const log: string[] = [];
    __setEscrowSender(async (to, amount) => {
      log.push(`start ${to.slice(-1)} ${amount}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`end ${to.slice(-1)}`);
      return { txHash: '0xok' };
    });
    const [paid] = await Promise.all([
      escrowPayout('0x' + '2'.repeat(39) + 'a', 7n),
      escrowRefund('builder-b', 1n, '0x' + '2'.repeat(39) + 'b'),
    ]);
    expect(paid).toMatchObject({ initiated: true, stub: false, txHash: '0xok', amount: '7' });
    expect(log).toEqual(['start a 7', 'end a', 'start b 1', 'end b']);
  });

  it('keeps the refund outcomes: unconfirmed stays unconfirmed, a failure is not sent, no signer is a stub', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async () => { throw new RefundBroadcastUnconfirmed('0xmaybe', 'wait failed'); });
    expect(await escrowPayout(PAYEE, 5n)).toMatchObject({ initiated: true, unconfirmed: true, txHash: '0xmaybe' });
    __setEscrowSender(async () => { throw new Error('rejected by the node'); });
    expect(await escrowPayout(PAYEE, 5n)).toMatchObject({ initiated: false, stub: false });
    mockConfig.stakeEscrowSignerKey = null;
    expect(await escrowPayout(PAYEE, 5n)).toMatchObject({ stub: true });
  });

  it('configuredEscrowAddress: only when the signer AND the address are set', () => {
    mockConfig.stakeEscrowSignerKey = null;
    expect(configuredEscrowAddress()).toBeNull();
    mockConfig.stakeEscrowSignerKey = 'present';
    expect(configuredEscrowAddress()).toBe('0x1111111111111111111111111111111111111111');
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
