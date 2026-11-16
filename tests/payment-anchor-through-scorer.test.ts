/**
 * payment-anchor-through-scorer.test.ts — the same five cases as payment-anchor-verify.test.ts, but
 * driven through `scoreSettledInteraction`, the seam built for caller-supplied payment anchors.
 *
 * Why a second file: this one imports only modules that exist on main, so on main each case fails
 * BY ASSERTION (the anchor check is absent, or the RPC text leaks), not by a missing import. That
 * makes "fails on main, passes on the branch" a statement about behaviour.
 *
 * The anchor check is SHADOW: these tests also pin that it changes no delta, no class and no
 * anchoring decision. Those inertness tests pass on main too, which is the point.
 *
 * The positive control is a real Base Sepolia settlement, recorded with read-only RPC and replayed
 * offline (tests/fixtures/payment-anchor/). Contract ids are fabricated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutcomeClass } from '../src/services/outcome-classification';
import { scoreSettledInteraction } from '../src/services/settled-interaction-scorer';
import { __setSettlementProviderFactory } from '../src/services/x402-settlement-verifier';
import type { EthProviderLike } from '../src/services/deposit-verifier';
import type { SettledInteraction } from '../src/services/shadow-scoring';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'payment-anchor', 'base-sepolia-x402-settlement.json'), 'utf8'),
);
const REAL_TX: string = fixture._source.tx_hash;
const REAL_PAYER = '0xdf6b8215d193b11b4903d223729c3cf7a6de271d';
const REAL_PAYEE = '0xced17f65e03e7b3a77d5321a2d3715840317199c';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const STRANGER = '0x4444444444444444444444444444444444444444';
const HEAD = fixture.receipt.blockNumber + 10;

const PROVIDER = '00000000-0000-0000-0000-0000000000a1';
const CONSUMER = '00000000-0000-0000-0000-0000000000a2';
const CONTRACT_A = '00000000-0000-0000-0000-00000000c0a1';
const CONTRACT_B = '00000000-0000-0000-0000-00000000c0b2';
const KEYED_RPC_ERROR = 'server response 401 (info={ "requestUrl": "https://rpc.example.invalid/v2/FAKE-RPC-KEY-7f3a" })';

interface Terms {
  contractId: string;
  payeeAddress: string | null;
  claimedUnits: bigint;
  payerAddress: string | null;
  recordedTxHash: string | null;
}

function installChain(mode: 'real' | 'down') {
  const p: EthProviderLike = {
    async getTransactionReceipt(hash: string) {
      if (mode === 'down') throw new Error(KEYED_RPC_ERROR);
      return (hash.toLowerCase() === REAL_TX ? JSON.parse(JSON.stringify(fixture.receipt)) : null) as never;
    },
    async getBlockNumber() {
      if (mode === 'down') throw new Error(KEYED_RPC_ERROR);
      return HEAD;
    },
    async call() {
      throw new Error('not used');
    },
  };
  __setSettlementProviderFactory(() => p);
}

/** Contract records + a replay table with production semantics (unique on chain_id, tx_hash). */
function anchorDeps(contracts: Record<string, Partial<Terms>>) {
  const rows: Array<{ chain_id: number; tx_hash: string; contract_id: string }> = [];
  return {
    loadTerms: async (id: string) =>
      contracts[id]
        ? {
            contractId: id,
            payeeAddress: REAL_PAYEE,
            claimedUnits: 1_000_000n,
            payerAddress: REAL_PAYER,
            recordedTxHash: null,
            ...contracts[id],
          }
        : null,
    replay: {
      async find(chainId: number, txHash: string) {
        const r = rows.find((x) => x.chain_id === chainId && x.tx_hash === txHash.toLowerCase());
        return r ? { contract_id: r.contract_id } : null;
      },
      async bind(row: any) {
        if (rows.some((x) => x.chain_id === row.chain_id && x.tx_hash === row.tx_hash)) return 'duplicate' as const;
        rows.push(row);
        return 'ok' as const;
      },
    },
    timeoutMs: 2_000,
  };
}

function interaction(over: Partial<SettledInteraction> = {}): SettledInteraction {
  return {
    interactionId: 'fabricated-anchor-1',
    providerAgentId: PROVIDER,
    consumerAgentId: CONSUMER,
    builderId: null,
    contractId: CONTRACT_A,
    outcomeClass: OutcomeClass.SUCCESS_AUDITED,
    halCalibratedConfidence: 0.9,
    validationResponse: 95,
    serviceValueUsdc: 1,
    stakeExposedUsdc: 0,
    priorInteractions: 12,
    paymentProof: { txHash: REAL_TX, chainId: 84532, verified: true },
    ...over,
  };
}

const CALLER_OPTS = { payeeAddress: REAL_PAYEE, tokenAddress: USDC };
const anchorCheck = (r: any) => (r.row.metadata['payment'] as Record<string, any> | undefined)?.['anchor_check'];

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PAYMENT_ANCHOR_VERIFY_MODE;
  process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'shadow';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.PAYMENT_ANCHOR_VERIFY_MODE;
  else process.env.PAYMENT_ANCHOR_VERIFY_MODE = saved;
  __setSettlementProviderFactory(undefined);
  jest.restoreAllMocks();
});

