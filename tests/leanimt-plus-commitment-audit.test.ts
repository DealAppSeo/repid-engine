/**
 * Whole-commitment audit — the scope that a single witness cannot cover.
 *
 * `verifyNonMembership` is sound RELATIVE TO a well-formed committed list. It is shown a low leaf
 * and a path; it can check what the root binds about THAT leaf and nothing about the leaves it was
 * never shown. A committer who builds the whole tree can therefore publish a sentinel whose `next`
 * skips a live value, and every witness derived from that tree verifies — this is the
 * commitment-well-formedness gap, and it survives the Beat-50 path fix (#247) untouched, because
 * that fix hardened a per-witness check and this is not one.
 *
 * The tests below pin BOTH halves: that the forged commitment really does fool the per-witness
 * verifier (so the audit is not solving a problem that does not exist), and that `auditCommitment`
 * refuses it. Every adversarial case first asserts the attack works pre-audit; a test that only
 * asserted `ok === false` could pass against a rejector that refuses everything.
 */
import {
  LeanIMTPlus,
  auditCommitment,
  verifyNonMembership,
  verifyMembership,
  encodeLeaf,
  type IndexedLeaf,
} from '../src/memory/leanimt-plus';
import { referenceRoot, referenceProof } from '../src/memory/proof-carrying-index';
import { createHash } from 'crypto';

// sha256 mock — same seam the other memory suites inject, keeps the suite fast and hash-agnostic.
const pair = (a: string, b: string): string => '0x' + createHash('sha256').update(`${a}|${b}`).digest('hex');
const leaf = (c: string): string => '0x' + createHash('sha256').update(c).digest('hex');

const opts = { leafHash: leaf, pairHash: pair };
const rootOf = (ls: IndexedLeaf[]): string => referenceRoot(ls.map((l) => leaf(encodeLeaf(l))), pair);
const audit = (ls: IndexedLeaf[], root: string) => auditCommitment(ls, root, leaf, pair);
const witnessAt = (ls: IndexedLeaf[], i: number) => ({
  index: i,
  leaf: ls[i]!,
  path: referenceProof(ls.map((l) => leaf(encodeLeaf(l))), i, pair),
});

describe('honest commitments audit clean', () => {
  it('the empty tree (sentinel only)', () => {
    const t = new LeanIMTPlus(opts);
    expect(audit(t.leafSet(), t.root())).toMatchObject({ ok: true, violations: [], activeCount: 0 });
  });

  it('inserts in ascending, descending and interleaved order', () => {
    for (const order of [[3n, 5n, 9n], [9n, 5n, 3n], [5n, 9n, 3n]]) {
      const t = new LeanIMTPlus(opts);
      for (const v of order) t.insert(v);
      expect(audit(t.leafSet(), t.root())).toMatchObject({ ok: true, activeCount: 3 });
    }
  });

  it('after revocations — tombstones are not chain members and are not counted active', () => {
    const t = new LeanIMTPlus(opts);
    [10n, 20n, 30n].forEach((v) => t.insert(v));
    t.revoke(20n);
    const a = audit(t.leafSet(), t.root());
    expect(a).toMatchObject({ ok: true, violations: [] });
    expect(a.activeCount).toBe(2);            // 10 and 30 — 20 is tombstoned and unlinked
    expect(t.leafSet()).toHaveLength(4);      // history preserved: the leaf is still there
  });

  it('revoking every value returns to a clean, empty active set', () => {
    const t = new LeanIMTPlus(opts);
    [4n, 8n].forEach((v) => t.insert(v));
    [4n, 8n].forEach((v) => t.revoke(v));
    expect(audit(t.leafSet(), t.root())).toMatchObject({ ok: true, activeCount: 0 });
  });
});

describe('the audit is BOUND to the commitment', () => {
  it('a well-formed list audited against someone else\'s root is refused', () => {
    const a = new LeanIMTPlus(opts); a.insert(7n);
    const b = new LeanIMTPlus(opts); b.insert(9n);
    expect(audit(a.leafSet(), a.root()).ok).toBe(true);          // clean against its own root
    expect(audit(a.leafSet(), b.root()).violations).toContain('root-mismatch');
  });

  it('mutating a published leaf after the fact breaks the binding', () => {
    const t = new LeanIMTPlus(opts); t.insert(7n);
    const root = t.root();
    const tampered = t.leafSet();
    tampered[1]!.value = 8n;                                      // rewrite history, keep the old root
    expect(audit(tampered, root).violations).toContain('root-mismatch');
  });
});

