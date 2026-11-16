/**
 * payment-anchor-verify.test.ts — E2E eval 2026-11-16, gap 4: a payment anchor was accepted on
 * shape alone, so reputation could be farmed by typing a hash.
 *
 * The positive control is a REAL Base Sepolia x402 settlement, recorded once with read-only RPC
 * (tests/fixtures/payment-anchor/) and replayed offline. Every other case changes one thing about
 * it, so each refusal is attributable to that one thing. Contract ids are fabricated (NIL-variant
 * UUIDs); the chain data is public.
 *
 * Required by the brief: a real transfer, the wrong recipient, too little, a replay, RPC down.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  ANCHOR_USDC,
  paymentAnchorVerifyMode,
  shadowCheckPaymentAnchor,
  verifyPaymentAnchor,
  type AnchorBindingRow,
  type AnchorDeps,
  type AnchorReplayStore,
  type AnchorTerms,
} from '../src/services/payment-anchor-verify';
import { __setSettlementProviderFactory, verifySettlement } from '../src/services/x402-settlement-verifier';
import type { EthProviderLike } from '../src/services/deposit-verifier';

// ── the real settlement ──────────────────────────────────────────────────────
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'payment-anchor', 'base-sepolia-x402-settlement.json'), 'utf8'),
);
const REAL_TX = fixture._source.tx_hash;
const REAL_PAYER = '0xdf6b8215d193b11b4903d223729c3cf7a6de271d';
const REAL_PAYEE = '0xced17f65e03e7b3a77d5321a2d3715840317199c';
const REAL_UNITS = 1_000_000n; // 1.000000 USDC
const HEAD = fixture.receipt.blockNumber + 10;

const CONTRACT_A = '00000000-0000-0000-0000-00000000c0a1';
const CONTRACT_B = '00000000-0000-0000-0000-00000000c0b2';
const STRANGER = '0x4444444444444444444444444444444444444444';
const EVAL_FAKE_TX = '0x' + 'ab'.repeat(32); // the eval's DEMO_X402_TX

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a: string) => ethers.zeroPadValue(ethers.getAddress(a), 32);

function realReceipt(): any {
  return JSON.parse(JSON.stringify(fixture.receipt));
}

function transferLog(token: string, from: string, to: string, value: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: coder.encode(['uint256'], [value]) };
}

interface ChainOpts {
  receipts?: Record<string, unknown>;
  throwWith?: Error;
  hang?: boolean;
}
let calls = 0;
function installChain(opts: ChainOpts) {
  calls = 0;
  const p: EthProviderLike = {
    async getTransactionReceipt(hash: string) {
      calls++;
      if (opts.hang) return new Promise(() => {}) as never;
      if (opts.throwWith) throw opts.throwWith;
      return ((opts.receipts ?? {})[hash.toLowerCase()] ?? null) as never;
    },
    async getBlockNumber() {
      if (opts.throwWith) throw opts.throwWith;
      return HEAD;
    },
    async call() {
      throw new Error('not used');
    },
  };
  __setSettlementProviderFactory(() => p);
}

/** In-memory replay table with the production semantics: unique on (chain_id, tx_hash). */
function memoryReplay(): AnchorReplayStore & { rows: AnchorBindingRow[] } {
  const rows: AnchorBindingRow[] = [];
  return {
    rows,
    async find(chainId, txHash) {
      const r = rows.find((x) => x.chain_id === chainId && x.tx_hash === txHash.toLowerCase());
      return r ? { contract_id: r.contract_id } : null;
    },
    async bind(row) {
      if (rows.some((x) => x.chain_id === row.chain_id && x.tx_hash === row.tx_hash)) return 'duplicate';
      rows.push(row);
      return 'ok';
    },
  };
}

function terms(over: Partial<AnchorTerms> = {}): AnchorTerms {
  return {
    contractId: CONTRACT_A,
    payeeAddress: REAL_PAYEE,
    claimedUnits: REAL_UNITS,
    payerAddress: REAL_PAYER,
    recordedTxHash: REAL_TX,
    ...over,
  };
}

