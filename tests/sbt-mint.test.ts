/**
 * SBT mint — unit tests.
 *
 * No external network. Uses ethers.Wallet to produce real signatures
 * over deterministic challenges. The mintSBT() call is exercised only
 * in mock mode so no RPC or DB write actually happens (the service
 * tries them but Supabase failures are swallowed; we don't assert on
 * DB side-effects).
 */

// Mock db so mintSBT's optional Supabase + audit-chain calls don't
// attempt real network. The service swallows DB errors anyway, but we
// still want the tests to be deterministic and fast.
jest.mock('../src/db', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    ilike: () => builder,
    in: () => builder,
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
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
  issueChallenge,
  verifySignedChallenge,
  mintSBT,
} from '../src/services/sbt-mint';

beforeAll(() => {
  process.env.SBT_MINT_MOCK = '1';
  // Ensure a stable PROOF_SECRET is in place even when .env is dummy.
  process.env.PROOF_SECRET = process.env.PROOF_SECRET || 'test-secret';
});

describe('sbt-mint — challenge issuance', () => {
  it('issues a challenge containing the holder address and protocol version', () => {
    const wallet = ethers.Wallet.createRandom();
    const c = issueChallenge(wallet.address);
    expect(c.challenge).toContain(ethers.getAddress(wallet.address));
    expect(c.challenge).toContain('hyperdag-sbt/v0.1');
    expect(c.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c.message_to_sign).toBe(c.challenge);
  });

  it('rejects an invalid holder address', () => {
    expect(() => issueChallenge('not-a-wallet')).toThrow(/invalid holder/);
  });
});

describe('sbt-mint — signature verification', () => {
  it('accepts a correctly-signed challenge', async () => {
    const wallet = ethers.Wallet.createRandom();
    const c = issueChallenge(wallet.address);
    const sig = await wallet.signMessage(c.challenge);
    const r = verifySignedChallenge(wallet.address, sig);
    expect(r.ok).toBe(true);
  });

  it('rejects when no challenge has been issued', () => {
    const wallet = ethers.Wallet.createRandom();
    const r = verifySignedChallenge(wallet.address, '0xdeadbeef');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_challenge');
  });

  it('rejects when the signature is for a different holder', async () => {
    const a = ethers.Wallet.createRandom();
    const b = ethers.Wallet.createRandom();
    const c = issueChallenge(a.address);
    const sig = await b.signMessage(c.challenge);    // signed by B, not A
    const r = verifySignedChallenge(a.address, sig);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it('challenges are one-time-use', async () => {
    const wallet = ethers.Wallet.createRandom();
    const c = issueChallenge(wallet.address);
    const sig = await wallet.signMessage(c.challenge);
    expect(verifySignedChallenge(wallet.address, sig).ok).toBe(true);
    // Second attempt fails because the challenge was consumed.
    expect(verifySignedChallenge(wallet.address, sig).ok).toBe(false);
  });
});

describe('sbt-mint — mock mint flow', () => {
  it('returns is_mock=true with explicit notes', async () => {
    const wallet = ethers.Wallet.createRandom();
    const c = issueChallenge(wallet.address);
    const sig = await wallet.signMessage(c.challenge);
    const r = await mintSBT({
      holder_address: wallet.address,
      signed_challenge: sig,
    });
    expect(r.ok).toBe(true);
    expect(r.is_mock).toBe(true);
    expect(r.status).toBe('mock');
    expect(r.notes).toContain('MOCK_MINT');
    expect(r.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.token_id).toMatch(/^\d+$/);
    expect(r.rep_id_commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.metadata_inline).toBe(true);
  });

  it('rejects an invalid holder address', async () => {
    const r = await mintSBT({
      holder_address: 'nope',
      signed_challenge: '0xdeadbeef',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid holder/i);
  });

  it('rejects a missing signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const r = await mintSBT({
      holder_address: wallet.address,
      signed_challenge: 'not-a-real-signature',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/challenge/i);
  });

  it('two mock mints for the same holder produce different tokenIds (different commitments via random nonce)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const sig1 = await wallet.signMessage(issueChallenge(wallet.address).challenge);
    const r1 = await mintSBT({ holder_address: wallet.address, signed_challenge: sig1 });
    const sig2 = await wallet.signMessage(issueChallenge(wallet.address).challenge);
    const r2 = await mintSBT({ holder_address: wallet.address, signed_challenge: sig2 });
    expect(r1.token_id).not.toBe(r2.token_id);
    expect(r1.rep_id_commitment).not.toBe(r2.rep_id_commitment);
  });
});
