/**
 * RepID threshold proof — unit tests.
 *
 * No external network. Tests focus on the pure helpers (commitment
 * derivation, mock proof generation) and the verify-threshold path
 * with witnesses supplied.
 *
 * The proveThreshold() entry point is also tested in mock-mode end-
 * to-end. It depends on a Supabase connection for fetchHolderRepId();
 * when the connection fails, the function falls through to repId=0
 * (per spec: every new holder starts at 0). The tests below tolerate
 * that behaviour.
 */

// Mock the db module BEFORE importing the service so the service's
// internal Supabase calls hit the mock instead of attempting real
// network. Per the sprint rule "Tests run on npm test without external
// network calls (use mocks)".
jest.mock('../src/db', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    ilike: () => builder,
    in: () => builder,
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: () => builder,
      rpc: async () => ({ data: [{ id: 1, current_entry_hash: 'mock-hash' }], error: null }),
    },
  };
});

import { ethers } from 'ethers';
import {
  proveThreshold,
  verifyThreshold,
  _internals,
} from '../src/services/repid-zkp-threshold';

beforeAll(() => {
  process.env.PROOF_SECRET = process.env.PROOF_SECRET || 'test-secret';
});

describe('repid-zkp-threshold — internals', () => {
  it('holderCommitment is deterministic for the same (holder, nonce)', () => {
    const holder = ethers.Wallet.createRandom().address;
    const nonce = '0x' + '11'.repeat(32);
    const a = _internals.holderCommitment(holder, nonce);
    const b = _internals.holderCommitment(holder, nonce);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('holderCommitment differs when nonce differs', () => {
    const holder = ethers.Wallet.createRandom().address;
    const a = _internals.holderCommitment(holder, '0x' + '00'.repeat(32));
    const b = _internals.holderCommitment(holder, '0x' + '11'.repeat(32));
    expect(a).not.toBe(b);
  });

  it('defaultNonceFor is deterministic per holder', () => {
    const w = ethers.Wallet.createRandom();
    expect(_internals.defaultNonceFor(w.address)).toBe(_internals.defaultNonceFor(w.address));
  });

  it('mock proof is deterministic for same inputs', () => {
    const holder = ethers.Wallet.createRandom().address;
    const nonce = '0xdead' + '00'.repeat(30);
    const p1 = _internals.generateMockProof(5000, holder, 6000, nonce);
    const p2 = _internals.generateMockProof(5000, holder, 6000, nonce);
    expect(p1).toBe(p2);
  });

  it('mock proof differs when threshold differs', () => {
    const holder = ethers.Wallet.createRandom().address;
    const nonce = '0xdead' + '00'.repeat(30);
    expect(_internals.generateMockProof(5000, holder, 6000, nonce))
      .not.toBe(_internals.generateMockProof(7000, holder, 6000, nonce));
  });
});

describe('repid-zkp-threshold — proveThreshold (mock mode)', () => {
  it('rejects an invalid holder address', async () => {
    const r = await proveThreshold({ holder: 'nope', threshold: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid holder/i);
  });

  it('rejects out-of-range threshold', async () => {
    const r = await proveThreshold({ holder: ethers.Wallet.createRandom().address, threshold: 99999 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/threshold/i);
  });

  it('returns mock_proof=true on success', async () => {
    // Use a holder we know has repId=0 (random wallet, no DB rows).
    // Threshold 0 is met trivially.
    const r = await proveThreshold({ holder: ethers.Wallet.createRandom().address, threshold: 0 });
    expect(r.mock_proof).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.threshold_met).toBe(true);
    expect(r.proof_bytes).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(r.public_signals?.threshold).toBe(0);
    expect(r.public_signals?.holder_commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.notes).toContain('MOCK_PROOF');
  });

  it('returns ok=false with witness_invalid when threshold > rep id', async () => {
    // Random wallet → no DB rows → repId=0; threshold=1 should fail.
    const r = await proveThreshold({ holder: ethers.Wallet.createRandom().address, threshold: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('witness_invalid_R_lt_T');
    expect(r.threshold_met).toBe(false);
    expect(r.proof_bytes).toBeNull();
  });
});

describe('repid-zkp-threshold — verifyThreshold (mock mode)', () => {
  it('roundtrip: prove + verify with matching witness returns valid=true', async () => {
    const wallet = ethers.Wallet.createRandom();
    const proof = await proveThreshold({ holder: wallet.address, threshold: 0 });
    expect(proof.ok).toBe(true);

    const witness = {
      holder: wallet.address,
      nonce: _internals.defaultNonceFor(wallet.address),
      rep_id: 0,
    };
    const r = await verifyThreshold({
      proof_bytes: proof.proof_bytes!,
      public_signals: proof.public_signals!,
      _witness: witness,
    });
    expect(r.valid).toBe(true);
    expect(r.on_chain_verifiable).toBe(false);     // stub
    expect(r.notes).toContain('MOCK_PROOF');
  });

  it('rejects when witness commitment does not match public commitment', async () => {
    const wallet = ethers.Wallet.createRandom();
    const proof = await proveThreshold({ holder: wallet.address, threshold: 0 });
    const r = await verifyThreshold({
      proof_bytes: proof.proof_bytes!,
      public_signals: proof.public_signals!,
      _witness: {
        holder: wallet.address,
        nonce: '0xdeadbeef' + '00'.repeat(28),     // wrong nonce
        rep_id: 0,
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('commitment_mismatch');
  });

  it('rejects when witness rep_id is below threshold', async () => {
    const wallet = ethers.Wallet.createRandom();
    const proof = await proveThreshold({ holder: wallet.address, threshold: 0 });
    const r = await verifyThreshold({
      proof_bytes: proof.proof_bytes!,
      public_signals: { threshold: 9999, holder_commitment: proof.public_signals!.holder_commitment },
      _witness: {
        holder: wallet.address,
        nonce: _internals.defaultNonceFor(wallet.address),
        rep_id: 0,
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('threshold_not_met');
  });

  it('rejects when no witness is supplied', async () => {
    const wallet = ethers.Wallet.createRandom();
    const proof = await proveThreshold({ holder: wallet.address, threshold: 0 });
    const r = await verifyThreshold({
      proof_bytes: proof.proof_bytes!,
      public_signals: proof.public_signals!,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('witness_required_for_stub');
  });
});
