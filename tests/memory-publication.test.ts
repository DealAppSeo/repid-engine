/**
 * The publication channel: a peer can now obtain the audit's input, and the anchor binding actually
 * reads the two fields that were being written and discarded.
 *
 * Discipline used throughout: every hostile fixture DEMONSTRATES ITS OWN HOSTILITY FIRST. For the
 * anchor cases that means showing the existing three-field comparison ACCEPTS the anchor before
 * asserting that `verifyPublication` refuses it — otherwise these tests would pass just as happily
 * against a verifier that refuses everything, and would say nothing about what the new clauses buy.
 */
import { AbiCoder } from 'ethers';
import { ProofCarryingMemory, type MemoryEntry } from '../src/memory/proof-carrying-memory';
import { publishMemory, verifyPublication, type MemoryPublication, type PublicationExpectation } from '../src/memory/memory-publication';
import {
  buildMemoryRootAttest, decodeAnchorFields, anchorMemoryRoot,
  MEMORY_ROOT_PROOF_TYPE, type AnchorFields, type AttestFn,
} from '../src/memory/memory-root-anchor';
import { PROOF_SCHEMA_DEF, type ProofAttestInput } from '../src/services/eas-attestation-service';
import { auditCommitment, type IndexedLeaf } from '../src/memory/leanimt-plus';

const AGENT = 'agent-pub-1';
const TIER = 'ESTABLISHED';
const EPOCH = 7;

const entry = (content: string, epoch = 1): MemoryEntry =>
  ({ content, source_id: 'src', source_repid: 1200, hal_verdict: 'clean', epoch });

function freshMemory(): ProofCarryingMemory {
  const m = new ProofCarryingMemory();
  m.add(entry('the sky is blue'));
  m.add(entry('water boils at 100C'));
  m.add(entry('a retracted claim'));
  return m;
}

/** The anchor an honest agent would have written for this publication. */
const anchorFor = (pub: MemoryPublication, over: Partial<AnchorFields> = {}): AnchorFields => ({
  agentId: AGENT, tier: TIER, merkleRoot: pub.root, repidSnapshot: 1200n,
  proofType: MEMORY_ROOT_PROOF_TYPE, proofId: BigInt(pub.epoch), ...over,
});

/**
 * The comparison the existing verification path performs, replicated exactly:
 * `redTeamPayloadMatch` decodes six fields and compares three (agentId, tier, merkleRoot).
 * Used ONLY to demonstrate that the hostile anchors below are hostile.
 */
const legacyThreeFieldMatch = (a: AnchorFields, root: string): boolean =>
  a.agentId === AGENT && a.tier === TIER && a.merkleRoot.toLowerCase() === root.toLowerCase();

describe('publication channel — the audit finally has an obtainable input', () => {
  it('an honest publication verifies: well-formed AND anchored', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const v = verifyPublication(pub, { anchor: anchorFor(pub), agentId: AGENT, tier: TIER });
    expect({ ok: v.ok, bound: v.anchorBound, reasons: v.reasons }).toEqual({ ok: true, bound: true, reasons: [] });
    expect(v.audit.ok).toBe(true);
    expect(v.audit.activeCount).toBe(3);
  });

  it('the published leaf set is what the audit needs, and revocation moves it', () => {
    const m = freshMemory();
    const value = m.add(entry('a retracted claim'));   // idempotent: same value back
    m.revoke(value);
    const pub = publishMemory(m, EPOCH);
    expect(verifyPublication(pub, { anchor: anchorFor(pub) }).ok).toBe(true);
    expect(auditCommitment(pub.leaves, pub.root).activeCount).toBe(2);   // the retraction is visible in the list
  });

  it('the published list is a COPY — a peer cannot mutate the agent\'s tree through it', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    pub.leaves[1]!.value = 999999n;
    const fresh = publishMemory(m, EPOCH);
    expect(fresh.leaves[1]!.value).not.toBe(999999n);
    expect(verifyPublication(fresh, { anchor: anchorFor(fresh) }).ok).toBe(true);
  });
});

