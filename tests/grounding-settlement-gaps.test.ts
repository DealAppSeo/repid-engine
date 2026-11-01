/**
 * Overnight 2026-11-01, item 2: the settlement cases repid-engine #1470 left untested,
 * checked against the payment-grounding resolver (src/scoring/grounding.ts).
 * SYNTHETIC fixtures only.
 *
 * Each case below is one line of Chat's Loop 1 list. Already covered elsewhere, not
 * repeated here: two agents reuse one proof (grounding-attacks A2), a concurrent replay
 * (A5), a contract rated twice (#1470, plus the live unique index
 * service_outcomes_contract_uniq).
 */
import {
  BASE_SEPOLIA_USDC,
  DEFAULT_GROUNDING_CHAIN_ID,
  createMemoryGroundingStore,
  resolveGrounding,
  type ChainLog,
  type ChainReader,
} from '../src/scoring/grounding';

const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_A2 = '0x5555555555555555555555555555555555555555'; // same agent, second wallet
const PAYER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x4444444444444444444444444444444444444444';
const TX = '0x' + 'ab'.repeat(32);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ONE_USDC = 1_000_000n;

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const usdc = (from: string, to: string, units: bigint): ChainLog => ({
  address: BASE_SEPOLIA_USDC,
  topics: [TRANSFER, pad(from), pad(to)],
  data: '0x' + units.toString(16).padStart(64, '0'),
});

function chain(logs: ChainLog[], chainId = 84532): ChainReader {
  return {
    chainId,
    async getTransaction() {
      return { hash: TX, from: PAYER, to: BASE_SEPOLIA_USDC, value: 0n, blockNumber: 1 };
    },
    async getReceipt() {
      return { status: 1, blockNumber: 1, logs };
    },
  };
}

const resolve = (c: ChainReader, wallets = [WALLET_A]) =>
  resolveGrounding({
    agentId: AGENT_A,
    eventType: 'CODE_CONTRIBUTION',
    evidence: { kind: 'payment', txHash: TX },
    agentWallets: wallets,
    store: createMemoryGroundingStore(),
    chain: c,
  });

describe('control: the fixture can produce a grounded payment', () => {
  // Without this, every 0 below could be the fixture failing rather than the rule (LESSONS 5).
  it('a single paid transfer to the agent grounds high', async () => {
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC)]));
    expect(r.g_verified).toBe('high');
    expect(r.reason).toBe('payment_verified');
  });
});

describe('repeated transfers in one transaction', () => {
  it('a refund back to the payer in the same tx is not a payment', async () => {
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC), usdc(WALLET_A, PAYER, ONE_USDC)]));
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });

  it('a partial refund that leaves the net under the floor is not a payment', async () => {
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC), usdc(WALLET_A, PAYER, 950_000n)]));
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });

  it('the refund is caught even when it is the FIRST log', async () => {
    const r = await resolve(chain([usdc(WALLET_A, PAYER, ONE_USDC), usdc(PAYER, WALLET_A, ONE_USDC)]));
    expect(r.g_verified).toBe(0);
  });

  it('the agent forwarding the money on to a third wallet in the same tx is not a payment', async () => {
    // Related-party cycle inside one tx: in from PAYER, straight back out to a wallet PAYER controls.
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC), usdc(WALLET_A, STRANGER, ONE_USDC)]));
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });
});

describe('log order is chosen by the tx author (Strix on #1473)', () => {
  // The first fix keyed the refund check to log 0. A decoy Transfer placed first moved
  // the pay-and-refund pair out of that position and grounded high again.
  it('a decoy transfer first, then pay and refund, is not a payment', async () => {
    const r = await resolve(
      chain([
        usdc(PAYER, WALLET_A, ONE_USDC),
        usdc(STRANGER, PAYER, 1n),
        usdc(PAYER, WALLET_A, ONE_USDC),
        usdc(WALLET_A, PAYER, ONE_USDC),
      ]),
    );
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });

  it("a refund sent from the agent's SECOND wallet is not a payment", async () => {
    const r = await resolve(
      chain([usdc(PAYER, WALLET_A, ONE_USDC), usdc(WALLET_A2, PAYER, ONE_USDC)]),
      [WALLET_A, WALLET_A2],
    );
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });

  it('a decoy to an unrelated pair, with the real payment second, is still refused', async () => {
    const r = await resolve(chain([usdc(STRANGER, PAYER, 1n), usdc(PAYER, WALLET_A, ONE_USDC)]));
    expect(r.g_verified).toBe(0);
  });
});

