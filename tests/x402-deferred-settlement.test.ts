/**
 * Pay-on-verified-delivery — the authorization window is the safety-critical
 * part, so it is tested without a database or a network.
 *
 * The failure this guards against: a provider does real work, and only when
 * the settlement is attempted does anyone discover the buyer's EIP-3009
 * signature expired while the work was happening. The provider is then owed
 * money that cannot be collected from the authorization. That must surface as
 * a named EXPIRED state before the broadcast, not as an opaque facilitator
 * error afterwards.
 */
import { assessAuthorization, readAuthorizationWindow, SETTLEMENT_STATUS } from '../src/services/x402-deferred-settlement';

/** Build an X-PAYMENT header the way run-e2e-transactions.ts does. */
function header(validAfter: number, validBefore: number): string {
  return Buffer.from(
    JSON.stringify({
      payload: {
        authorization: {
          from: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
          to: '0xf6eE1768868c3266868edcA78bC41C50309cb22A',
          value: '100000',
          validAfter,
          validBefore,
          nonce: '0x' + '11'.repeat(32),
        },
        signature: '0x' + 'ab'.repeat(65),
      },
    })
  ).toString('base64');
}

const NOW = 1_800_000_000;

describe('authorization window', () => {
  it('reads validAfter/validBefore out of a real-shaped header', () => {
    expect(readAuthorizationWindow(header(0, NOW + 3600))).toEqual({ validAfter: 0, validBefore: NOW + 3600 });
  });

  it('reports an unreadable header as unknown rather than valid', () => {
    expect(readAuthorizationWindow('not-base64-json')).toBeNull();
    expect(readAuthorizationWindow(Buffer.from('{}').toString('base64'))).toBeNull();
    // The dangerous case: a header that parses but carries no window at all.
    const noWindow = Buffer.from(JSON.stringify({ payload: { authorization: { from: '0x1' } } })).toString('base64');
    expect(readAuthorizationWindow(noWindow)).toBeNull();
  });

  it('accepts an authorization inside its window', () => {
    const r = assessAuthorization(header(0, NOW + 3600), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.secondsRemaining).toBe(3600);
  });

  it('REFUSES an expired authorization and says the provider is owed', () => {
    const r = assessAuthorization(header(0, NOW - 1), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/EXPIRED/);
      // The message must not imply the loss is acceptable or silent.
      expect(r.reason).toMatch(/dispute, not a silent loss/);
    }
  });

  it('REFUSES an authorization that is not yet valid', () => {
    const r = assessAuthorization(header(NOW + 60, NOW + 3600), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not yet valid/);
  });

  it('treats the boundary second as expired, not valid', () => {
    // validBefore is exclusive on-chain; being generous here would broadcast a
    // transfer the token contract then reverts, burning gas for nothing.
    expect(assessAuthorization(header(0, NOW), NOW).ok).toBe(false);
    expect(assessAuthorization(header(0, NOW + 1), NOW).ok).toBe(true);
  });

  it('refuses an unreadable window rather than assuming it is fine', () => {
    const r = assessAuthorization('garbage', NOW);
    expect(r.ok).toBe(false);
  });
});

describe('settlement status vocabulary', () => {
  it('keeps AUTHORIZED distinct from SETTLED', () => {
    // These must never collapse: AUTHORIZED means a signature is held and NO
    // money has moved; SETTLED means an on-chain transfer happened. Conflating
    // them is how a system reports a payment that never occurred.
    expect(SETTLEMENT_STATUS.AUTHORIZED).not.toBe(SETTLEMENT_STATUS.SETTLED);
    expect(SETTLEMENT_STATUS.VOIDED).not.toBe(SETTLEMENT_STATUS.SETTLED);
    expect(SETTLEMENT_STATUS.SETTLING).not.toBe(SETTLEMENT_STATUS.SETTLED);
    expect(new Set(Object.values(SETTLEMENT_STATUS)).size).toBe(4);
  });
});
