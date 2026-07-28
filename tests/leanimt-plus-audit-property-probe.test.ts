/**
 * Beat 52 INDEPENDENT PROBE of #250 (auditCommitment) — throwaway, not for merge.
 *
 * Written without reusing the PR's own test file. The PR claims: a clean audit makes the
 * cheap per-witness verifiers sound. That is a claim about ALL witnesses derivable from the
 * list, so this probe derives every one of them and hunts for a counterexample, rather than
 * checking the handful of shapes the author thought of.
 */
import {
  LeanIMTPlus, auditCommitment, verifyMembership, verifyNonMembership,
  encodeLeaf, type IndexedLeaf, type InclusionWitness,
} from '../src/memory/leanimt-plus';
import { referenceRoot, referenceProof } from '../src/memory/proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';

const LH = poseidon2LeafHash;
const PH = (a: string, b: string): string => poseidon2PairHash(a, b);
const digests = (ls: IndexedLeaf[]): string[] => ls.map((l) => LH(encodeLeaf(l)));
const rootOf = (ls: IndexedLeaf[]): string => referenceRoot(digests(ls), PH);

/** Every witness a prover (honest or not) can derive from this list: real path, any claimed index. */
function allWitnesses(ls: IndexedLeaf[]): InclusionWitness[] {
  const ds = digests(ls);
  const out: InclusionWitness[] = [];
  for (let i = 0; i < ls.length; i++) {
    const path = referenceProof(ds, i, PH);
    for (const claimed of [i, 0, 1, ls.length - 1]) {
      out.push({ index: claimed, leaf: { ...ls[i]! }, path });
    }
  }
  return out;
}

/** The property the PR sells: after a clean audit, no live value can be proven absent. */
function findForgery(ls: IndexedLeaf[]): string | null {
  const root = rootOf(ls);
  const ws = allWitnesses(ls);
  const values = new Set<bigint>();
  for (const l of ls) { values.add(l.value); values.add(l.next); values.add(l.value + 1n); }
  values.add(7n); values.add(1n);

  for (const v of values) {
    if (v === 0n) continue;
    const provablyPresent = ws.some((w) => verifyMembership(v, w, root));
    const provablyAbsent = ws.some((w) => verifyNonMembership(v, { lowLeaf: w }, root));
    if (provablyPresent && provablyAbsent) return `v=${v} is BOTH member and non-member at one root`;
    const live = ls.some((l) => !l.tombstoned && l.value === v);
    if (live && provablyAbsent) return `live v=${v} provable ABSENT`;
  }
  return null;
}

