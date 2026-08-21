/**
 * x402-settlement-verifier.test.ts
 *
 * Runs entirely against a fake provider, so the anti-gaming properties are
 * MEASURED rather than deferred to an environment with egress. Every address
 * and hash here is fabricated.
 */
import { ethers } from 'ethers';
import {
  __setSettlementProviderFactory,
  resolvePaymentProof,
  usdcToSmallestUnit,
  verifySettlement,
} from '../src/services/x402-settlement-verifier';
import type { EthProviderLike } from '../src/services/deposit-verifier';

const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x2222222222222222222222222222222222222222';
const PAYEE = '0x3333333333333333333333333333333333333333';
const SOMEONE_ELSE = '0x4444444444444444444444444444444444444444';
const PAYER = '0x5555555555555555555555555555555555555555';
const TX = '0x' + 'ab'.repeat(32);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const coder = ethers.AbiCoder.defaultAbiCoder();
const topicAddr = (a: string) => ethers.zeroPadValue(ethers.getAddress(a), 32);

function transferLog(token: string, to: string, value: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topicAddr(PAYER), topicAddr(to)],
    data: coder.encode(['uint256'], [value]),
  };
}

interface FakeOpts {
  receipt?: unknown;
  head?: number;
  receiptThrows?: boolean;
  headThrows?: boolean;
}

function fakeProvider(opts: FakeOpts): EthProviderLike {
  return {
    async getTransactionReceipt() {
      if (opts.receiptThrows) throw new Error('connection refused');
      return (opts.receipt ?? null) as never;
    },
    async getBlockNumber() {
      if (opts.headThrows) throw new Error('connection refused');
      return opts.head ?? 100;
    },
    async call() {
      throw new Error('balanceOf must not be called — see the header on why it is dropped here');
    },
  };
}

function install(opts: FakeOpts) {
  __setSettlementProviderFactory(() => fakeProvider(opts));
}

/** A mined, well-confirmed tx paying `value` (smallest unit) in USDC to the payee. */
function goodReceipt(value: bigint) {
  return { status: 1, blockNumber: 90, logs: [transferLog(TOKEN, PAYEE, value)] };
}

const base = { txHash: TX, payeeAddress: PAYEE, tokenAddress: TOKEN, claimedValueUsdc: 10 };

afterEach(() => __setSettlementProviderFactory(undefined));

describe('a settlement is only verified when the money is actually there', () => {
  it('verifies a transfer of at least the claimed value to the payee', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)) });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(true);
    expect(r.evidence).toBe('MEASURED');
    expect(r.confirmations).toBe(11);
  });

  it('accepts an overpayment — the claim is a lower bound, not an equality', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(25)) });
    expect((await verifySettlement(base)).verified).toBe(true);
  });

  it('refuses a hash the chain has never heard of', async () => {
    install({ receipt: null });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(false);
    // We asked and the chain said no. That is a finding, not an absence.
    expect(r.evidence).toBe('MEASURED');
    expect(r.reason).toMatch(/not found on chain/);
  });

  it('refuses a reverted tx', async () => {
    install({ receipt: { status: 0, blockNumber: 90, logs: [] } });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/reverted/);
  });

  it('refuses a tx with no transfer at all', async () => {
    install({ receipt: { status: 1, blockNumber: 90, logs: [] } });
    expect((await verifySettlement(base)).reason).toMatch(/no USDC transfer to the payee/);
  });

  it('refuses a transfer that landed somewhere else', async () => {
    install({ receipt: { status: 1, blockNumber: 90, logs: [transferLog(TOKEN, SOMEONE_ELSE, usdcToSmallestUnit(10))] } });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/did not land at the payee/);
  });

  it('refuses a transfer of some other token to the payee', async () => {
    install({ receipt: { status: 1, blockNumber: 90, logs: [transferLog(OTHER_TOKEN, PAYEE, usdcToSmallestUnit(999))] } });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/different token/);
  });

  it('ignores a spoofed Transfer log emitted by an address that is not the token', async () => {
    // The emitter check is what the dropped balanceOf guard was really covering.
    // A Transfer topic from an arbitrary contract must count for nothing.
    install({
      receipt: {
        status: 1,
        blockNumber: 90,
        logs: [
          transferLog('0x9999999999999999999999999999999999999999', PAYEE, usdcToSmallestUnit(1_000_000)),
          transferLog(TOKEN, PAYEE, usdcToSmallestUnit(10)),
        ],
      },
    });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(true);
    // Only the genuine USDC transfer counted; the spoof added nothing.
    expect(r.observedAmount).toBe(usdcToSmallestUnit(10));
  });

  it('waits for confirmations rather than trusting a fresh block', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)), head: 90 });
    const r = await verifySettlement({ ...base, minConfirmations: 5 });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/insufficient confirmations: 1 < 5/);
  });

  it('sums multiple USDC transfers to the payee in one tx', async () => {
    install({
      receipt: {
        status: 1,
        blockNumber: 90,
        logs: [transferLog(TOKEN, PAYEE, usdcToSmallestUnit(4)), transferLog(TOKEN, PAYEE, usdcToSmallestUnit(6))],
      },
    });
    expect((await verifySettlement(base)).verified).toBe(true);
  });
});

