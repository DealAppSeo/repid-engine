/**
 * settled-interaction-scorer.test.ts — the seam between the chain and the ledger.
 *
 * The property under test is one sentence: **an outcome can only be anchored by
 * a settlement that actually happened.** Everything else here is a way for that
 * to be false.
 *
 * All fixtures fabricated; NIL-variant agent ids per the #376 fence.
 */
import { ethers } from 'ethers';
import { OutcomeClass } from '../src/services/outcome-classification';
import { scoreSettledInteraction } from '../src/services/settled-interaction-scorer';
import { __setSettlementProviderFactory, usdcToSmallestUnit } from '../src/services/x402-settlement-verifier';
import type { EthProviderLike } from '../src/services/deposit-verifier';
import type { SettledInteraction } from '../src/services/shadow-scoring';

const PROVIDER = '00000000-0000-0000-0000-0000000000a1';
const CONSUMER = '00000000-0000-0000-0000-0000000000a2';
const TOKEN = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x3333333333333333333333333333333333333333';
const PAYER = '0x5555555555555555555555555555555555555555';
const TX = '0x' + 'cd'.repeat(32);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const coder = ethers.AbiCoder.defaultAbiCoder();

function receiptPaying(value: bigint) {
  return {
    status: 1,
    blockNumber: 90,
    logs: [
      {
        address: TOKEN,
        topics: [
          TRANSFER_TOPIC,
          ethers.zeroPadValue(PAYER, 32),
          ethers.zeroPadValue(PAYEE, 32),
        ],
        data: coder.encode(['uint256'], [value]),
      },
    ],
  };
}

function install(receipt: unknown, throws = false) {
  const p: EthProviderLike = {
    async getTransactionReceipt() {
      if (throws) throw new Error('connection refused');
      return (receipt ?? null) as never;
    },
    async getBlockNumber() {
      return 100;
    },
    async call() {
      throw new Error('not used');
    },
  };
  __setSettlementProviderFactory(() => p);
}

/** A high-value success: exactly the claim that needs an anchor to earn anything. */
function interaction(over: Partial<SettledInteraction> = {}): SettledInteraction {
  return {
    interactionId: 'fabricated-settled-1',
    providerAgentId: PROVIDER,
    consumerAgentId: CONSUMER,
    builderId: null,
    contractId: null,
    outcomeClass: OutcomeClass.SUCCESS_AUDITED,
    halCalibratedConfidence: 0.9,
    validationResponse: 95,
    serviceValueUsdc: 250,
    stakeExposedUsdc: 0,
    priorInteractions: 12,
    paymentProof: { txHash: TX, chainId: 84532, verified: true },
    ...over,
  };
}

const opts = { payeeAddress: PAYEE, tokenAddress: TOKEN };

afterEach(() => __setSettlementProviderFactory(undefined));

