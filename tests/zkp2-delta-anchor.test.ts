/**
 * tests/zkp2-delta-anchor.test.ts
 *
 * The EAS anchoring path for RepID delta statements: what a batch root commits to,
 * that inclusion round-trips, and that nothing can send a transaction.
 *
 * The first describe block is a MEASUREMENT, not an assertion of taste: it runs the
 * existing `buildRoot` from `merkle-root.ts` and shows that a 3-leaf batch and a
 * 4-leaf batch whose last leaf is repeated produce the identical root (CVE-2012-2459).
 * That is the reason this module builds its own tree over the same audited Poseidon2
 * primitives instead of reusing that one, and the reason is checked rather than
 * claimed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRoot, getHashScheme } from '../src/zkp/merkle-root';
import {
  DELTA_ANCHOR_LEAF_TAG,
  REPID_DELTA_ANCHOR_DOMAIN,
  REPID_DELTA_ANCHOR_EAS_SCHEMA,
  REPID_DELTA_ANCHOR_PROOF_TYPE,
  anchorDeltaBatch,
  buildDeltaAnchor,
  buildDeltaAnchorAttestation,
  buildDeltaInclusion,
  deltaAnchorLeaf,
  deltaTreeRoot,
  verifyDeltaInclusion,
  type DeltaAnchorAttestation,
} from '../src/zkp/delta-anchor';
import { REPID_DELTA_DOMAIN, statementDigest, DELTA_BAND_MIN, DELTA_BAND_MAX } from '../src/zkp/repid-delta-statement';

const HEX32 = /^0x[0-9a-f]{64}$/;
const FORMULA = '0x' + '22'.repeat(32);

/** Real statement digests, produced by the frozen statement encoder. */
function digests(n: number, formula = FORMULA): string[] {
  return Array.from({ length: n }, (_, i) =>
    statementDigest({
      domain: REPID_DELTA_DOMAIN,
      agent_commitment: '0x' + '11'.repeat(32),
      identity_commitment: '0x' + '55'.repeat(32),
      delta_applied: 3,
      score_before: 1611,
      score_after: 1614,
      band_min: DELTA_BAND_MIN,
      band_max: DELTA_BAND_MAX,
      formula_commitment: formula,
      nullifier: '0x' + (i % 2 === 0 ? '66' : '77').repeat(32).slice(0, 62) + i.toString(16).padStart(2, '0'),
    }),
  );
}

const anchor = (n: number, extra: Partial<Parameters<typeof buildDeltaAnchor>[0]> = {}) =>
  buildDeltaAnchor({
    statementDigests: digests(n),
    domain: REPID_DELTA_DOMAIN,
    formulaCommitment: FORMULA,
    epoch: 7,
    ...extra,
  });

// ---------------------------------------------------------------------------
// The measured reason this module does not reuse buildRoot
// ---------------------------------------------------------------------------

describe('MEASURED: merkle-root.ts buildRoot cannot distinguish N from N+1 (CVE-2012-2459)', () => {
  const s = getHashScheme('poseidon2');
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => s.leaf('stmt-' + i));

  it('a 3-leaf batch and a 4-leaf batch with the last repeated share a root', () => {
    const three = leaves(3);
    const fourWithDup = [...three, three[2]!];
    expect(buildRoot(fourWithDup, s.pair)).toBe(buildRoot(three, s.pair));
  });

  it('same at 5 vs 6 — it is the odd-level rule, not one unlucky size', () => {
    const five = leaves(5);
    expect(buildRoot([...five, five[4]!], s.pair)).toBe(buildRoot(five, s.pair));
  });

  it('deltaTreeRoot promotes instead of duplicating, so the collision has no expression', () => {
    const three = leaves(3);
    expect(deltaTreeRoot([...three, three[2]!])).not.toBe(deltaTreeRoot(three));
  });

  it('and the anchor binds the count on top of that', () => {
    const d = digests(3);
    // Even a duplicate is refused outright before the count matters.
    expect(() =>
      buildDeltaAnchor({
        statementDigests: [...d, d[2]!],
        domain: REPID_DELTA_DOMAIN,
        formulaCommitment: FORMULA,
        epoch: 7,
      }),
    ).toThrow(/duplicate statement digest/);
  });

  it('buildRoot is NOT modified — the live POSTCARD epoch anchor still gets its shape', () => {
    // 4,573 rows already carry a merkle_root computed by this function [V SQL 2026-08-04].
    // Changing it here would invalidate them; this test exists so a future edit is loud.
    const src = readFileSync(join(__dirname, '..', 'src', 'zkp', 'merkle-root.ts'), 'utf8');
    expect(src).toMatch(/i \+ 1 < level\.length \? level\[i \+ 1\]! : left; \/\/ odd → duplicate/);
  });
});