function deps(t: Record<string, AnchorTerms | null>, replay = memoryReplay(), extra: Partial<AnchorDeps> = {}): AnchorDeps {
  return { loadTerms: async (id) => (id in t ? t[id]! : null), replay, timeoutMs: 2_000, ...extra };
}

const claimA = { txHash: REAL_TX, chainId: 84532, contractId: CONTRACT_A };

afterEach(() => __setSettlementProviderFactory(undefined));

describe('1. a real transfer verifies', () => {
  it('the recorded x402 settlement verifies against its contract, as an EIP-3009 settlement', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const replay = memoryReplay();
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }, replay));
    expect(r).toMatchObject({ verdict: 'VERIFIED', reason: 'verified', settlement_kind: 'eip3009', net_units: '1000000' });
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0]).toMatchObject({ tx_hash: REAL_TX, contract_id: CONTRACT_A, payer_address: REAL_PAYER });
  });

  it('a plain USDC transfer (no AuthorizationUsed) still verifies, labelled as a transfer', async () => {
    const rc = realReceipt();
    rc.logs = rc.logs.filter((l: any) => l.topics[0] === TRANSFER_TOPIC);
    installChain({ receipts: { [REAL_TX]: rc } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }));
    expect(r).toMatchObject({ verdict: 'VERIFIED', settlement_kind: 'transfer' });
  });
});

describe('2. the wrong recipient is refused', () => {
  it('a real payment to someone else does not anchor this contract', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ payeeAddress: STRANGER }) }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'transfer_elsewhere' });
  });

  it('a Transfer log from a token that is not canonical USDC does not count', async () => {
    const rc = realReceipt();
    rc.logs = [transferLog('0x2222222222222222222222222222222222222222', REAL_PAYER, REAL_PAYEE, REAL_UNITS)];
    installChain({ receipts: { [REAL_TX]: rc } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'wrong_token' });
  });

  it('the payment must come from the payer the contract recorded', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ payerAddress: STRANGER }) }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'payer_mismatch' });
  });

  it('paying yourself is not a payment', async () => {
    const rc = realReceipt();
    rc.logs = [transferLog(ANCHOR_USDC, REAL_PAYEE, REAL_PAYEE, REAL_UNITS)];
    installChain({ receipts: { [REAL_TX]: rc } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ payerAddress: null, recordedTxHash: null }) }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'self_payment' });
  });
});

describe('3. too little is refused', () => {
  it('a contract priced one unit above what moved is refused', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ claimedUnits: REAL_UNITS + 1n }) }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'below_claimed_value' });
  });

  it('exactly the price passes: the bound is inclusive and in integer units, not a float', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ claimedUnits: REAL_UNITS }) }));
    expect(r.verdict).toBe('VERIFIED');
  });

  it('pay-and-refund in the same tx nets to nothing and is refused', async () => {
    const rc = realReceipt();
    rc.logs.push(transferLog(ANCHOR_USDC, REAL_PAYEE, REAL_PAYER, REAL_UNITS));
    installChain({ receipts: { [REAL_TX]: rc } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'refunded_in_tx', net_units: '0' });
  });

  it('a contract with no price cannot be anchored', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ claimedUnits: 0n }) }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'no_claimed_value' });
  });
});

