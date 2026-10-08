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

import { escrowRefund, __setEscrowSender } from '../src/services/escrow-refunder';

const BUILDER = 'builder-1';
const PAYEE = '0x2222222222222222222222222222222222222222';

afterEach(() => {
  __setEscrowSender(undefined);
  mockConfig.stakeEscrowSignerKey = null;
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