// ---------------------------------------------------------------------------
// What the root commits to
// ---------------------------------------------------------------------------

describe('the anchor root binds all five committed things', () => {
  const base = anchor(5);

  it('is a canonical 32-byte digest', () => {
    expect(base.root).toMatch(HEX32);
    expect(base.treeRoot).toMatch(HEX32);
    expect(base.root).not.toBe(base.treeRoot); // the header is really absorbed
  });

  it('1. the ordered list — reordering the same digests changes the root', () => {
    const d = digests(5);
    const reordered = [d[1]!, d[0]!, d[2]!, d[3]!, d[4]!];
    expect(
      buildDeltaAnchor({
        statementDigests: reordered,
        domain: REPID_DELTA_DOMAIN,
        formulaCommitment: FORMULA,
        epoch: 7,
      }).root,
    ).not.toBe(base.root);
  });

  it('2. the count', () => {
    expect(anchor(4).root).not.toBe(base.root);
  });

  it('3. the domain — a batch cannot be replayed into another vertical', () => {
    expect(anchor(5, { domain: 'hyperdag/health/consent/v1' }).root).not.toBe(base.root);
  });

  it('4. the formula commitment — a re-scored epoch cannot hide under the same root', () => {
    expect(anchor(5, { formulaCommitment: '0x' + '33'.repeat(32) }).root).not.toBe(base.root);
  });

  it('5. the epoch and the optional range', () => {
    expect(anchor(5, { epoch: 8 }).root).not.toBe(base.root);
    const ranged = anchor(5, { range: { firstLabel: 'evt:1', lastLabel: 'evt:5' } });
    expect(ranged.root).not.toBe(base.root);
    // "no range" is a committed choice, not a hole: an absent range absorbs the empty
    // string, so it cannot be confused with any present range.
    expect(anchor(5, { range: { firstLabel: '', lastLabel: '' } }).root).not.toBe(base.root);
  });

  it('the leaf is domain-separated from the statement digest and from a node', () => {
    const d = digests(1)[0]!;
    const leaf = deltaAnchorLeaf(d, REPID_DELTA_DOMAIN);
    expect(leaf).not.toBe(d);
    expect(leaf).not.toBe(deltaAnchorLeaf(d, 'hyperdag/health/consent/v1'));
    expect(DELTA_ANCHOR_LEAF_TAG).toMatch(/leaf/);
    // No internal node of a real tree equals any leaf of it.
    const a = anchor(6);
    expect(new Set(a.leaves).has(a.treeRoot)).toBe(false);
  });

  it('refuses an empty batch, a bad formula commitment, and a bad epoch', () => {
    expect(() =>
      buildDeltaAnchor({ statementDigests: [], domain: 'd', formulaCommitment: FORMULA, epoch: 1 }),
    ).toThrow(/empty batch/);
    expect(() =>
      buildDeltaAnchor({ statementDigests: digests(1), domain: 'd', formulaCommitment: '0xzz', epoch: 1 }),
    ).toThrow(/formula commitment/);
    expect(() =>
      buildDeltaAnchor({ statementDigests: digests(1), domain: 'd', formulaCommitment: FORMULA, epoch: -1 }),
    ).toThrow(/epoch/);
  });

  it('refuses a leaf built from something that is not a statement digest', () => {
    expect(() => deltaAnchorLeaf('0xdeadbeef', 'd')).toThrow(/0x\+64 hex/);
  });
});