function mutate(ls: IndexedLeaf[], rnd: () => number): IndexedLeaf[] {
  const out = ls.map((l) => ({ ...l }));
  const pick = (): number => Math.floor(rnd() * out.length);
  switch (Math.floor(rnd() * 6)) {
    case 0: out.push({ value: BigInt(1 + Math.floor(rnd() * 20)), next: 0n, tombstoned: false }); break;
    case 1: out.push({ value: 0n, next: 0n, tombstoned: false }); break;            // Beat-50 poison
    case 2: { const i = pick(); out[i]!.next = BigInt(Math.floor(rnd() * 25)); break; }
    case 3: { const i = pick(); out[i]!.tombstoned = !out[i]!.tombstoned; break; }
    case 4: { const i = pick(); out[i]!.value = BigInt(Math.floor(rnd() * 25)); break; }
    case 5: { const i = pick(); if (i > 0) out.splice(i, 1); break; }               // drop a leaf
  }
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('Beat 52 — independent probe of the whole-commitment audit', () => {
  it('COMPLETENESS: every honestly-built list audits clean (no false alarms)', () => {
    const r = rng(11);
    for (let trial = 0; trial < 40; trial++) {
      const t = new LeanIMTPlus();
      const inserted: bigint[] = [];
      for (let k = 0; k < 5; k++) {
        const v = BigInt(1 + Math.floor(r() * 30));
        if (!inserted.includes(v)) { t.insert(v); inserted.push(v); }
      }
      for (const v of inserted) if (r() < 0.4) { t.revoke(v); }
      const a = auditCommitment(t.leafSet(), t.root());
      expect({ trial, ...a }).toEqual({ trial, ok: true, violations: [], activeCount: a.activeCount });
    }
  });

  it('SOUNDNESS: a clean audit admits no forgery, across randomized adversarial lists', () => {
    const r = rng(2026);
    let cleanSeen = 0, dirtySeen = 0, dirtyForgeable = 0;
    for (let trial = 0; trial < 250; trial++) {
      const t = new LeanIMTPlus();
      const inserted: bigint[] = [];
      for (let k = 0; k < 3 + Math.floor(r() * 3); k++) {
        const v = BigInt(1 + Math.floor(r() * 20));
        if (!inserted.includes(v)) { t.insert(v); inserted.push(v); }
      }
      for (const v of inserted) if (r() < 0.3) t.revoke(v);

      // The honest list is clean by construction — check the property on it EVERY trial, so the
      // "clean => no forgery" side is exercised 250 times and not just on lucky mutations.
      const honest = t.leafSet();
      expect(auditCommitment(honest, rootOf(honest)).ok).toBe(true);
      expect(`honest trial ${trial}: ${findForgery(honest) ?? 'no forgery'}`).toBe(`honest trial ${trial}: no forgery`);
      cleanSeen++;

      let ls = t.leafSet();
      const rounds = 1 + Math.floor(r() * 3);
      for (let m = 0; m < rounds; m++) ls = mutate(ls, r);
      if (ls.length === 0) continue;

      const audit = auditCommitment(ls, rootOf(ls));
      const forgery = findForgery(ls);
      if (audit.ok) { cleanSeen++; expect(`clean-audit trial ${trial}: ${forgery ?? 'no forgery'}`).toBe(`clean-audit trial ${trial}: no forgery`); }
      else { dirtySeen++; if (forgery) dirtyForgeable++; }
    }
    // The probe must actually have exercised both sides, or it proves nothing.
    expect(cleanSeen).toBeGreaterThan(5);
    expect(dirtySeen).toBeGreaterThan(20);
    expect(dirtyForgeable).toBeGreaterThan(0);   // the audit is catching lists that ARE forgeable
    // eslint-disable-next-line no-console
    console.log(`[probe] clean=${cleanSeen} dirty=${dirtySeen} dirty-and-forgeable=${dirtyForgeable}`);
  }, 120000);

  it('THE HEADLINE CASE: the skipped-live-value list is forgeable and the audit refuses it', () => {
    const ls: IndexedLeaf[] = [
      { value: 0n, next: 0n, tombstoned: false },   // sentinel claims "active set is empty"
      { value: 7n, next: 0n, tombstoned: false },   // ...but 7 is live
    ];
    expect(findForgery(ls)).not.toBeNull();                       // the per-witness layer IS fooled
    expect(auditCommitment(ls, rootOf(ls)).violations).toContain('active-leaf-not-in-chain@1');
  });

  it('BINDING: a well-formed list audited against someone else\'s root is refused', () => {
    const a = new LeanIMTPlus(); a.insert(5n);
    const b = new LeanIMTPlus(); b.insert(9n);
    expect(auditCommitment(a.leafSet(), a.root()).ok).toBe(true);
    expect(auditCommitment(a.leafSet(), b.root()).violations).toContain('root-mismatch');
  });

  it('TOTALITY: hostile inputs yield a verdict, never a throw', () => {
    const good = new LeanIMTPlus(); good.insert(3n);
    const root = good.root();
    const throwing = new Proxy({}, { get(): never { throw new Error('boom'); } }) as IndexedLeaf;
    const cases: unknown[] = [
      undefined, null, {}, 42, 'x', [], [null], [undefined],
      [{ value: '0', next: '0', tombstoned: false }],
      [throwing],
      [{ value: 0n, next: 0n, tombstoned: false }, throwing],
    ];
    for (const c of cases) {
      const res = auditCommitment(c as IndexedLeaf[], root);
      expect(typeof res.ok).toBe('boolean');
      expect(res.ok).toBe(false);
    }
  });
});
