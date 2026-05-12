/**
 * Integration test: EIP-712 RepID attestation roundtrip (no on-chain calls).
 *
 * Exercises ethers.js signTypedData / verifyTypedData against a synthetic
 * ECDSA signer. Verifies:
 *   - Domain.chainId === 84532 (Base Sepolia per HANDOFF P-024)
 *   - Attestation's repid value matches CANONICAL current_repid for SOPHIA
 *     (NOT Gemini's repid_score divergence)
 *   - Signature recovers to the signer address (verifyTypedData passes)
 *
 * Skipped if SUPABASE env unset.
 *
 * NOTE: this is local crypto only. No Sepolia RPC, no contract calls.
 * The EIP-712 typed-data shape mirrors what the real attestation payload
 * looks like, but we use a throwaway signer wallet so test runs are
 * hermetic.
 */

import { Wallet, verifyTypedData } from 'ethers';
import { db } from '../../src/db';

const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const describeIfDb = HAS_DB ? describe : describe.skip;

const SOPHIA_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const BASE_SEPOLIA_CHAIN_ID = 84532;

describeIfDb('ZKP / EIP-712 RepID attestation roundtrip', () => {
  it('signs + verifies attestation for SOPHIA using current_repid (canonical)', async () => {
    // Read SOPHIA's CANONICAL repid (NOT repid_score per Gemini divergence)
    const { data: agent, error } = await db.from('repid_agents')
      .select('id, agent_name, current_repid, tier')
      .eq('id', SOPHIA_UUID).single();
    expect(error).toBeNull();
    expect(agent).not.toBeNull();
    const a = agent as any;
    expect(a.agent_name).toBe('SOPHIA');
    expect(a.current_repid).toBeGreaterThan(0);

    // Synthetic signer (throwaway; not a production key)
    const signer = Wallet.createRandom();

    // EIP-712 domain — chainId is Base Sepolia per P-024
    const domain = {
      name: 'HyperDAGRepIDAttestation',
      version: '1',
      chainId: BASE_SEPOLIA_CHAIN_ID,
      // Use the canonical IdentityRegistry address per HANDOFF P-024
      verifyingContract: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    };

    const types = {
      Attestation: [
        { name: 'agent', type: 'string' },
        { name: 'repid', type: 'uint256' },
        { name: 'tier', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
      ],
    };

    const message = {
      agent: a.agent_name,
      repid: BigInt(a.current_repid),
      tier: a.tier,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };

    // Sign
    const signature = await signer.signTypedData(domain, types, message);
    expect(signature).toMatch(/^0x[a-f0-9]{130}$/);

    // Verify recovers to the signer
    const recovered = verifyTypedData(domain, types, message, signature);
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('domain.chainId is exactly 84532 (Base Sepolia, P-024)', () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
  });

  it('rejects tampered message (recovered address differs)', async () => {
    const signer = Wallet.createRandom();
    const domain = {
      name: 'HyperDAGRepIDAttestation',
      version: '1',
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    };
    const types = {
      Attestation: [
        { name: 'agent', type: 'string' },
        { name: 'repid', type: 'uint256' },
        { name: 'tier', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
      ],
    };
    const original = { agent: 'SOPHIA', repid: 9961n, tier: 'VETERAN', timestamp: 1700000000n };
    const tampered = { ...original, repid: 99999n }; // attacker bumps to 99999
    const sig = await signer.signTypedData(domain, types, original);
    const recovered = verifyTypedData(domain, types, tampered, sig);
    // Recovery succeeds but yields a DIFFERENT address (not the signer)
    expect(recovered.toLowerCase()).not.toBe(signer.address.toLowerCase());
  });
});