describe('a refund in another asset (Strix, second review of #1473)', () => {
  const OTHER_TOKEN = '0x6666666666666666666666666666666666666666';
  const other = (from: string, to: string, units: bigint): ChainLog => ({ ...usdc(from, to, units), address: OTHER_TOKEN });

  it('a USDC payment refunded in a different ERC-20 in the same tx is not a payment', async () => {
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC), other(WALLET_A, PAYER, ONE_USDC)]));
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('multiple_transfers_in_tx');
  });

  it('a tx that does not call the token contract directly is not a settlement', async () => {
    // Native ETH moved by an internal call emits no log, so a wrapping contract could refund
    // invisibly. A transferWithAuthorization settlement calls USDC itself.
    const c = chain([usdc(PAYER, WALLET_A, ONE_USDC)]);
    const r = await resolve({
      ...c,
      getTransaction: async () => ({ hash: TX, from: PAYER, to: STRANGER, value: 0n, blockNumber: 1 }),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('not_direct_token_call');
  });
});

describe('the token is pinned, not chosen by the caller (Strix, third review of #1473)', () => {
  it('a Transfer of a self-deployed token named in the evidence does not ground', async () => {
    const FAKE = '0x7777777777777777777777777777777777777777';
    const r = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX, tokenAddress: FAKE },
      agentWallets: [WALLET_A],
      store: createMemoryGroundingStore(),
      chain: {
        chainId: 84532,
        getTransaction: async () => ({ hash: TX, from: PAYER, to: FAKE, value: 0n, blockNumber: 1 }),
        getReceipt: async () => ({ status: 1, blockNumber: 1, logs: [{ ...usdc(PAYER, WALLET_A, ONE_USDC), address: FAKE }] }),
      },
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('token_not_allowed');
  });

  it('naming the real USDC address explicitly still grounds (control)', async () => {
    const r = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX, tokenAddress: BASE_SEPOLIA_USDC.toLowerCase() },
      agentWallets: [WALLET_A],
      store: createMemoryGroundingStore(),
      chain: chain([usdc(PAYER, WALLET_A, ONE_USDC)]),
    });
    expect(r.g_verified).toBe('high');
  });
});

describe('same owner, different wallets', () => {
  it("a transfer between two of the agent's own wallets is not a payment", async () => {
    const r = await resolve(chain([usdc(WALLET_A2, WALLET_A, ONE_USDC)]), [WALLET_A, WALLET_A2]);
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('self_transfer');
  });

  it('the same transfer still grounds when only one side is the agent (control)', async () => {
    const r = await resolve(chain([usdc(WALLET_A2, WALLET_A, ONE_USDC)]), [WALLET_A]);
    expect(r.g_verified).toBe('high');
  });
});

describe('reused event across chains', () => {
  it('a reader for another chain does not ground, even with a matching transfer', async () => {
    expect(DEFAULT_GROUNDING_CHAIN_ID).toBe(84532);
    const r = await resolve(chain([usdc(PAYER, WALLET_A, ONE_USDC)], 8453));
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('wrong_chain');
  });

  it('the same tx hash cannot ground twice by being presented on a second chain', async () => {
    // evidence_id is hash-only, so the second presentation collides and refuses (fails closed).
    const store = createMemoryGroundingStore();
    const run = (c: ChainReader) =>
      resolveGrounding({
        agentId: AGENT_A,
        eventType: 'CODE_CONTRIBUTION',
        evidence: { kind: 'payment', txHash: TX },
        agentWallets: [WALLET_A],
        store,
        chain: c,
      });
    const first = await run(chain([usdc(PAYER, WALLET_A, ONE_USDC)]));
    const second = await run(chain([usdc(PAYER, WALLET_A, ONE_USDC)], 8453));
    expect(first.g_verified).toBe('high');
    expect(second.g_verified).toBe(0);
    expect(second.reused).toBe(true);
  });
});

describe('missing RPC data fails closed, never high', () => {
  const base = chain([usdc(PAYER, WALLET_A, ONE_USDC)]);
  it('getTransaction throws', async () => {
    const r = await resolve({ ...base, getTransaction: async () => { throw new Error('ECONNRESET'); } });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toMatch(/^resolver_error:/);
  });
  it('the receipt has no logs field', async () => {
    const r = await resolve({
      ...base,
      getReceipt: async () => ({ status: 1, blockNumber: 1 } as unknown as never),
    });
    expect(r.g_verified).toBe(0);
  });
  it('the receipt status is null (pending or unknown)', async () => {
    const r = await resolve({ ...base, getReceipt: async () => ({ status: null, blockNumber: null, logs: [] }) });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('tx_failed');
  });
  it('the transfer amount is not hex', async () => {
    const bad = { ...usdc(PAYER, WALLET_A, ONE_USDC), data: '0xzz' };
    const r = await resolve(chain([bad]));
    expect(r.g_verified).toBe(0);
  });
});