describe('4. a replay is refused', () => {
  it('the same real tx cannot anchor the same contract twice', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const d = deps({ [CONTRACT_A]: terms() });
    expect((await verifyPaymentAnchor(claimA, d)).verdict).toBe('VERIFIED');
    const again = await verifyPaymentAnchor(claimA, d);
    expect(again).toMatchObject({ verdict: 'REFUSED', reason: 'replay_same_contract', bound_contract_id: CONTRACT_A });
  });

  it('nor a different contract', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const d = deps({ [CONTRACT_A]: terms(), [CONTRACT_B]: terms({ contractId: CONTRACT_B, recordedTxHash: null, payerAddress: null }) });
    expect((await verifyPaymentAnchor(claimA, d)).verdict).toBe('VERIFIED');
    const other = await verifyPaymentAnchor({ ...claimA, contractId: CONTRACT_B }, d);
    expect(other).toMatchObject({ verdict: 'REFUSED', reason: 'replay_other_contract', bound_contract_id: CONTRACT_A });
  });

  it('a known replay is refused even while the RPC is down', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const d = deps({ [CONTRACT_A]: terms() });
    await verifyPaymentAnchor(claimA, d);
    installChain({ throwWith: new Error('connect ECONNREFUSED') });
    expect(await verifyPaymentAnchor(claimA, d)).toMatchObject({ verdict: 'REFUSED', reason: 'replay_same_contract' });
    expect(calls).toBe(0); // refused from our own table, no chain call
  });

  it('two concurrent presentations: exactly one verifies (the unique key decides, not the pre-check)', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const d = deps({ [CONTRACT_A]: terms(), [CONTRACT_B]: terms({ contractId: CONTRACT_B, recordedTxHash: null, payerAddress: null }) });
    const [x, y] = await Promise.all([
      verifyPaymentAnchor(claimA, d),
      verifyPaymentAnchor({ ...claimA, contractId: CONTRACT_B }, d),
    ]);
    const verdicts = [x.verdict, y.verdict].sort();
    expect(verdicts).toEqual(['REFUSED', 'VERIFIED']);
    expect([x.reason, y.reason]).toContain('replay_other_contract');
  });

  it('a contract with a recorded settlement is bound to THAT tx; another real tx does not anchor it', async () => {
    const otherTx = '0x' + '12'.repeat(32);
    installChain({ receipts: { [otherTx]: realReceipt() } });
    const r = await verifyPaymentAnchor({ ...claimA, txHash: otherTx }, deps({ [CONTRACT_A]: terms() }));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'contract_tx_mismatch' });
    expect(calls).toBe(0);
  });
});

describe('5. RPC down is NOT_CHECKED: never a pass, never a refusal, and no RPC text in the answer', () => {
  const KEYED_URL = 'https://base-sepolia.example-rpc.invalid/v2/FAKE-RPC-KEY-7f3a';

  it('a throwing provider whose message carries the RPC URL and key', async () => {
    installChain({ throwWith: new Error(`server response 401 (info={ "requestUrl": "${KEYED_URL}" })`) });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }));
    expect(r).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'rpc_unreachable' });
    expect(JSON.stringify(r)).not.toMatch(/FAKE-RPC-KEY|example-rpc|requestUrl/);
  });

  it('a REAL ethers provider against an RPC answering 401 (ethers puts the URL in its message)', async () => {
    const server = http.createServer((_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid api key"}');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/FAKE-RPC-KEY-7f3a`;
    const net = ethers.Network.from(84532);
    const provider = new ethers.JsonRpcProvider(url, net, { staticNetwork: net });
    __setSettlementProviderFactory(() => provider as unknown as EthProviderLike);
    try {
      const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }));
      expect(r).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'rpc_unreachable' });
      expect(JSON.stringify(r)).not.toContain('FAKE-RPC-KEY');
      // The settlement verifier underneath must not echo it either: its reason lands in metadata.
      const s = await verifySettlement({ txHash: REAL_TX, payeeAddress: REAL_PAYEE, claimedValueUsdc: 1 });
      expect(s).toMatchObject({ verified: false, evidence: 'NOT_CHECKED', code: 'rpc_unreachable' });
      expect(s.reason).not.toContain('FAKE-RPC-KEY');
      expect(s.reason).not.toContain('127.0.0.1');
    } finally {
      provider.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('a provider that never answers times out as NOT_CHECKED', async () => {
    installChain({ hang: true });
    const r = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }, memoryReplay(), { timeoutMs: 50 }));
    expect(r).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'rpc_timeout' });
  });

  it('a replay table that cannot be read: the chain still answers, the anchor is still not VERIFIED', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const broken: AnchorReplayStore = {
      async find() {
        throw new Error('relation "payment_anchor_claims" does not exist');
      },
      async bind() {
        throw new Error('relation "payment_anchor_claims" does not exist');
      },
    };
    const ok = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms() }, broken as any));
    expect(ok).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'replay_store_unreachable', chain_verified: true });
    // ...and a chain refusal still refuses: an unreadable table never upgrades a bad anchor.
    const bad = await verifyPaymentAnchor(claimA, deps({ [CONTRACT_A]: terms({ payeeAddress: STRANGER }) }, broken as any));
    expect(bad).toMatchObject({ verdict: 'REFUSED', reason: 'transfer_elsewhere' });
  });

  it('a contract table that cannot be read is NOT_CHECKED, with no DB error text', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    const r = await verifyPaymentAnchor(claimA, {
      loadTerms: async () => {
        throw new Error('db host secret-db.internal refused');
      },
      replay: memoryReplay(),
    });
    expect(r).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'terms_unreadable' });
    expect(JSON.stringify(r)).not.toContain('secret-db');
  });
});

