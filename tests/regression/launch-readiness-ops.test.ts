/**
 * Launch-readiness ops regression (CC1, 2026-05-25).
 *
 * Guards the PUBLIC hero receipt — the on-chain proof outside developers will
 * see — against typo/drift: tx hashes must be valid 32-byte hex, the Basescan
 * URLs must reference those exact hashes, and the core launch facts are pinned.
 * (The heartbeat + audit-probe scripts are DB-coupled ops tooling verified by
 * live runs; their core invariants — sim-flag / mock-tx / eligibility — are
 * covered in v1-critical-paths.test.ts.)
 */
import { HERO_RECEIPT } from '../../src/routes/v1/launch-status';

const TX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

describe('Launch-readiness — public hero receipt integrity', () => {
  it('settlement + attestation tx hashes are valid 32-byte hex', () => {
    expect(HERO_RECEIPT.usdc_settlement.tx).toMatch(TX32);
    expect(HERO_RECEIPT.reputation_attestation.tx).toMatch(TX32);
  });

  it('Basescan URLs reference the exact tx hashes (no drift/typo)', () => {
    expect(HERO_RECEIPT.usdc_settlement.basescan).toBe(`https://sepolia.basescan.org/tx/${HERO_RECEIPT.usdc_settlement.tx}`);
    expect(HERO_RECEIPT.reputation_attestation.basescan).toBe(`https://sepolia.basescan.org/tx/${HERO_RECEIPT.reputation_attestation.tx}`);
  });

  it('addresses are well-formed and the registry is the ERC-8004 ReputationRegistry', () => {
    expect(HERO_RECEIPT.operator_wallet).toMatch(ADDR);
    expect(HERO_RECEIPT.provider_wallet).toMatch(ADDR);
    expect(HERO_RECEIPT.reputation_attestation.registry).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
  });

  it('pins the verified launch facts (chain, value, repid delta)', () => {
    expect(HERO_RECEIPT.chain_id).toBe(84532);
    expect(HERO_RECEIPT.network).toBe('base-sepolia');
    expect(HERO_RECEIPT.value_usdc).toBe('0.10');
    expect(HERO_RECEIPT.repid_change).toEqual({ before: 2980, after: 3040 });
    expect(HERO_RECEIPT.usdc_settlement.tx).not.toBe(HERO_RECEIPT.reputation_attestation.tx);
  });
});