describe('the audit is genuinely run, not merely referenced', () => {
  it('the skipped-live-value forgery is refused even when the anchor is perfect', () => {
    // Beat 51's list: the sentinel claims the active set is empty, but 7 is live. Every per-witness
    // check passes; only the whole-commitment audit sees it.
    const leaves: IndexedLeaf[] = [
      { value: 0n, next: 0n, tombstoned: false },
      { value: 7n, next: 0n, tombstoned: false },
    ];
    const honest = new ProofCarryingMemory();
    honest.add(entry('anything'));
    const pub: MemoryPublication = { epoch: EPOCH, root: rootOfLeaves(leaves), leaves };
    const anchor = anchorFor(pub);                       // anchored, correct root, correct epoch, correct domain
    expect(legacyThreeFieldMatch(anchor, pub.root)).toBe(true);   // ← the anchor itself is beyond reproach

    const v = verifyPublication(pub, { anchor });
    expect(v.anchorBound).toBe(true);                    // the anchor half PASSES...
    expect(v.ok).toBe(false);                            // ...and the publication is still refused
    expect(v.reasons).toContain('commitment-audit-failed');
    expect(v.audit.violations).toContain('active-leaf-not-in-chain@1');
  });

  it('a published root that is not the root of the published list is refused', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const tampered: MemoryPublication = { ...pub, root: '0x' + 'cd'.repeat(32) };
    const v = verifyPublication(tampered, { anchor: anchorFor(tampered) });
    expect(v.anchorBound).toBe(true);                    // anchor agrees with the CLAIMED root
    expect(v.ok).toBe(false);
    expect(v.audit.violations).toContain('root-mismatch');
  });
});

describe('the anchor binding — the two fields that were written and never read', () => {
  it('DOMAIN: a non-memory attestation of the same agent/tier/root is accepted by the legacy comparison and refused here', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const wrongDomain = anchorFor(pub, { proofType: 'POSTCARD' });   // the encoder's DEFAULT proofType

    expect(legacyThreeFieldMatch(wrongDomain, pub.root)).toBe(true); // the gap is real, not hypothetical
    const v = verifyPublication(pub, { anchor: wrongDomain, agentId: AGENT, tier: TIER });
    expect(v.anchorBound).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('anchor-proof-type-mismatch');
    expect(v.audit.ok).toBe(true);                                   // well-formed; just not a memory anchor
  });

  it('FRESHNESS: an anchor made for a different epoch is accepted by the legacy comparison and refused here', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const staleEpoch = anchorFor(pub, { proofId: 3n });              // anchored at epoch 3, published as 7

    expect(legacyThreeFieldMatch(staleEpoch, pub.root)).toBe(true);
    const v = verifyPublication(pub, { anchor: staleEpoch });
    expect(v.anchorBound).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('anchor-epoch-mismatch');
  });

  it('an anchor over a different root is refused (and the legacy comparison catches this one too)', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const otherRoot = anchorFor(pub, { merkleRoot: '0x' + 'ef'.repeat(32) });
    expect(legacyThreeFieldMatch(otherRoot, pub.root)).toBe(false);  // honest about what the legacy path DOES buy
    expect(verifyPublication(pub, { anchor: otherRoot }).reasons).toContain('anchor-root-mismatch');
  });

  it('someone else\'s anchor is refused when the peer states who it expects', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    const v = verifyPublication(pub, { anchor: anchorFor(pub, { agentId: 'other-agent', tier: 'VETERAN' }), agentId: AGENT, tier: TIER });
    expect(v.reasons).toEqual(expect.arrayContaining(['anchor-agent-mismatch', 'anchor-tier-mismatch']));
    expect(v.ok).toBe(false);
  });

  it('FAIL-CLOSED: an unanchored publication is not ok, and the weaker property is still reported', () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);
    for (const e of [{}, { anchor: null }, { anchor: undefined }]) {
      const v = verifyPublication(pub, e);
      expect(v.ok).toBe(false);
      expect(v.anchorBound).toBe(false);
      expect(v.reasons).toContain('unanchored-publication');
      expect(v.audit.ok).toBe(true);   // a caller that wants only well-formedness must read this and say so
    }
  });
});