describe('an outcome is anchored only by a settlement that actually happened', () => {
  it('anchors and pays when the chain confirms the payment', async () => {
    install(receiptPaying(usdcToSmallestUnit(250)));
    const r = await scoreSettledInteraction(interaction(), opts);
    expect(r.anchored).toBe(true);
    expect(r.row.decision_outcome).toBe(OutcomeClass.SUCCESS_AUDITED);
    expect(r.row.delta).toBeGreaterThan(0);
    expect(r.settlement?.evidence).toBe('MEASURED');
  });

  it('DEMOTES a claimed success whose settlement does not exist on chain', async () => {
    install(null);
    const r = await scoreSettledInteraction(interaction(), opts);
    // A well-formed hash resolving to nothing is worse than no hash — it passes
    // a truthy check. It must be stripped, not passed through.
    expect(r.anchored).toBe(false);
    expect(r.row.decision_outcome).toBe(OutcomeClass.UNCERTAIN);
    expect(r.row.delta).toBe(0);
    expect(r.settlement?.verified).toBe(false);
    expect(r.settlement?.evidence).toBe('MEASURED');
  });

  it('DEMOTES a caller-asserted verified:true — the assertion is what is being checked', async () => {
    install({ status: 1, blockNumber: 90, logs: [] }); // mined, but moved nothing
    const r = await scoreSettledInteraction(interaction(), opts);
    expect(r.anchored).toBe(false);
    expect(r.row.delta).toBe(0);
  });

  it('DEMOTES a success whose claimed value exceeds the money that moved', async () => {
    // Value at risk scales the delta AND picks the risk band, so an unverified
    // value would buy both an inflated reward and a self-selected scrutiny level.
    install(receiptPaying(usdcToSmallestUnit(1)));
    const r = await scoreSettledInteraction(interaction({ serviceValueUsdc: 5000 }), opts);
    expect(r.anchored).toBe(false);
    expect(r.row.delta).toBe(0);
    expect(r.settlement?.reason).toMatch(/claimed service value/);
  });

  it('does not let an RPC outage grant an anchor, and records it as an absence', async () => {
    install(null, true);
    const r = await scoreSettledInteraction(interaction(), opts);
    expect(r.anchored).toBe(false);
    expect(r.settlement?.evidence).toBe('NOT_CHECKED');
    const payment = r.row.metadata['payment'] as Record<string, unknown>;
    // An outage and a chain that said no demote identically and are NOT the same
    // fact. The row must keep them apart.
    expect(payment['settlement_evidence']).toBe('NOT_CHECKED');
  });

  it('strips a proof it cannot resolve for want of a payee address', async () => {
    install(receiptPaying(usdcToSmallestUnit(250)));
    const r = await scoreSettledInteraction(interaction(), { tokenAddress: TOKEN });
    expect(r.anchored).toBe(false);
    expect(r.settlement?.evidence).toBe('NOT_CHECKED');
    expect(r.settlement?.reason).toMatch(/no payee address/);
  });
});

describe('what it does not invent', () => {
  it('makes no settlement claim when no proof was supplied at all', async () => {
    install(receiptPaying(usdcToSmallestUnit(250)));
    const r = await scoreSettledInteraction(interaction({ paymentProof: null }), opts);
    // Nothing to check is not a failed check. Manufacturing a verdict here would
    // be the fabrication class this repo guards against.
    expect(r.settlement).toBeUndefined();
    expect(r.anchored).toBe(false);
  });

  it('leaves classes that need no anchor unaffected', async () => {
    install(null);
    const refused = await scoreSettledInteraction(
      interaction({ outcomeClass: OutcomeClass.REFUSED_CORRECTLY, paymentProof: null }),
      opts,
    );
    // Restraint is work and is paid flat; it never needed a settlement.
    expect(refused.row.delta).toBe(2);
  });

  it('still charges a fault whose settlement cannot be verified', async () => {
    install(null);
    const r = await scoreSettledInteraction(
      interaction({ outcomeClass: OutcomeClass.FAILURE_AGENT_FAULT, halCalibratedConfidence: 0.95 }),
      opts,
    );
    // The anchor gates POSITIVE claims. An unverifiable settlement must never
    // become a way to escape a penalty.
    expect(r.row.delta).toBeLessThan(0);
  });
});

describe('the row records the chain verdict for a later reader', () => {
  it('carries verdict, evidence, reason, observed amount and confirmations', async () => {
    install(receiptPaying(usdcToSmallestUnit(300)));
    const r = await scoreSettledInteraction(interaction(), opts);
    const payment = r.row.metadata['payment'] as Record<string, unknown>;
    expect(payment['settlement_verified']).toBe(true);
    expect(payment['settlement_evidence']).toBe('MEASURED');
    expect(payment['observed_amount_smallest_unit']).toBe(usdcToSmallestUnit(300).toString());
    expect(payment['confirmations']).toBe(11);
    expect(typeof payment['settlement_reason']).toBe('string');
  });

  it('keeps the metadata JSON-serialisable — a bigint would throw on insert', async () => {
    install(receiptPaying(usdcToSmallestUnit(300)));
    const r = await scoreSettledInteraction(interaction(), opts);
    expect(() => JSON.stringify(r.row)).not.toThrow();
  });
});
