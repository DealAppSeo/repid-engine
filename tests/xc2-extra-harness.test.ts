/**
 * XC2 S4 extra harness cases. Follow-up to #754 — does not edit src/scoring.
 * SYNTHETIC ids only. E7/E8/E9.
 */
import {
  BASE_SEPOLIA_USDC,
  createMemoryGroundingStore,
  resolveGrounding,
  type ChainReader,
} from '../src/scoring/grounding';

const AGENT = '00000000-0000-4000-8000-0000000000c7';
const WALLET = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'c7'.repeat(32);

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
function chain(units: bigint, payee: string = WALLET): ChainReader {
  return {
    chainId: 84532,
    async getTransaction() {
      return { hash: TX, from: PAYER, to: BASE_SEPOLIA_USDC, value: 0n, blockNumber: 1 };
    },
    async getReceipt() {
      return { status: 1, blockNumber: 1, logs: [log(PAYER, payee, units)] };
    },
  };
}

describe('XC2 extra harness cases (E7/E8/E9)', () => {
  it('E7 same evidence_id different event_type is reused (unique is evidence-only)', async () => {
    const store = createMemoryGroundingStore();
    const evidence = { kind: 'payment' as const, txHash: TX };
    const a = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence,
      agentWallets: [WALLET],
      store,
      chain: chain(100_001n),
    });
    const b = await resolveGrounding({
      agentId: AGENT,
      eventType: 'SERVICE_FULFILLED',
      evidence,
      agentWallets: [WALLET],
      store,
      chain: chain(100_001n),
    });
    expect(a.g_verified).toBe('high');
    expect(b.g_verified).toBe(0);
    expect(b.reused).toBe(true);
  });

  it('E8 exclusive floor: 100_000 does not ground, 100_001 does', async () => {
    const atFloor = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: '0x' + 'e8'.repeat(32) },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chain(100_000n),
    });
    expect(atFloor.g_verified).toBe(0);
    expect(atFloor.reason).toBe('below_floor');

    const above = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: '0x' + 'e9'.repeat(32) },
      agentWallets: [WALLET],
      store: createMemoryGroundingStore(),
      chain: chain(100_001n),
    });
    expect(above.g_verified).toBe('high');
  });

  it('E9 empty agentWallets cannot join a payment', async () => {
    const r = await resolveGrounding({
      agentId: AGENT,
      eventType: 'CODE_CONTRIBUTION',
      evidence: { kind: 'payment', txHash: TX },
      agentWallets: [],
      store: createMemoryGroundingStore(),
      chain: chain(100_001n),
    });
    expect(r.g_verified).toBe(0);
    expect(r.reason).toMatch(/parties_mismatch|no_wallets|empty/);
  });
});