describe("the eval's own reproduction", () => {
  it('the made-up hash 0xabab…ab with no contract is refused before any RPC call', async () => {
    installChain({ receipts: {} });
    const r = await verifyPaymentAnchor({ txHash: EVAL_FAKE_TX, chainId: 84532, contractId: null }, deps({}));
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'contract_unbound' });
    expect(calls).toBe(0);
  });

  it('the made-up hash bound to a real-looking contract: the chain has no such tx', async () => {
    installChain({ receipts: {} });
    const r = await verifyPaymentAnchor(
      { txHash: EVAL_FAKE_TX, chainId: 84532, contractId: CONTRACT_A },
      deps({ [CONTRACT_A]: terms({ recordedTxHash: null, payerAddress: null }) }),
    );
    expect(r).toMatchObject({ verdict: 'REFUSED', reason: 'tx_not_found' });
  });

  it('shape and chain still refuse first', async () => {
    installChain({ receipts: {} });
    expect((await verifyPaymentAnchor({ txHash: 'pending', chainId: 84532, contractId: CONTRACT_A }, deps({}))).reason).toBe('malformed_tx_hash');
    expect((await verifyPaymentAnchor({ ...claimA, chainId: 8453 }, deps({}))).reason).toBe('wrong_chain');
    expect((await verifyPaymentAnchor(claimA, deps({}))).reason).toBe('contract_unknown');
  });
});

describe('PAYMENT_ANCHOR_VERIFY_MODE', () => {
  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('defaults to off', () => {
    expect(paymentAnchorVerifyMode(undefined)).toEqual({ requested: 'off', effective: 'off' });
    expect(paymentAnchorVerifyMode('')).toEqual({ requested: 'off', effective: 'off' });
    expect(paymentAnchorVerifyMode(' OFF ')).toEqual({ requested: 'off', effective: 'off' });
  });

  it('enforce is refused in this build: it runs as shadow and says so', () => {
    const m = paymentAnchorVerifyMode('enforce');
    expect(m.requested).toBe('enforce');
    expect(m.effective).toBe('shadow');
    expect(m.note).toMatch(/refused/);
  });

  it('a typo runs as shadow (records, moves nothing), loudly', () => {
    const m = paymentAnchorVerifyMode('enforec');
    expect(m).toMatchObject({ requested: 'invalid', effective: 'shadow' });
  });

  it('off reads nothing at all', async () => {
    installChain({ receipts: { [REAL_TX]: realReceipt() } });
    let loaded = 0;
    const r = await shadowCheckPaymentAnchor(claimA, { loadTerms: async () => (loaded++, terms()), replay: memoryReplay() }, paymentAnchorVerifyMode('off'));
    expect(r).toBeNull();
    expect(loaded).toBe(0);
    expect(calls).toBe(0);
  });

  it('shadow checks, logs the would-refuse, and reports would_refuse', async () => {
    installChain({ receipts: {} });
    const r = await shadowCheckPaymentAnchor(
      { txHash: EVAL_FAKE_TX, chainId: 84532, contractId: null },
      deps({}),
      paymentAnchorVerifyMode('shadow'),
    );
    expect(r).toMatchObject({ verdict: 'REFUSED', would_refuse: true });
    expect(warnSpy.mock.calls.join(' ')).toMatch(/would REFUSE anchor reason=contract_unbound/);
  });
});