// ---------------------------------------------------------------------------
// Inclusion
// ---------------------------------------------------------------------------

describe('inclusion round-trips at every size and every index', () => {
  // 1..9 covers a perfect tree, and every promotion pattern an odd level produces.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    it(`n=${n}: every leaf verifies against the anchored root`, () => {
      const a = anchor(n, { range: { firstLabel: 'evt:0', lastLabel: `evt:${n - 1}` } });
      for (let i = 0; i < n; i++) {
        const proof = buildDeltaInclusion(a, i);
        const v = verifyDeltaInclusion(proof);
        expect(v.reason).toBeNull();
        expect(v.included).toBe(true);
        expect(proof.statementDigest).toBe(a.statementDigests[i]);
      }
    });
  }

  it('a tampered digest fails with a reason, never a bare false', () => {
    const a = anchor(5);
    const proof = buildDeltaInclusion(a, 2);
    const v = verifyDeltaInclusion({ ...proof, statementDigest: '0x' + '99'.repeat(32) });
    expect(v.included).toBe(false);
    expect(v.reason).toMatch(/does not match/);
  });

  it('a proof re-labelled with a different domain, formula, epoch or count fails', () => {
    const a = anchor(5);
    const p = buildDeltaInclusion(a, 1);
    for (const mutated of [
      { ...p, domain: 'hyperdag/health/consent/v1' },
      { ...p, formulaCommitment: '0x' + '33'.repeat(32) },
      { ...p, epoch: 8 },
      { ...p, leafCount: 6 },
      { ...p, range: { firstLabel: 'x', lastLabel: 'y' } },
    ]) {
      expect(verifyDeltaInclusion(mutated).included).toBe(false);
    }
  });

  it('a sibling swapped between positions fails', () => {
    const a = anchor(4);
    const p = buildDeltaInclusion(a, 0);
    const flipped = p.siblings.map((s) => ({
      hash: s.hash,
      position: (s.position === 'left' ? 'right' : 'left') as 'left' | 'right',
    }));
    expect(verifyDeltaInclusion({ ...p, siblings: flipped }).included).toBe(false);
  });

  it('is TOTAL — malformed input from outside is a reason, not a throw', () => {
    const a = anchor(3);
    const p = buildDeltaInclusion(a, 0);
    expect(verifyDeltaInclusion({ ...p, statementDigest: 'nope' }).reason).toMatch(/not 0x\+64 hex/);
    expect(verifyDeltaInclusion({ ...p, root: 'nope' }).reason).toMatch(/root is not/);
    expect(verifyDeltaInclusion({ ...p, leafCount: 0 }).reason).toMatch(/leafCount/);
    expect(verifyDeltaInclusion({ ...p, index: 99 }).reason).toMatch(/out of range/);
    expect(
      verifyDeltaInclusion({ ...p, siblings: [{ hash: 'nope', position: 'left' }] }).reason,
    ).toMatch(/sibling/);
  });

  it('buildDeltaInclusion rejects an out-of-range index', () => {
    expect(() => buildDeltaInclusion(anchor(3), 3)).toThrow(/out of range/);
  });

  it('a PASSING verdict still lists what it does not establish', () => {
    const v = verifyDeltaInclusion(buildDeltaInclusion(anchor(4), 1));
    expect(v.included).toBe(true);
    const text = v.unproven.join(' ');
    expect(text).toMatch(/not true|is CORRECT/);
    expect(text).toMatch(/COMPLETE/); // omission is possible and is said so
    expect(text).toMatch(/identity_commitment/);
    expect(text).toMatch(/on-chain/);
  });
});

// ---------------------------------------------------------------------------
// The attestation — built, never sent
// ---------------------------------------------------------------------------

