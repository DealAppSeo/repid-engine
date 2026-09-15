/**
 * LOOP X9 — attack the C8 grounding pipeline. Assume it is wrong.
 * SYNTHETIC fixtures only.
 */
import {
  BASE_SEPOLIA_USDC,
  GROUNDING_FLOOR_USD,
  createMemoryGroundingStore,
  resolveGrounding,
  type ChainReader,
} from '../src/scoring/grounding';

const AGENT_A = '00000000-0000-4000-8000-0000000000f1';
const AGENT_B = '00000000-0000-4000-8000-0000000000f2';
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ee'.repeat(32);

function padAddr(a: string) {
  return '0x' + a.slice(2).toLowerCase().padStart(64, '0');
}
function log(from: string, to: string, units: bigint) {
  return {
    address: BASE_SEPOLIA_USDC,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      padAddr(from),
      padAddr(to),
    ],
    data: '0x' + units.toString(16).padStart(64, '0'),
  };
}
function chainTo(to: string, units: bigint): ChainReader {
  return {
    chainId: 84532,
    async getTransaction() {
      return { hash: TX, from: PAYER, to: BASE_SEPOLIA_USDC, value: 0n, blockNumber: 1 };
    },
    async getReceipt() {
      return { status: 1, blockNumber: 1, logs: [log(PAYER, to, units)] };
    },
  };
}

describe('X9 attacks on C8', () => {
  it('A1 forge a real-but-unrelated tx — parties must join the agent', async () => {
    const r = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX },
      agentWallets: [WALLET_A],
      store: createMemoryGroundingStore(),
      chain: chainTo(STRANGER, 100_000n),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('parties_mismatch');
  });

  it('A2 reuse one settlement across many agents (unique is per-agent — this is the hole)', async () => {
    const store = createMemoryGroundingStore();
    const evidence = { kind: 'payment' as const, txHash: TX };
    const a = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence,
      agentWallets: [WALLET_A],
      store,
      chain: chainTo(WALLET_A, 100_000n),
    });
    const b = await resolveGrounding({
      agentId: AGENT_B,
      eventType: 'CODE_CONTRIBUTION',
      evidence,
      agentWallets: [WALLET_B],
      store,
      // same tx, but this agent is not a party — still tests the unique key.
      chain: chainTo(WALLET_B, 100_000n),
    });
    expect(a.g_verified).toBe('high');
    // Specified unique is (evidence, agent, event_type), so agent B is a new key.
    // X9 reports this as FAIL (accepted): evidence-alone would have blocked it.
    expect(b.g_verified).toBe('high');
    expect(b.reused).toBe(false);
  });

  it('A3 $0.10 wash loop — floor is inclusive, cheapest grounded wash is $0.10', async () => {
    const r = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX },
      agentWallets: [WALLET_A],
      store: createMemoryGroundingStore(),
      chain: chainTo(WALLET_A, 100_000n),
    });
    expect(r.g_verified).toBe('high');
    expect(r.amount_usd).toBeCloseTo(GROUNDING_FLOOR_USD);
  });

  it('A4 HAL verdict hash for an artifact that was never judged', async () => {
    const r = await resolveGrounding({
      agentId: AGENT_A,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'validation', verdictHash: '0xdead', artifactHash: '0xbeef' },
      agentWallets: [WALLET_A],
      store: createMemoryGroundingStore(),
      validationLookup: {
        async getByVerdictHash() {
          return null;
        },
      },
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toBe('verdict_not_found');
  });

  it('A5 race: two identical grounded events — unique holds under concurrency', async () => {
    const store = createMemoryGroundingStore();
    const evidence = { kind: 'payment' as const, txHash: TX };
    const call = () =>
      resolveGrounding({
        agentId: AGENT_A,
        eventType: 'CODE_CONTRIBUTION',
        evidence,
        agentWallets: [WALLET_A],
        store,
        chain: chainTo(WALLET_A, 100_000n),
      });
    const [x, y] = await Promise.all([call(), call()]);
    const highs = [x, y].filter((r) => r.g_verified === 'high');
    const dups = [x, y].filter((r) => r.reused);
    expect(highs).toHaveLength(1);
    expect(dups).toHaveLength(1);
  });
});