describe('THE GAP: a sentinel whose next skips a live value', () => {
  // The forged commitment. 7 is a leaf of the tree — provably a member — yet the sentinel points
  // past it at the tail, so the sentinel is a valid low leaf for 7 and proves it ABSENT.
  const forged: IndexedLeaf[] = [
    { value: 0n, next: 0n, tombstoned: false },  // sentinel: claims the active set is empty
    { value: 7n, next: 0n, tombstoned: false },  // …but 7 is right here, live and untombstoned
  ];
  const root = rootOf(forged);

  it('fools the per-witness verifier — membership AND non-membership both hold at one root', () => {
    expect(verifyMembership(7n, witnessAt(forged, 1), root, leaf, pair)).toBe(true);
    expect(verifyNonMembership(7n, { lowLeaf: witnessAt(forged, 0) }, root, leaf, pair)).toBe(true);
    // Both true ⇒ the committed memory is not a function. No single witness can see this.
  });

  it('is caught by the audit, on the coverage clause', () => {
    const a = audit(forged, root);
    expect(a.ok).toBe(false);
    expect(a.violations).toContain('active-leaf-not-in-chain@1');
  });

  it('the same shape at depth — one live value skipped among several honest ones', () => {
    const t = new LeanIMTPlus(opts);
    [10n, 20n, 30n].forEach((v) => t.insert(v));
    const ls = t.leafSet();
    // Unlink 20 from the chain WITHOUT tombstoning it: 10 now points straight at 30.
    const i20 = ls.findIndex((l) => l.value === 20n);
    const i10 = ls.findIndex((l) => l.value === 10n);
    ls[i10]!.next = 30n;
    const r = rootOf(ls);
    expect(verifyMembership(20n, witnessAt(ls, i20), r, leaf, pair)).toBe(true);            // still live
    expect(verifyNonMembership(20n, { lowLeaf: witnessAt(ls, i10) }, r, leaf, pair)).toBe(true); // and "absent"
    expect(audit(ls, r).violations).toContain(`active-leaf-not-in-chain@${i20}`);
  });
});

describe('planted and malformed leaves', () => {
  it('an untombstoned value-0 leaf outside slot 0 — the Beat-50 absence oracle — is refused', () => {
    const poison: IndexedLeaf[] = [
      { value: 0n, next: 7n, tombstoned: false },
      { value: 0n, next: 0n, tombstoned: false },  // planted: reads as a sentinel to a lax verifier
      { value: 7n, next: 0n, tombstoned: false },
    ];
    const root = rootOf(poison);
    expect(verifyMembership(7n, witnessAt(poison, 2), root, leaf, pair)).toBe(true); // 7 is live
    const a = audit(poison, root);
    expect(a.ok).toBe(false);
    expect(a.violations).toContain('value-0-leaf-outside-sentinel-slot@1');
  });

  it('a tombstone that kept its value never came from revoke()', () => {
    const t = new LeanIMTPlus(opts);
    [4n, 9n].forEach((v) => t.insert(v));
    t.revoke(4n);
    const ls = t.leafSet();
    const i = ls.findIndex((l) => l.tombstoned);
    ls[i]!.value = 4n;                                            // resurrect the value on a tombstone
    expect(audit(ls, rootOf(ls)).violations).toContain(`tombstone-not-canonical@${i}`);
  });

  it('two active leaves with the same value make membership ambiguous', () => {
    const dup: IndexedLeaf[] = [
      { value: 0n, next: 5n, tombstoned: false },
      { value: 5n, next: 0n, tombstoned: false },
      { value: 5n, next: 0n, tombstoned: false },
    ];
    const root = rootOf(dup);
    expect(verifyMembership(5n, witnessAt(dup, 1), root, leaf, pair)).toBe(true);
    expect(verifyMembership(5n, witnessAt(dup, 2), root, leaf, pair)).toBe(true);  // two distinct proofs
    expect(audit(dup, root).violations).toContain('duplicate-active-value:5');
  });

  it('a missing or tombstoned sentinel is refused', () => {
    const noSentinel: IndexedLeaf[] = [{ value: 3n, next: 0n, tombstoned: false }];
    expect(audit(noSentinel, rootOf(noSentinel)).violations).toContain('sentinel-value-not-zero');
    const dead: IndexedLeaf[] = [{ value: 0n, next: 0n, tombstoned: true }];
    expect(audit(dead, rootOf(dead)).violations).toContain('sentinel-tombstoned');
  });
});