describe('write path ↔ read path — the field names actually line up', () => {
  const abiTypes = PROOF_SCHEMA_DEF.split(',').map((f) => f.trim().split(' ')[0]!);

  it('what anchorMemoryRoot writes decodes back into exactly what verifyPublication checks', async () => {
    const m = freshMemory();
    const pub = publishMemory(m, EPOCH);

    // Capture the real attest input (chain write injected — no network).
    let captured: ProofAttestInput | null = null;
    const attest: AttestFn = async (input) => { captured = input; return { uid: '0xUID', txHash: '0xTX' }; };
    const res = await anchorMemoryRoot({ agentId: AGENT, tier: TIER, root: pub.root, epoch: pub.epoch, repidSnapshot: 1200 }, attest);
    expect(res.anchored).toBe(true);

    const w = captured as unknown as ProofAttestInput;
    // Encode exactly as attestProof does, then decode with the decoder a verifier would use.
    const data = AbiCoder.defaultAbiCoder().encode(abiTypes, [
      w.agentId, w.tier, w.merkleRoot, BigInt(w.repidSnapshot || 0), w.proofType || 'POSTCARD', BigInt(w.proofId),
    ]);
    const decoded = decodeAnchorFields(data)!;
    expect(decoded.proofType).toBe(MEMORY_ROOT_PROOF_TYPE);
    expect(decoded.proofId).toBe(BigInt(EPOCH));
    expect(decoded.merkleRoot.toLowerCase()).toBe(pub.root.toLowerCase());

    // The round-trip closes: the decoded on-chain payload verifies the publication.
    expect(verifyPublication(pub, { anchor: decoded, agentId: AGENT, tier: TIER }).ok).toBe(true);
  });

  it('buildMemoryRootAttest carries the epoch as proofId — the field the binding depends on', () => {
    const a = buildMemoryRootAttest({ agentId: AGENT, tier: TIER, root: '0x' + 'ab'.repeat(32), epoch: 42 });
    expect({ proofId: a.proofId, proofType: a.proofType }).toEqual({ proofId: 42, proofType: MEMORY_ROOT_PROOF_TYPE });
  });

  it('decodeAnchorFields is TOTAL: hostile blobs yield null, never a throw', () => {
    for (const bad of ['', '0x', '0xzz', 'not-hex', '0x1234', undefined, null, 42, {}]) {
      expect(decodeAnchorFields(bad as unknown as string)).toBeNull();
    }
  });
});

describe('totality and liveness on untrusted input', () => {
  it('hostile publications yield a verdict, never a throw', () => {
    const cases: unknown[] = [
      undefined, null, 42, 'x', [],
      {}, { epoch: 1 }, { epoch: 1, root: 5, leaves: [] }, { epoch: 1, root: '0x', leaves: 'nope' },
      { epoch: 1.5, root: '0x', leaves: [] },
      { epoch: Number.NaN, root: '0x', leaves: [] },
      { epoch: -1, root: '0x', leaves: [] },
      { epoch: 1, root: '0x', leaves: [null] },
      { epoch: 1, root: '0x', leaves: [{ value: '0', next: '0', tombstoned: false }] },  // JSON-transported
    ];
    for (const c of cases) {
      const v = verifyPublication(c as MemoryPublication, { anchor: anchorFor({ epoch: 1, root: '0x', leaves: [] }) });
      expect(typeof v.ok).toBe('boolean');
      expect(v.ok).toBe(false);
    }
  });

  it('a throwing accessor is caught at the boundary, not by the field checks', () => {
    const hostile = new Proxy({}, { get(): never { throw new Error('boom'); } }) as MemoryPublication;
    expect(() => (hostile as unknown as { root: string }).root).toThrow();   // the fixture IS hostile
    const v = verifyPublication(hostile);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('verify-threw');
  });

  it('LIVENESS: an enormous published leaf set is refused fast, not scanned', () => {
    const pub = { epoch: 1, root: '0x' + '00'.repeat(32), leaves: new Array(4_000_000_000) as IndexedLeaf[] };
    const t0 = Date.now();
    const v = verifyPublication(pub, { anchor: anchorFor(pub) });
    const ms = Date.now() - t0;
    expect(v.ok).toBe(false);
    expect(v.audit.violations.join(',')).toContain('leaf-set-too-large');
    expect(ms).toBeLessThan(2000);
  });
});

