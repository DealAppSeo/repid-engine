/**
 * Tests for the ZKP epoch anchor (sprint 2026-05-29).
 *
 * Pure-crypto tests (merkle root/proof, EAS calldata) need no DB. The
 * aggregate + verify-back paths mock src/db/direct-pg.pgQuery.
 *
 * NOTE: this is a keccak256 Merkle aggregation, NOT a Plonky3 recursive STARK
 * and NOT Poseidon2 leaves — see the Invariant-1 flag in zkp-epoch-anchor.ts.
 */

(global as any).__zk = { selectRows: [] as any[], updateReturn: [] as any[], loadRow: [] as any[] };

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: async (text: string) => {
    if (/UPDATE .*eas_attestation_uid/i.test(text)) return (global as any).__zk.updateReturn;
    if (/UPDATE .*merkle_root/i.test(text)) return (global as any).__zk.updateReturn;
    if (/WHERE id = \$1/i.test(text)) return (global as any).__zk.loadRow;        // verify load
    if (/SELECT id, zk_commitment/i.test(text)) return (global as any).__zk.selectRows; // epoch select
    return [];
  },
}));
jest.mock('../src/db', () => ({ db: {} }));

import { AbiCoder, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { buildMerkleRoot } from '../src/services/audit-merkle-anchor';
import {
  epochLeaf, buildMerkleProof, verifyMerkleProof,
  computeSchemaUid, buildEasAttestationRequest, EAS_SCHEMA_STRING, ANCHOR_DOMAIN,
  aggregateEpoch, verifyProofViaAnchor, dayEpoch,
} from '../src/services/zkp-epoch-anchor';

const epoch = { start: '2026-05-28T00:00:00.000Z', end: '2026-05-29T00:00:00.000Z', label: '2026-05-28' };

describe('merkle inclusion proof', () => {
  it('proof root equals buildMerkleRoot for every index (even count)', () => {
    const leaves = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(epochLeaf);
    const root = buildMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const p = buildMerkleProof(leaves, i);
      expect(p.root).toBe(root);
      expect(verifyMerkleProof(p)).toBe(true);
    }
  });

  it('handles odd leaf counts (Bitcoin-style duplicate) consistently', () => {
    const leaves = ['x', 'y', 'z', 'p', 'q'].map(epochLeaf); // 5 = odd
    const root = buildMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const p = buildMerkleProof(leaves, i);
      expect(p.root).toBe(root);
      expect(verifyMerkleProof(p)).toBe(true);
    }
  });

  it('single leaf: root == leaf, empty proof verifies', () => {
    const leaves = [epochLeaf('only')];
    expect(buildMerkleRoot(leaves)).toBe(leaves[0]);
    const p = buildMerkleProof(leaves, 0);
    expect(verifyMerkleProof(p)).toBe(true);
  });

  it('rejects a tampered leaf', () => {
    const leaves = ['a', 'b', 'c', 'd'].map(epochLeaf);
    const p = buildMerkleProof(leaves, 1);
    const tampered = { ...p, leaf: keccak256(toUtf8Bytes('evil')) };
    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it('epochLeaf is deterministic', () => {
    expect(epochLeaf('commitX')).toBe(epochLeaf('commitX'));
    expect(epochLeaf('commitX')).not.toBe(epochLeaf('commitY'));
  });
});

describe('EAS attestation construction', () => {
  it('schema UID is a deterministic 32-byte hash', () => {
    const a = computeSchemaUid(EAS_SCHEMA_STRING, '0x0000000000000000000000000000000000000000', true);
    const b = computeSchemaUid(EAS_SCHEMA_STRING, '0x0000000000000000000000000000000000000000', true);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('attest calldata decodes back to the epoch payload', () => {
    const root = '0x' + '11'.repeat(32);
    const req = buildEasAttestationRequest({ root, epoch: '2026-05-28', proofCount: 42, firstId: 100, lastId: 141 });

    // The inner data field decodes to the schema payload.
    const [domain, mr, ep, count, first, last] = AbiCoder.defaultAbiCoder().decode(
      ['string', 'bytes32', 'string', 'uint64', 'uint64', 'uint64'], req.encodedData,
    );
    expect(domain).toBe(ANCHOR_DOMAIN);
    expect(mr.toLowerCase()).toBe(root);
    expect(ep).toBe('2026-05-28');
    expect(Number(count)).toBe(42);
    expect(Number(first)).toBe(100);
    expect(Number(last)).toBe(141);

    // The calldata is a real EAS.attest(...) call carrying that schema + data.
    const iface = new Interface(['function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) external payable returns (bytes32)']);
    const decoded = iface.decodeFunctionData('attest', req.attestCalldata);
    expect(decoded[0].schema).toBe(req.schemaUid);
    expect(decoded[0].data.data).toBe(req.encodedData);
    expect(req.seanAction).toMatch(/SchemaRegistry|EAS/);
  });
});

describe('aggregate + verify-back (mocked pg)', () => {
  beforeEach(() => { (global as any).__zk = { selectRows: [], updateReturn: [], loadRow: [] }; });

  it('aggregateEpoch computes a non-null root and reports rows updated', async () => {
    const commits = Array.from({ length: 6 }, (_, i) => `commit-${i}`);
    (global as any).__zk.selectRows = commits.map((c, i) => ({ id: i + 1, zk_commitment: c }));
    (global as any).__zk.updateReturn = commits.map((_, i) => ({ id: i + 1 }));

    const r = await aggregateEpoch(epoch, { persist: true });
    expect(r.proof_count).toBe(6);
    expect(r.root).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(r.root).toBe(buildMerkleRoot(commits.map(epochLeaf)));
    expect(r.rows_updated).toBe(6);
    expect(r.persisted).toBe(true);
  });

  it('aggregateEpoch with no proofs returns ZeroHash, no update', async () => {
    (global as any).__zk.selectRows = [];
    const r = await aggregateEpoch(epoch, { persist: true });
    expect(r.proof_count).toBe(0);
    expect(r.rows_updated).toBe(0);
  });

  it('verifyProofViaAnchor confirms membership against the stored root', async () => {
    const commits = Array.from({ length: 5 }, (_, i) => `c${i}`);
    const rows = commits.map((c, i) => ({ id: i + 1, zk_commitment: c }));
    const root = buildMerkleRoot(commits.map(epochLeaf));
    (global as any).__zk.selectRows = rows;
    // proof id 3 (created in this epoch), stored merkle_root = the real root.
    (global as any).__zk.loadRow = [{ id: 3, tier_proven: 'ESTABLISHED', merkle_root: root, eas_attestation_uid: '0xuid', created_at: '2026-05-28T12:00:00.000Z' }];

    const v = await verifyProofViaAnchor(3);
    expect(v.verified).toBe(true);
    expect(v.tier_proven).toBe('ESTABLISHED');
    expect(v.merkle_root).toBe(root);
    expect(v.inclusion).not.toBeNull();
  });

  it('verifyProofViaAnchor fails closed when merkle_root is null (not yet aggregated)', async () => {
    (global as any).__zk.loadRow = [{ id: 9, tier_proven: 'EARNING', merkle_root: null, eas_attestation_uid: null, created_at: '2026-05-28T12:00:00.000Z' }];
    const v = await verifyProofViaAnchor(9);
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/not yet aggregated/);
  });

  it('dayEpoch produces UTC-day bounds', () => {
    const e = dayEpoch(new Date('2026-05-28T15:30:00.000Z'));
    expect(e).toEqual({ start: '2026-05-28T00:00:00.000Z', end: '2026-05-29T00:00:00.000Z', label: '2026-05-28' });
  });
});