describe('shadow anchor check, through the scorer', () => {
  it('1. a real transfer: VERIFIED, as an EIP-3009 settlement', async () => {
    installChain('real');
    const r = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: {} }) } as any);
    expect(r.anchored).toBe(true);
    expect(anchorCheck(r)).toMatchObject({ mode: 'shadow', verdict: 'VERIFIED', settlement_kind: 'eip3009', would_refuse: false });
  });

  it("2. the wrong recipient: the caller's payee matches the tx, but our contract record names another", async () => {
    installChain('real');
    const r = await scoreSettledInteraction(
      interaction(),
      { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: { payeeAddress: STRANGER } }) } as any,
    );
    expect(anchorCheck(r)).toMatchObject({ verdict: 'REFUSED', reason: 'transfer_elsewhere', would_refuse: true });
  });

  it("3. too little: the caller claims 1 USDC and paid 1, but the contract's price is 2", async () => {
    installChain('real');
    const r = await scoreSettledInteraction(
      interaction(),
      { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: { claimedUnits: 2_000_000n } }) } as any,
    );
    expect(anchorCheck(r)).toMatchObject({ verdict: 'REFUSED', reason: 'below_claimed_value', would_refuse: true });
  });

  it('4. a replay: one real payment presented for a second contract', async () => {
    installChain('real');
    const deps = anchorDeps({ [CONTRACT_A]: {}, [CONTRACT_B]: {} });
    const first = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: deps } as any);
    const second = await scoreSettledInteraction(
      interaction({ interactionId: 'fabricated-anchor-2', contractId: CONTRACT_B }),
      { ...CALLER_OPTS, anchorDeps: deps } as any,
    );
    expect(anchorCheck(first)).toMatchObject({ verdict: 'VERIFIED' });
    expect(anchorCheck(second)).toMatchObject({
      verdict: 'REFUSED',
      reason: 'replay_other_contract',
      bound_contract_id: CONTRACT_A,
      would_refuse: true,
    });
  });

  it('5. RPC down: NOT_CHECKED, and no RPC URL or key anywhere in the row', async () => {
    installChain('down');
    const r = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: {} }) } as any);
    expect(anchorCheck(r)).toMatchObject({ verdict: 'NOT_CHECKED', reason: 'rpc_unreachable', would_refuse: true });
    expect(r.settlement?.evidence).toBe('NOT_CHECKED');
    expect(JSON.stringify(r.row)).not.toContain('FAKE-RPC-KEY');
    expect(r.settlement?.reason ?? '').not.toContain('rpc.example.invalid');
  });

  it('an anchor that names no contract is refused, and the check reads no contract table', async () => {
    installChain('real');
    let loaded = 0;
    const deps = anchorDeps({});
    const r = await scoreSettledInteraction(interaction({ contractId: null }), {
      ...CALLER_OPTS,
      anchorDeps: { ...deps, loadTerms: async (id: string) => (loaded++, deps.loadTerms(id)) },
    } as any);
    expect(anchorCheck(r)).toMatchObject({ verdict: 'REFUSED', reason: 'contract_unbound' });
    expect(loaded).toBe(0);
  });
});

describe('the shadow check moves nothing (passes on main too, by design)', () => {
  async function both(build: () => Promise<any>) {
    process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'off';
    const off = await build();
    process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'shadow';
    const shadow = await build();
    return { off, shadow };
  }
  const shape = (r: any) => ({ anchored: r.anchored, delta: r.row.delta, cls: r.row.decision_outcome });

  it('a refused anchor (wrong recipient) earns exactly what it earned before', async () => {
    installChain('real');
    const { off, shadow } = await both(() =>
      scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: { payeeAddress: STRANGER } }) } as any),
    );
    expect(shape(shadow)).toEqual(shape(off));
  });

  it('a replayed anchor earns exactly what it earned before', async () => {
    installChain('real');
    const deps = anchorDeps({ [CONTRACT_A]: {}, [CONTRACT_B]: {} });
    await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: deps } as any);
    const { off, shadow } = await both(() =>
      scoreSettledInteraction(
        interaction({ interactionId: 'fabricated-anchor-2', contractId: CONTRACT_B }),
        { ...CALLER_OPTS, anchorDeps: deps } as any,
      ),
    );
    expect(shape(shadow)).toEqual(shape(off));
    expect(off.anchored).toBe(true); // today the replay still anchors: shadow records, does not enforce
  });

  it('off writes no anchor_check at all', async () => {
    installChain('real');
    process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'off';
    const r = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: anchorDeps({ [CONTRACT_A]: {} }) } as any);
    expect(anchorCheck(r)).toBeUndefined();
  });

  it('enforce is refused: it records exactly what shadow records and changes nothing', async () => {
    installChain('real');
    const deps = () => anchorDeps({ [CONTRACT_A]: { payeeAddress: STRANGER } });
    process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'off';
    const off = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: deps() } as any);
    process.env.PAYMENT_ANCHOR_VERIFY_MODE = 'enforce';
    const enf = await scoreSettledInteraction(interaction(), { ...CALLER_OPTS, anchorDeps: deps() } as any);
    expect(shape(enf)).toEqual(shape(off));
    expect(anchorCheck(enf)).toMatchObject({ mode: 'shadow', requested_mode: 'enforce', verdict: 'REFUSED' });
  });
});
