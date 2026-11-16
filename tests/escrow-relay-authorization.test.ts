/**
 * R3: escrowRelayAuthorization, the escrow's submit of an owner-signed EIP-3009 transfer. Its own
 * guards: no signer key → refuses; a payee other than the escrow → refuses before any send; and it
 * shares the escrow's one-at-a-time queue with refunds (one nonce). The real send is never reached:
 * the relay seam replaces it.
 */
const mockConfig = {
  stakeEscrowSignerKey: null as string | null,
  stakeEscrowAddress: '0x1111111111111111111111111111111111111111',
  usdcTokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseSepoliaRpc: 'http://localhost:0',
  stakeMinConfirmations: 1,
};
jest.mock('../src/config', () => ({ config: mockConfig }));

import { escrowRelayAuthorization, __setAuthorizationRelay, __setEscrowSender, escrowRefund, type Eip3009Authorization } from '../src/services/escrow-refunder';

const SIG = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b';
const auth = (to = mockConfig.stakeEscrowAddress): Eip3009Authorization => ({
  from: '0x' + '33'.repeat(20), to, value: '1000000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '44'.repeat(32),
});

afterEach(() => {
  mockConfig.stakeEscrowSignerKey = null;
  __setAuthorizationRelay();
  __setEscrowSender();
});

test('no signer key: refuses, and the relay is never called', async () => {
  const relay = jest.fn();
  __setAuthorizationRelay(relay);
  await expect(escrowRelayAuthorization(auth(), SIG)).rejects.toThrow(/not configured/);
  expect(relay).not.toHaveBeenCalled();
});

test('a payee other than the escrow: refuses before any send', async () => {
  mockConfig.stakeEscrowSignerKey = 'k'.repeat(10);
  const relay = jest.fn();
  __setAuthorizationRelay(relay);
  await expect(escrowRelayAuthorization(auth('0x' + '55'.repeat(20)), SIG)).rejects.toThrow(/does not pay the escrow/);
  expect(relay).not.toHaveBeenCalled();
});

test('configured, paying the escrow: relayed, and returns the tx hash', async () => {
  mockConfig.stakeEscrowSignerKey = 'k'.repeat(10);
  __setAuthorizationRelay(async () => ({ txHash: '0x' + 'ab'.repeat(32) }));
  await expect(escrowRelayAuthorization(auth(), SIG)).resolves.toEqual({ txHash: '0x' + 'ab'.repeat(32) });
});

test('shares the escrow queue with refunds: a refund started first finishes before the relay starts', async () => {
  mockConfig.stakeEscrowSignerKey = 'k'.repeat(10);
  const order: string[] = [];
  let release!: () => void;
  __setEscrowSender(async () => {
    order.push('refund:start');
    await new Promise<void>((r) => (release = r));
    order.push('refund:end');
    return { txHash: '0x' + 'cd'.repeat(32) };
  });
  __setAuthorizationRelay(async () => {
    order.push('relay');
    return { txHash: '0x' + 'ab'.repeat(32) };
  });
  const refund = escrowRefund('b', 1n, '0x' + '66'.repeat(20));
  await new Promise((r) => setImmediate(r));
  const relayed = escrowRelayAuthorization(auth(), SIG);
  await new Promise((r) => setImmediate(r));
  expect(order).toEqual(['refund:start']);
  release();
  await Promise.all([refund, relayed]);
  expect(order).toEqual(['refund:start', 'refund:end', 'relay']);
});