describe('chain pathologies terminate and are reported', () => {
  it('a cycle does not hang — it is bounded by the leaf count', () => {
    const cyc: IndexedLeaf[] = [
      { value: 0n, next: 5n, tombstoned: false },
      { value: 5n, next: 9n, tombstoned: false },
      { value: 9n, next: 5n, tombstoned: false },  // back-edge
    ];
    const a = audit(cyc, rootOf(cyc));
    expect(a.ok).toBe(false);
    // 9 → 5 is a decrease, so it trips the ordering clause before the revisit clause; either is a refusal.
    expect(a.violations.some((v) => v.startsWith('chain-not-strictly-increasing') || v.startsWith('chain-revisits-leaf'))).toBe(true);
  });

  it('a self-loop terminates', () => {
    const self: IndexedLeaf[] = [
      { value: 0n, next: 5n, tombstoned: false },
      { value: 5n, next: 5n, tombstoned: false },
    ];
    expect(audit(self, rootOf(self)).ok).toBe(false);
  });

  it('a chain pointing at a value no active leaf holds is refused', () => {
    const dangling: IndexedLeaf[] = [
      { value: 0n, next: 5n, tombstoned: false },
      { value: 6n, next: 0n, tombstoned: false },
    ];
    const a = audit(dangling, rootOf(dangling));
    expect(a.violations).toContain('chain-points-at-non-active-value:5');
  });

  it('a chain pointing INTO a tombstone is refused (a revoked value is not a chain member)', () => {
    const t = new LeanIMTPlus(opts);
    [10n, 20n].forEach((v) => t.insert(v));
    t.revoke(20n);
    const ls = t.leafSet();
    ls[0]!.next = 10n; ls[1]!.next = 20n;   // re-link the predecessor back at the revoked value
    expect(audit(ls, rootOf(ls)).violations).toContain('chain-points-at-non-active-value:20');
  });
});