describe('attestation payload', () => {
  it('maps onto the already-registered constitutional-compliance-v1 field layout', () => {
    const a = anchor(3);
    const att = buildDeltaAnchorAttestation(a);
    // Same six fields as ProofAttestInput / decodeAnchorFields in memory-root-anchor.ts.
    expect(Object.keys(att).sort()).toEqual(
      ['agentId', 'merkleRoot', 'proofId', 'proofType', 'repidSnapshot', 'tier'].sort(),
    );
    expect(att.merkleRoot).toBe(a.root);
    expect(att.proofId).toBe(a.epoch);
    expect(att.proofType).toBe(REPID_DELTA_ANCHOR_PROOF_TYPE);
  });

  it('labels the batch so no reader mistakes it for a per-agent claim', () => {
    const att = buildDeltaAnchorAttestation(anchor(3));
    expect(att.agentId).toMatch(/^batch:/);
    expect(att.agentId).toContain(REPID_DELTA_ANCHOR_DOMAIN);
    expect(att.tier).toBe('BATCH');
  });

  it('the DB label is distinct from the on-chain schema it rides', () => {
    expect(REPID_DELTA_ANCHOR_EAS_SCHEMA).toBe('repid-delta-statement-batch-v1');
    expect(REPID_DELTA_ANCHOR_EAS_SCHEMA).not.toBe('constitutional-compliance-v1');
  });

  it('anchorDeltaBatch sends only through an INJECTED writer — there is no default', () => {
    const seen: DeltaAnchorAttestation[] = [];
    const fake = async (i: DeltaAnchorAttestation) => {
      seen.push(i);
      return { uid: '0x' + 'ab'.repeat(32), txHash: '0x' + 'cd'.repeat(32) };
    };
    return anchorDeltaBatch(anchor(2), fake).then((r) => {
      expect(r.anchored).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.merkleRoot).toMatch(HEX32);
    });
  });

  it('reports a refusal rather than throwing on a bad root', () => {
    const never = async () => {
      throw new Error('must not be called');
    };
    return anchorDeltaBatch({ ...anchor(2), root: '0xnope' }, never).then((r) => {
      expect(r.anchored).toBe(false);
      expect(r.error).toMatch(/invalid anchor root/);
    });
  });
});

// ---------------------------------------------------------------------------
// Invariants + the no-send guarantee
// ---------------------------------------------------------------------------

describe('ZKP invariants and the no-transaction guarantee', () => {
  const SRC = join(__dirname, '..', 'src', 'zkp', 'delta-anchor.ts');
  const code = () =>
    readFileSync(SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('Invariant 1 — Poseidon2/BabyBear only; no sha256, keccak, or ethers hashing', () => {
    expect(code()).not.toMatch(/sha256|keccak|createHash|ethers|md5|sha1|sha3/i);
    expect(code()).toMatch(/poseidon2Sponge|poseidon2Compress/);
  });

  it('CANNOT send: no ethers, no attestation service, no db, no default attestFn', () => {
    const c = code();
    expect(c).not.toMatch(/from 'ethers'|eas-attestation-service|attestProof|from '\.\.\/db'/);
    expect(c).not.toMatch(/JsonRpcProvider|Wallet|sendTransaction|EAS_CONTRACT/);
    // The injected writer has no default value — omitting it is a compile error, not a
    // funded transaction. (memory-root-anchor.ts defaults its attestFn to the real one.)
    expect(c).toMatch(/attestFn: DeltaAttestFn,/);
    expect(c).not.toMatch(/attestFn: DeltaAttestFn = /);
  });

  it('Invariant 2/3 — domain and scope stay parameters; nothing is hardcoded to reputation', () => {
    const c = code();
    expect(c).not.toMatch(/computeDelta|hal_score|agent_tier/);
    // A health-domain batch is the same call.
    const health = buildDeltaAnchor({
      statementDigests: digests(3),
      domain: 'hyperdag/health/consent/v1',
      formulaCommitment: FORMULA,
      epoch: 1,
    });
    expect(health.root).toMatch(HEX32);
    expect(verifyDeltaInclusion(buildDeltaInclusion(health, 1)).included).toBe(true);
  });

  it('does not build the health vertical', () => {
    expect(code()).not.toMatch(/PHI|patient|diagnos|trustchat|HIPAA/i);
  });
});
