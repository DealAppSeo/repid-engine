/**
 * LOOP C8 — grounding multiplier (shadow). SYNTHETIC fixtures only.
 */
import {
  BASE_SEPOLIA_USDC,
  GROUNDING_FLOOR_USD,
  createMemoryGroundingStore,
  evidenceIdOf,
  resolveGrounding,
  type ChainReader,
  type ChainReceipt,
  type ChainTx,
  type GroundingEvidence,
} from '../src/scoring/grounding';

const AGENT = '00000000-0000-4000-8000-0000000000a1';
const WALLET = '0x1111111111111111111111111111111111111111';
const COUNTERPARTY = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);

function transferLog(from: string, to: string, units: bigint) {
  const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  return {
    address: BASE_SEPOLIA_USDC,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      pad(from),
      pad(to),
    ],
    data: '0x' + units.toString(16).padStart(64, '0'),
  };
}

function chainWith(opts: {
  tx?: ChainTx | null;
  receipt?: ChainReceipt | null;
  simulated?: boolean;
}): ChainReader {
  return {
    chainId: 84532,
    isSimulatedTx: () => !!opts.simulated,
    async getTransaction() {
      return opts.tx === undefined
        ? {
            hash: TX,
            from: COUNTERPARTY,
            to: BASE_SEPOLIA_USDC,
            value: 0n,
            blockNumber: 1,
          }
        : opts.tx;
    },
    async getReceipt() {
      return opts.receipt === undefined
        ? { status: 1, blockNumber: 1, logs: [transferLog(COUNTERPARTY, WALLET, 100_001n)] }
        : opts.receipt;
    },
  };
}

const payment: GroundingEvidence = { kind: 'payment', txHash: TX };

describe('C8 grounding resolver', () => {
  it('ungrounded evidence is g_verified=0', async () => {
    const r = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: null,
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('ungrounded');
  });

  it('a fabricated but well-formed tx_hash is REJECTED, not stored as grounded', async () => {
    const store = createMemoryGroundingStore();
    const r = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: payment,
      agentWallets: [WALLET],
      store,
      chain: chainWith({ tx: null, receipt: null }),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('tx_not_found');
    expect(await store.findClaim(evidenceIdOf(payment), AGENT, 'CODE_CONTRIBUTION')).toBeNull();
  });

  it('the same evidence submitted twice grounds once', async () => {
    const store = createMemoryGroundingStore();
    const deps = {
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION' as const,
      evidence: payment,
      agentWallets: [WALLET],
      store,
      chain: chainWith({}),
    };
    const first = await resolveGrounding(deps);
    const second = await resolveGrounding(deps);
    expect(first.g_verified).toBe('high');
    expect(second.g_verified).toBe(0);
    expect(second.reused).toBe(true);
    expect(second.reason).toBe('duplicate_evidence');
  });

  it('a $0.001 real settlement does NOT ground; the $0.10 bound is exclusive', async () => {
    const dust = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: payment,
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chainWith({
        receipt: { status: 1, blockNumber: 1, logs: [transferLog(COUNTERPARTY, WALLET, 1000n)] },
      }),
    });
    expect(GROUNDING_FLOOR_USD).toBe(0.1);
    expect(dust.g_verified).toBe(0);
    expect(dust.reason).toBe('below_floor');
    expect(dust.amount_usd).toBeCloseTo(0.001);

    const floor = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: '0x' + 'cd'.repeat(32) },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chainWith({
        receipt: { status: 1, blockNumber: 1, logs: [transferLog(COUNTERPARTY, WALLET, 100_000n)] },
      }),
    });
    expect(floor.g_verified).toBe(0);
    expect(floor.reason).toBe('below_floor');
    expect(floor.amount_usd).toBeCloseTo(0.1);

    const above = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: '0x' + '11'.repeat(32) },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chainWith({
        receipt: { status: 1, blockNumber: 1, logs: [transferLog(COUNTERPARTY, WALLET, 100_001n)] },
      }),
    });
    expect(above.g_verified).toBe('high');
  });

  it('simulated settlements never ground', async () => {
    const r = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX, isSimulated: true },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chainWith({}),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('simulated');
  });

  it('HAL verdict hash is bound to the artifact it judged', async () => {
    const ok = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'validation', verdictHash: '0xvv', artifactHash: '0xaa' },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      validationLookup: {
        async getByVerdictHash() {
          return { verdictHash: '0xvv', artifactHash: '0xaa' };
        },
      },
    });
    expect(ok.g_verified).toBe('high');

    const unbound = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'validation', verdictHash: '0xvv', artifactHash: '0xdead' },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      validationLookup: {
        async getByVerdictHash() {
          return { verdictHash: '0xvv', artifactHash: '0xaa' };
        },
      },
    });
    expect(unbound.g_verified).toBe(0);
    expect(unbound.reason).toBe('artifact_unbound');
  });
});