describe('the audit is total — hostile input yields a verdict, never a throw', () => {
  /**
   * Two levels of malformation, and the second is the one that was missing. Cases 3-6 corrupt a
   * FIELD of a leaf that exists; cases 7-10 corrupt the ELEMENT itself. Every step of the audit
   * dereferences `leaves[i]`, so a hole or a `null` reached `.tombstoned` and threw a TypeError —
   * the denial-of-service class #240/#245 closed in the per-witness verifiers, arriving one level
   * up. A suite that only malforms fields demonstrates totality exactly where it is not at risk.
   */
  const sparse: unknown[] = []; sparse.length = 2; sparse[1] = { value: 0n, next: 0n, tombstoned: false };
  const elementLevel: unknown[] = [
    [null],                                                              // element is null at the sentinel slot
    [{ value: 0n, next: 0n, tombstoned: false }, null],                  // ...and past it
    sparse,                                                              // a hole (present length, absent element)
    [{ value: '0', next: '0', tombstoned: false }],                      // JSON round-trip: bigints arrive as strings
  ];
  /**
   * The third level, and the one the shape check CANNOT reach. `isLeafShape` has to read `.value`
   * to judge it, so an element with a throwing accessor throws inside the guard that exists to
   * prevent throwing. No amount of per-field checking closes this — only the outer boundary does.
   */
  const throwingLeaf = (): unknown => new Proxy({}, { get() { throw new Error('hostile accessor'); } });

  const hostile: unknown[] = [
    [],
    null,
    undefined,
    [{ value: undefined, next: 0n, tombstoned: false }],
    [{ value: 0n, next: undefined, tombstoned: false }, { value: 3n, next: 0n, tombstoned: false }],
    [{ value: 0n, next: 'not-a-bigint', tombstoned: false }],
    [{ value: 0n, next: 0n, tombstoned: false }, {}],
    ...elementLevel,
    [throwingLeaf()],
    [{ value: 0n, next: 0n, tombstoned: false }, throwingLeaf()],
  ];

  it('the hostile set actually exercises element-level malformation, not only field-level', () => {
    // Guard on the guard: without this, deleting `elementLevel` leaves a green suite that proves
    // nothing about the case that threw.
    expect(hostile).toEqual(expect.arrayContaining(elementLevel));
    expect(elementLevel.length).toBeGreaterThanOrEqual(4);
    expect(hostile.some((h) => Array.isArray(h) && h.some((e) => e === null || e === undefined))).toBe(true);
  });

  it('element-level malformation is DIAGNOSED, not merely survived', () => {
    /**
     * The two guards are not interchangeable, and asserting only `ok === false` cannot tell them
     * apart: with the outer boundary in place, deleting the shape check turns `malformed-leaf@1`
     * into `audit-threw` and every `ok === false` assertion still passes. Naming the violation is
     * what pins the shape check — and the JSON case is the one it alone can reach, because a
     * string-valued leaf never throws at all; it re-derives a plausible root and then compares
     * across types, which the boundary would let through as a structural verdict.
     */
    expect(audit([null] as unknown as IndexedLeaf[], '0xdeadbeef').violations).toEqual(['malformed-leaf@0']);
    expect(audit([{ value: 0n, next: 0n, tombstoned: false }, null] as unknown as IndexedLeaf[], '0xdeadbeef').violations)
      .toEqual(['malformed-leaf@1']);
    expect(audit(sparse as IndexedLeaf[], '0xdeadbeef').violations).toContain('malformed-leaf@0');
  });

  it('the throwing-accessor fixture is genuinely hostile — reading its shape DOES throw', () => {
    // Without this, the case below passes against a fixture that never threatened anything, and
    // the boundary it exists to pin could be deleted with the suite still green.
    const el = throwingLeaf();
    expect(() => typeof (el as { value: unknown }).value).toThrow('hostile accessor');
  });

  it('an element whose property access throws yields a verdict, not an exception', () => {
    // The shape check cannot catch this: it has to touch `.value` to judge it, so it throws inside
    // the guard. Only the outer boundary makes the documented totality claim true.
    const a = audit([throwingLeaf()] as IndexedLeaf[], '0xdeadbeef');
    expect(a.ok).toBe(false);
    expect(a.violations).toEqual(['audit-threw']);
    expect(a.activeCount).toBe(0);
  });

  it('a JSON-transported list is REJECTED, not coerced — soundness must not turn on a cast', () => {
    // `encodeLeaf` stringifies, so '5' and 5n hash identically: a coerced list would re-derive the
    // correct root while every ordering comparison ran across types. The caller parses its bigints.
    const t = new LeanIMTPlus(opts);
    t.insert(5n);
    const overTheWire = JSON.parse(JSON.stringify(t.leafSet(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const a = audit(overTheWire, t.root());
    expect(a.ok).toBe(false);
    expect(a.violations).toContain('malformed-leaf@0');
  });

  it.each(hostile.map((h, i) => [i, h]))('case %i returns ok=false without throwing', (_i, h) => {
    let out: ReturnType<typeof audit> | undefined;
    expect(() => { out = audit(h as IndexedLeaf[], '0xdeadbeef'); }).not.toThrow();
    expect(out!.ok).toBe(false);
    expect(out!.violations.length).toBeGreaterThan(0);
  });

  it('the violation list is capped so a hostile list cannot make the report the payload', () => {
    const many: IndexedLeaf[] = [{ value: 0n, next: 0n, tombstoned: false }];
    for (let i = 0; i < 200; i++) many.push({ value: 0n, next: 0n, tombstoned: false });
    const a = audit(many, rootOf(many));
    expect(a.ok).toBe(false);
    expect(a.violations.length).toBeLessThanOrEqual(32);
  });
});

describe('what the audit buys: after it passes, the cheap per-witness proofs are sound', () => {
  it('audit once per root, then every membership/non-membership answer is a function', () => {
    const t = new LeanIMTPlus(opts);
    [10n, 20n, 30n].forEach((v) => t.insert(v));
    t.revoke(20n);
    const root = t.root();
    expect(audit(t.leafSet(), root).ok).toBe(true);

    for (const v of [10n, 20n, 30n, 5n, 25n, 99n]) {
      const isActive = v === 10n || v === 30n;
      const member = isActive && verifyMembership(v, t.membershipProof(v), root, leaf, pair);
      const absent = !isActive && verifyNonMembership(v, t.nonMembershipProof(v), root, leaf, pair);
      expect(member || absent).toBe(true);        // exactly one of the two holds
      expect(member && absent).toBe(false);
    }
  });
});

/**
 * Liveness — a third property, and the first two do not imply it.
 *
 * The Beat-52 boundary bought "never throws". It did not bound the WORK: `auditCommitment` reads a
 * `length` it does not control, and every clause is O(n) in it. `new Array(4e9)` costs the
 * publisher one integer (sparse, no backing store) and the audit ~5 minutes of scanning a verdict
 * already decided at index 0 — no exception, no result. That is the same denial-of-service class
 * #240/#245 closed for the per-witness verifiers, surviving as a hang instead of a throw.
 *
 * These cases assert TIME, not just the violation string. A verdict-only assertion cannot tell a
 * bounded audit from an unbounded one, which is precisely the weakness the Beat-52 mutation battery
 * found in the totality tests. Each fixture also demonstrates its own hostility first — the
 * unbounded path is measured via `maxLeaves` — so the cap is shown to be load-bearing, not assumed.
 */
describe('the audit terminates on a length it does not control', () => {
  const cheapAudit = (ls: unknown[], max?: number) =>
    auditCommitment(ls as IndexedLeaf[], '0xdeadbeef', leaf, pair, max === undefined ? {} : { maxLeaves: max });

  it('the unbounded path really is expensive per element (fixture hostility, measured)', () => {
    const n = 4_000_000;
    const t0 = Date.now();
    const a = cheapAudit(new Array(n), Number.MAX_SAFE_INTEGER);   // cap deliberately lifted
    const elapsed = Date.now() - t0;
    expect(a.ok).toBe(false);
    expect(a.violations).toContain('malformed-leaf@0');            // decided at index 0 …
    expect(elapsed).toBeGreaterThan(20);                           // … and still scanned all 4e6
  });

  it('a sparse array at the maximum JS length is refused before a single element is touched', () => {
    const t0 = Date.now();
    const a = cheapAudit(new Array(4_294_967_294));                // O(1) for the publisher
    const elapsed = Date.now() - t0;
    expect(a).toMatchObject({ ok: false, activeCount: 0 });
    expect(a.violations).toEqual(['leaf-set-too-large@4294967294>16384']);
    expect(a.violations).not.toContain('malformed-leaf@0');        // the size clause ran FIRST
    expect(elapsed).toBeLessThan(2000);                            // ~5 minutes before the cap
  });

  it('a materialised over-cap list is refused too, and costs nothing to refuse', () => {
    const many: IndexedLeaf[] = [];
    for (let i = 0; i <= 16384; i++) many.push({ value: 0n, next: 0n, tombstoned: false });
    expect(cheapAudit(many).violations).toEqual(['leaf-set-too-large@16385>16384']);
  });

  it('the bound is exact, and raising it deliberately still audits honestly', () => {
    const t = new LeanIMTPlus(opts);
    [3n, 5n].forEach((v) => t.insert(v));
    const ls = t.leafSet();                                        // sentinel + 2 = 3 leaves
    expect(ls.length).toBe(3);

    expect(auditCommitment(ls, t.root(), leaf, pair, { maxLeaves: 2 }).violations)
      .toEqual(['leaf-set-too-large@3>2']);                        // n > max  → refused
    expect(auditCommitment(ls, t.root(), leaf, pair, { maxLeaves: 3 }))
      .toMatchObject({ ok: true, violations: [], activeCount: 2 }); // n === max → allowed, and CLEAN
  });
});