describe('the epoch clause is a term of the verdict, not just a reported reason', () => {
  /**
   * Found by an independent probe (Beat 55), not by this suite's author. The clause is documented as
   * refusing a publication that cannot be placed in time, and for a FRACTIONAL epoch it happens to:
   * `BigInt(1.5)` would throw, so the anchor guard short-circuits to `anchor-epoch-mismatch` and the
   * verdict falls out of the anchor half. For a NEGATIVE epoch nothing short-circuits — `BigInt(-5)`
   * is a fine bigint — so an anchor carrying `proofId: -5n` binds cleanly and the publication used to
   * verify `ok: true` while carrying `epoch-not-a-safe-integer` in its own reasons.
   */
  const anchorAt = (root: string, proofId: bigint): AnchorFields =>
    ({ agentId: AGENT, tier: TIER, merkleRoot: root, repidSnapshot: 1200n, proofType: MEMORY_ROOT_PROOF_TYPE, proofId });

  it.each([-1, -5, -9007199254740991])('a negative epoch (%p) is refused — and the other two halves PASS, so only this clause can refuse it', (epoch) => {
    const m = freshMemory();
    const pub: MemoryPublication = { epoch, root: m.root(), leaves: m.leafSet() };
    const anchor = anchorAt(pub.root, BigInt(epoch));

    // The fixture demonstrates its own hostility: nothing else here is wrong.
    expect(auditCommitment(pub.leaves, pub.root).ok).toBe(true);          // well-formed
    expect(legacyThreeFieldMatch(anchor, pub.root)).toBe(true);           // the anchor is the agent's own

    const v = verifyPublication(pub, { anchor, agentId: AGENT, tier: TIER });
    expect(v.anchorBound).toBe(true);      // the anchor DID bind — it is the time that is not a time
    expect(v.audit.ok).toBe(true);         // and the list IS a well-formed commitment
    expect(v.reasons).toContain('epoch-not-a-safe-integer');
    expect(v.ok).toBe(false);              // ← the clause has to carry this on its own
  });

  it('a fractional epoch is refused too (the anchor half catches this one; the clause must not rely on that)', () => {
    const m = freshMemory();
    const pub: MemoryPublication = { epoch: 1.5, root: m.root(), leaves: m.leafSet() };
    const v = verifyPublication(pub, { anchor: anchorAt(pub.root, 0n), agentId: AGENT, tier: TIER });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['epoch-not-a-safe-integer', 'anchor-epoch-mismatch']));
  });

  it('INVARIANT over every case in this suite: ok === true implies reasons is empty', () => {
    const m = freshMemory();
    const good = publishMemory(m, EPOCH);
    const cases: Array<[MemoryPublication, PublicationExpectation]> = [
      [good, { anchor: anchorFor(good), agentId: AGENT, tier: TIER }],
      [good, {}],
      [good, { anchor: anchorFor(good, { proofType: 'POSTCARD' }) }],
      [good, { anchor: anchorFor(good, { proofId: 3n }) }],
      [good, { anchor: anchorFor(good, { merkleRoot: '0x' + 'ef'.repeat(32) }) }],
      [good, { anchor: anchorFor(good, { agentId: 'someone-else' }), agentId: AGENT }],
      [{ ...good, epoch: -1 }, { anchor: anchorAt(good.root, -1n) }],
      [{ ...good, epoch: 1.5 }, { anchor: anchorAt(good.root, 0n) }],
      [{ ...good, root: '0x' + 'cd'.repeat(32) }, { anchor: anchorAt('0x' + 'cd'.repeat(32), BigInt(EPOCH)) }],
      [{ ...good, leaves: [] }, { anchor: anchorFor(good) }],
    ];
    let okCount = 0;
    for (const [pub, expectation] of cases) {
      const v = verifyPublication(pub, expectation);
      if (v.ok) okCount++;
      expect({ case: JSON.stringify(expectation.anchor?.proofType ?? null), ok: v.ok, empty: v.reasons.length === 0 })
        .toEqual({ case: JSON.stringify(expectation.anchor?.proofType ?? null), ok: v.ok, empty: v.ok ? true : v.reasons.length === 0 });
      if (v.ok) expect(v.reasons).toEqual([]);
    }
    expect(okCount).toBe(1);   // exactly the honest case — so the invariant is not held vacuously
  });
});

// ── helper: the root of an arbitrary leaf list, using the same reference construction the audit uses
import { referenceRoot } from '../src/memory/proof-carrying-index';
import { encodeLeaf } from '../src/memory/leanimt-plus';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';
function rootOfLeaves(ls: IndexedLeaf[]): string {
  return referenceRoot(ls.map((l) => poseidon2LeafHash(encodeLeaf(l))), (a, b) => poseidon2PairHash(a, b));
}