describe('the claimed service value is a checkable claim, not a free parameter', () => {
  /**
   * Value at risk scales the delta AND picks the risk band. An unverified value
   * therefore chooses its own level of scrutiny as well as its own reward.
   */
  it('CONTRADICTS a service value larger than the money that moved', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(1)) });
    const r = await verifySettlement({ ...base, claimedValueUsdc: 5000 });
    expect(r.verified).toBe(false);
    expect(r.evidence).toBe('MEASURED');
    expect(r.reason).toMatch(/claimed service value/);
    expect(r.observedAmount).toBe(usdcToSmallestUnit(1));
  });

  it('rounds the claim up, so a fractional claim is never verified against less', async () => {
    expect(usdcToSmallestUnit(0.0000001)).toBe(1n);
    expect(usdcToSmallestUnit(1.5)).toBe(1_500_000n);
    expect(usdcToSmallestUnit(0)).toBe(0n);
    expect(usdcToSmallestUnit(-5)).toBe(0n);
    expect(usdcToSmallestUnit(NaN)).toBe(0n);
  });
});

describe('an outage is an absence, never an accusation', () => {
  it('reports an RPC failure fetching the receipt as NOT_CHECKED', async () => {
    install({ receiptThrows: true });
    const r = await verifySettlement(base);
    expect(r.verified).toBe(false);
    expect(r.evidence).toBe('NOT_CHECKED');
  });

  it('reports an RPC failure fetching the head as NOT_CHECKED', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)), headThrows: true });
    expect((await verifySettlement(base)).evidence).toBe('NOT_CHECKED');
  });

  it('reports an unreachable chain as NOT_CHECKED rather than as a failed settlement', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)) });
    const r = await verifySettlement({ ...base, chainId: 1 });
    expect(r.verified).toBe(false);
    expect(r.evidence).toBe('NOT_CHECKED');
    expect(r.reason).toMatch(/no provider configured for chain 1/);
  });

  it('treats a malformed hash as a finding — we did look, at the input', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)) });
    const r = await verifySettlement({ ...base, txHash: 'pending' });
    expect(r.evidence).toBe('MEASURED');
    expect(r.verified).toBe(false);
  });
});

describe('resolving a claimed proof', () => {
  it('discards a caller-asserted verified:true when the chain disagrees', async () => {
    install({ receipt: null });
    const { proof, result } = await resolvePaymentProof(
      { txHash: TX, chainId: 84532, verified: true },
      { payeeAddress: PAYEE, claimedValueUsdc: 10, tokenAddress: TOKEN },
    );
    // The asserted `true` is exactly the claim this service exists to check.
    expect(proof.verified).toBe(false);
    expect(result.evidence).toBe('MEASURED');
  });

  it('does not let an RPC outage grant the anchor the chain never gave', async () => {
    install({ receiptThrows: true });
    const { proof, result } = await resolvePaymentProof(
      { txHash: TX, chainId: 84532, verified: true },
      { payeeAddress: PAYEE, claimedValueUsdc: 10, tokenAddress: TOKEN },
    );
    expect(proof.verified).toBe(false);
    expect(result.evidence).toBe('NOT_CHECKED');
    // No observation, so no timestamp claiming one.
    expect(proof.observedAt).toBeNull();
  });

  it('stamps observedAt only on a real observation', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)) });
    const { proof } = await resolvePaymentProof(
      { txHash: TX, chainId: 84532, verified: false },
      { payeeAddress: PAYEE, claimedValueUsdc: 10, tokenAddress: TOKEN },
    );
    expect(proof.verified).toBe(true);
    expect(typeof proof.observedAt).toBe('number');
  });

  it('carries the chain id through, so a settlement on another chain is not silently accepted', async () => {
    install({ receipt: goodReceipt(usdcToSmallestUnit(10)) });
    const { proof, result } = await resolvePaymentProof(
      { txHash: TX, chainId: 1, verified: true },
      { payeeAddress: PAYEE, claimedValueUsdc: 10, tokenAddress: TOKEN },
    );
    expect(proof.chainId).toBe(1);
    expect(proof.verified).toBe(false);
    expect(result.evidence).toBe('NOT_CHECKED');
  });
});
