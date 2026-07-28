/**
 * leanimt-plus.ts — P1 of PROOF_CARRYING_RETRIEVAL_v0 (spec: living-docs/03_specs).
 * Decision D-094: accumulator = indexed Merkle tree (LeanIMT+ family).
 *
 * This is the reduction-to-practice of the core "current-valid, revocable agent memory"
 * construction: an indexed Merkle tree whose leaves form a sorted linked list of values
 * (value, next), enabling BOTH membership and NON-membership proofs, and PROVABLE RETRACTION
 * (revoke unlinks a value so a subsequent non-membership proof succeeds) — without rewriting
 * history. Poseidon2-backed (BabyBear leaf, D-094 field hold); hash primitives injected so the
 * base tree is swappable (the true LeanIMT no-zero promotion is the production-tree optimization;
 * this reference uses the fork-independent binary-Merkle base from proof-carrying-index (P0) —
 * the novel indexed / non-membership / revocation layer is identical over either base tree).
 *
 * Verifiers are STATELESS pure functions: what a peer / HAL / an on-chain check runs against a
 * committed root. No I/O. Full-rebuild-per-op here favors provable correctness; O(log n)
 * incremental update is the noted production optimization.
 *
 * ## What a stateless verifier can and cannot establish (threat model — read before relying on it)
 * A verifier sees ONE witness against ONE root; the root's producer is NOT assumed honest. What the
 * root BINDS is soundly checkable from one witness: the leaf's contents (value/next/tombstone are
 * folded into the digest) and its POSITION relative to the root (the path's direction bits).
 * Anything a witness merely *claims* alongside those — notably `InclusionWitness.index` — is NOT
 * bound, and must never gate a soundness decision.
 *
 * ## Two soundness scopes — do not conflate them
 * A single witness and a published list are different trust surfaces, and non-membership needs
 * BOTH to be sound against a committer who is not assumed honest:
 *
 *   1. PER-WITNESS (`verifyMembership` / `verifyNonMembership` / `verifyCurrentValidity`) — cheap,
 *      O(log n), needs only the root. It can establish what the root BINDS: a leaf's contents and
 *      its position (via the path's direction bits). It cannot establish anything about leaves it
 *      was not shown. A committer who forges the whole tree can publish a sentinel whose `next`
 *      skips a live value; every witness derived from that tree verifies. This is the
 *      commitment-well-formedness gap, and no single witness closes it.
 *   2. WHOLE-COMMITMENT (`auditCommitment`) — O(n), needs the PUBLISHED leaf set. It re-derives the
 *      root from the list (binding the audit to the commitment) and then checks the structural
 *      invariants the per-witness verifiers must assume: one sentinel, canonical tombstones, no
 *      duplicate active values, and a strictly-increasing `next`-chain from the sentinel that
 *      reaches EVERY active leaf. That last clause is the one that catches a skipped live value.
 *
 * An indexed Merkle tree normally gets (2) for free by constraining INSERTION in-circuit. This
 * reference has no such constraint, so it is bought explicitly instead: a peer audits the published
 * list once per root, and thereafter every cheap per-witness proof against that root is sound.
 * State the scope whenever a non-membership result is relied on.
 */
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';
import { referenceRoot, referenceProof, verifyInclusion, type Hash2, type ProofStep } from './proof-carrying-index';

export type Hex = string;
export type LeafHash = (commitment: string) => Hex;

/** A linked, indexed leaf: `value` with a pointer to the `next` larger active value (0 = tail). */
export interface IndexedLeaf { value: bigint; next: bigint; tombstoned: boolean; }
/**
 * `index` is ADVISORY — prover-side bookkeeping. It is NOT authenticated: `verifyInclusion`
 * folds `path` and never reads it, so an untrusted peer can set it to anything at zero cost.
 * No verifier here may branch on it for a soundness decision (a `path`-derived test is bound;
 * a claimed index is not). See the leftmost-slot check in `verifyNonMembership`.
 */
export interface InclusionWitness { index: number; leaf: IndexedLeaf; path: ProofStep[]; }
export interface NonMembershipWitness { lowLeaf: InclusionWitness; }

const LEAF_TAG = 'repid.memory.leanimt+.v0';
/** Canonical, domain-separated leaf encoding (tombstone folded in so a retraction changes the digest). */
export function encodeLeaf(l: IndexedLeaf): string {
  return `${LEAF_TAG}|${l.value.toString()}|${l.next.toString()}|${l.tombstoned ? 1 : 0}`;
}

export interface LeanIMTPlusOpts { leafHash?: LeafHash; pairHash?: Hash2; }

export class LeanIMTPlus {
  private leaves: IndexedLeaf[];
  private readonly leafHash: LeafHash;
  private readonly pair: Hash2;

  constructor(opts: LeanIMTPlusOpts = {}) {
    this.leafHash = opts.leafHash ?? poseidon2LeafHash;
    this.pair = opts.pairHash ?? ((a, b) => poseidon2PairHash(a, b));
    // Sentinel at index 0: value 0, next 0 (empty active set). Never tombstoned; the only legal value-0 low leaf.
    this.leaves = [{ value: 0n, next: 0n, tombstoned: false }];
  }

  private digest(l: IndexedLeaf): Hex { return this.leafHash(encodeLeaf(l)); }
  private digests(): Hex[] { return this.leaves.map((l) => this.digest(l)); }
  root(): Hex { return referenceRoot(this.digests(), this.pair); }
  size(): number { return this.leaves.length; }
  /**
   * The published leaf set for this root — what a peer feeds to `auditCommitment`. Copies, so an
   * auditor holding a snapshot cannot be mutated out from under (and cannot mutate the tree).
   * Publishing it costs nothing in privacy here: the values are already committed, and the audit
   * is the only way a peer establishes the list is well-formed (file header, scope 2).
   */
  leafSet(): IndexedLeaf[] { return this.leaves.map((l) => ({ ...l })); }

  /** Active low leaf for v: not tombstoned, value < v, and (next > v OR next == 0 tail). Value-0 only if sentinel. */
  private lowLeafIndex(v: bigint): number {
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (l.tombstoned) continue;
      if (l.value === 0n && i !== 0) continue; // tombstone guard: only the sentinel may be value 0
      if (l.value < v && (l.next > v || l.next === 0n)) return i;
    }
    return -1;
  }
  private activeValueIndex(v: bigint): number {
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (!l.tombstoned && l.value === v) return i;
    }
    return -1;
  }

  /** Insert v (v > 0, not already active), maintaining the sorted linked list. Two leaf writes. */
  insert(v: bigint): void {
    if (v <= 0n) throw new Error('LeanIMTPlus.insert: value must be > 0 (0 reserved for sentinel)');
    if (this.activeValueIndex(v) !== -1) throw new Error(`LeanIMTPlus.insert: value ${v} already active`);
    const li = this.lowLeafIndex(v);
    if (li === -1) throw new Error(`LeanIMTPlus.insert: no low leaf for ${v} (corrupt list)`);
    const low = this.leaves[li]!;
    const inserted: IndexedLeaf = { value: v, next: low.next, tombstoned: false };
    low.next = v;                 // relink predecessor to point at the new value
    this.leaves.push(inserted);   // append the new leaf
  }

  /** Provable retraction: unlink v from the active chain and tombstone its leaf (history preserved). */
  revoke(v: bigint): void {
    const vi = this.activeValueIndex(v);
    if (vi === -1) throw new Error(`LeanIMTPlus.revoke: value ${v} not active`);
    let pi = -1;
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (!l.tombstoned && l.next === v) { pi = i; break; }
    }
    if (pi === -1) throw new Error(`LeanIMTPlus.revoke: no predecessor for ${v}`);
    const vLeaf = this.leaves[vi]!;
    this.leaves[pi]!.next = vLeaf.next; // predecessor skips over v → v now provably absent
    vLeaf.tombstoned = true;            // tombstone (guarded from ever being a low leaf)
    vLeaf.value = 0n; vLeaf.next = 0n;
  }

  private witnessAt(index: number): InclusionWitness {
    return { index, leaf: { ...this.leaves[index]! }, path: referenceProof(this.digests(), index, this.pair) };
  }
  /** Witness that v is currently a member (active). Throws if not active. */
  membershipProof(v: bigint): InclusionWitness {
    const i = this.activeValueIndex(v);
    if (i === -1) throw new Error(`LeanIMTPlus.membershipProof: value ${v} not active`);
    return this.witnessAt(i);
  }
  /** Witness that v is absent (never inserted, or revoked) — via its active low leaf. */
  nonMembershipProof(v: bigint): NonMembershipWitness {
    const li = this.lowLeafIndex(v);
    if (li === -1) throw new Error(`LeanIMTPlus.nonMembershipProof: value ${v} appears present or list corrupt`);
    return { lowLeaf: this.witnessAt(li) };
  }
}

// ── Stateless verifiers (what a peer / HAL / on-chain contract runs against a committed root) ──

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/** v is a current member of the memory committed to `root`. */
export function verifyMembership(v: bigint, w: InclusionWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  if (w.leaf.tombstoned || w.leaf.value !== v) return false;
  return verifyInclusion(leafHash(encodeLeaf(w.leaf)), w.path, root, pair);
}

/** Leftmost-slot test derived from data the ROOT binds. See `isSentinelSlot` note in verifyNonMembership. */
function pathIsLeftmost(path: ProofStep[]): boolean {
  return path.every((s) => !s.siblingOnLeft);
}

/** v is provably ABSENT from the memory committed to `root` (never inserted, or revoked). */
export function verifyNonMembership(v: bigint, w: NonMembershipWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  const L = w.lowLeaf.leaf;
  if (L.tombstoned) return false;
  // A value-0 low leaf can only honestly be the SENTINEL — and `w.lowLeaf.index` cannot establish
  // that, because it is SELF-REPORTED and bound by nothing: `verifyInclusion` folds the path and
  // never reads the index, so an adversary claims 0 for free. Derive the slot from the PATH, which
  // the root DOES bind: a leaf is leftmost iff its sibling is on the right at EVERY level (a lone
  // promoted node always sits at an even position, so promotion never hides a left-sibling step).
  if (L.value === 0n && !pathIsLeftmost(w.lowLeaf.path)) return false;
  const ordered = L.value < v && (L.next > v || L.next === 0n);
  if (!ordered) return false;
  return verifyInclusion(leafHash(encodeLeaf(L)), w.lowLeaf.path, root, pair);
}

/** Current-validity = active membership. After revoke(v) this FAILS while non-membership(v) succeeds. */
export function verifyCurrentValidity(v: bigint, w: InclusionWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  return verifyMembership(v, w, root, leafHash, pair);
}

/** Result of a whole-commitment audit. `violations` is diagnostic, not a security boundary — trust `ok`. */
export interface CommitmentAudit { ok: boolean; violations: string[]; activeCount: number }

/** Cap so a hostile list cannot make the report itself the payload. */
const MAX_VIOLATIONS = 32;

/**
 * Default bound on how large a published list this audit will process. NOT a property of the
 * construction — a wall-clock budget, and the only thing standing between an untrusted `length`
 * and unbounded work.
 *
 * Chosen against a measurement, not invented. A WELL-FORMED audit costs ~250us/leaf, dominated by
 * the Poseidon2 re-derivation of the root (measured on the default hashes: n=256 61ms, n=1024
 * 276ms, n=4096 997ms, n=16384 4.4s — linear). So 16384 is "a peer audits a root in a few
 * seconds"; 1e6 leaves would be ~4 minutes of honest work, which is a denial of service whether or
 * not the list is malformed.
 *
 * That measurement is also why the obvious cheap fix is the wrong one. A sparse array costs the
 * publisher nothing (`new Array(4e9)` is O(1)) and the shape scan ~69ns/element, so early-exiting
 * that scan looks like the fix — but at 3,600x cheaper per element than hashing, the scan is not
 * where the time goes. Only bounding `n` before any work bounds the work.
 *
 * Raise it deliberately via `opts.maxLeaves` if you accept the cost for a larger memory; the
 * default refuses rather than hangs. Bounds the NUMBER of element accesses, not the cost of each:
 * an exotic accessor that does unbounded work per read is out of reach of any in-process cap.
 */
export const MAX_AUDIT_LEAVES = 16384;

/**
 * A published element must be SHAPED like a leaf before any invariant about it means anything.
 *
 * Every step of the audit indexes the array and dereferences the element; a hole, a `null`, or a
 * JSON-transported leaf whose `value` is still a string would otherwise reach `.tombstoned` and
 * throw — the denial-of-service class #240/#245 closed in the per-witness verifiers, arriving here
 * one level up (in the *element*, not the field).
 *
 * Deliberately strict, and deliberately NOT coercing: `encodeLeaf` stringifies, so `'5'` and `5n`
 * hash identically and a coerced list would re-derive the right root while every ordering check
 * (`<`, `>`, `!== 0n`) compared across types. Soundness would then turn on a cast. A JSON caller
 * parses its own bigints and gets `malformed-leaf@i` until it does.
 */
function isLeafShape(x: unknown): x is IndexedLeaf {
  return typeof x === 'object' && x !== null
    && typeof (x as IndexedLeaf).value === 'bigint'
    && typeof (x as IndexedLeaf).next === 'bigint'
    && typeof (x as IndexedLeaf).tombstoned === 'boolean';
}

/**
 * Audit a PUBLISHED leaf set against a committed `root` — scope (2) in the file header.
 *
 * This is what makes non-membership sound against a committer who is not assumed honest. The
 * per-witness verifiers must assume the committed list is well-formed; nothing in a single witness
 * establishes that. Here the whole list is checked once, and the check is bound to the commitment
 * by re-deriving the root from the same leaves (a list that audits clean but hashes to a different
 * root says nothing about `root`).
 *
 * Invariants, and what each one stops:
 *   - `malformed-leaf@i` — the element is not a leaf (a hole, a `null`, a JSON-transported leaf
 *     whose bigints are still strings). Checked BEFORE anything dereferences an element, because
 *     every check below indexes the array; without it a `null` element is a TypeError, not a
 *     verdict. Returns immediately: no invariant about a list means anything if it is not a list
 *     of leaves.
 *   - `root-mismatch` — the audited list is not the list behind this root. Checked first among the
 *     content invariants; every other finding is meaningless without it.
 *   - `sentinel-*` — index 0 must be the untombstoned value-0 sentinel. It is the only legal
 *     value-0 low leaf and the head of the chain.
 *   - `value-0-leaf-outside-sentinel-slot` — a planted untombstoned value-0 leaf is the universal
 *     absence oracle of the Beat-50 forgery. Refused here at the list level, independent of the
 *     per-witness path check.
 *   - `tombstone-not-canonical` — `revoke` zeroes a tombstoned leaf; a tombstone that kept a value
 *     is a leaf that never came from this construction.
 *   - `duplicate-active-value` — two active leaves with one value make membership ambiguous.
 *   - `chain-*` / `active-leaf-not-in-chain` — the `next` chain must start at the sentinel, strictly
 *     increase, terminate at 0, and REACH EVERY ACTIVE LEAF. The coverage clause is the one that
 *     catches a sentinel whose `next` skips over a live value — the gap no single witness sees.
 *
 *   - `leaf-set-too-large@n>max` — the list exceeds `opts.maxLeaves` (default `MAX_AUDIT_LEAVES`).
 *     Checked FIRST, before the shape scan and before a single hash, because it is the only clause
 *     that bounds the work the others cost.
 *
 * Pure, TOTAL, and TERMINATING on untrusted input — three properties, and the first two do not
 * imply the third. A verifier that throws on hostile input is a denial-of-service (#240/#245); so
 * is one that returns eventually. `auditCommitment` reads a `length` it does not control, so
 * "never throws" bought nothing against `new Array(4e9)`: no exception, no result, ~5 minutes of
 * scanning a verdict already decided at index 0. Liveness needs its own bound, and the bound is
 * the size cap.
 *
 * Totality is enforced HERE, at the boundary, and not by the shape check alone. `isLeafShape` reads
 * properties off an untrusted object, so it is itself a throw site — an element with a throwing
 * accessor escapes every per-field guard by construction, because the guard has to touch the field
 * to judge it. No enumeration of field-level checks closes that; only an outer boundary does.
 * Fail-closed is the correct direction for a verifier: an input the audit cannot process is exactly
 * an input whose well-formedness it has not established, so `ok: false` is the honest verdict, and
 * the distinct `audit-threw` violation keeps it visible rather than silently indistinguishable from
 * a structural finding.
 */
export function auditCommitment(leaves: IndexedLeaf[], root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair, opts: AuditOpts = {}): CommitmentAudit {
  try { return auditCommitmentInner(leaves, root, leafHash, pair, opts); }
  catch { return { ok: false, violations: ['audit-threw'], activeCount: 0 }; }
}

/** `maxLeaves`: opt into a larger (slower) audit with eyes open — see `MAX_AUDIT_LEAVES`. */
export interface AuditOpts { maxLeaves?: number }

function auditCommitmentInner(leaves: IndexedLeaf[], root: Hex, leafHash: LeafHash, pair: Hash2, opts: AuditOpts): CommitmentAudit {
  const violations: string[] = [];
  const flag = (m: string): void => { if (violations.length < MAX_VIOLATIONS) violations.push(m); };
  const done = (activeCount: number): CommitmentAudit => ({ ok: violations.length === 0, violations, activeCount });

  if (!Array.isArray(leaves) || leaves.length === 0) { flag('empty-leaf-set'); return done(0); }

  // 1. Size, before the shape scan and before a single hash. This is the liveness bound: every
  //    clause below is O(n) in a length the publisher chose, so it is the first thing checked.
  const maxLeaves = opts.maxLeaves ?? MAX_AUDIT_LEAVES;
  if (leaves.length > maxLeaves) { flag(`leaf-set-too-large@${leaves.length}>${maxLeaves}`); return done(0); }

  // 2. Shape, before anything dereferences an element. Returned on, so every `leaves[i]!` below is
  //    a real leaf by construction rather than by hope.
  let shaped = true;
  for (let i = 0; i < leaves.length; i++) if (!isLeafShape(leaves[i])) { flag(`malformed-leaf@${i}`); shaped = false; }
  if (!shaped) return done(0);

  // 3. Bind the audit to the commitment. Everything below is about THIS root only if this passes.
  let derived: Hex | null = null;
  try { derived = referenceRoot(leaves.map((l) => leafHash(encodeLeaf(l))), pair); } catch { flag('leaf-set-unhashable'); }
  if (derived !== root) flag('root-mismatch');

  // 4. Sentinel slot.
  const sentinel = leaves[0]!;
  if (sentinel.tombstoned) flag('sentinel-tombstoned');
  if (sentinel.value !== 0n) flag('sentinel-value-not-zero');

  // 5. Per-leaf invariants, and the active set the chain must cover.
  const active = new Set<number>();
  const byValue = new Map<string, number>();
  for (let i = 1; i < leaves.length; i++) {
    const l = leaves[i]!;
    if (l.tombstoned) {
      if (l.value !== 0n || l.next !== 0n) flag(`tombstone-not-canonical@${i}`);
      continue;
    }
    if (l.value === 0n) { flag(`value-0-leaf-outside-sentinel-slot@${i}`); active.add(i); continue; }
    const k = String(l.value);
    if (byValue.has(k)) flag(`duplicate-active-value:${k}`); else byValue.set(k, i);
    active.add(i);
  }

  // 6. Walk the next-chain from the sentinel. Bounded by the leaf count, so a cycle terminates.
  const visited = new Set<number>();
  let cur: IndexedLeaf = sentinel;
  let prev = 0n;
  for (let steps = 0; cur.next !== 0n; steps++) {
    if (steps >= leaves.length) { flag('chain-longer-than-leaf-set'); break; }
    const nxt = cur.next;
    if (!(nxt > prev)) { flag(`chain-not-strictly-increasing:${String(prev)}->${String(nxt)}`); break; }
    const idx = byValue.get(String(nxt));
    if (idx === undefined) { flag(`chain-points-at-non-active-value:${String(nxt)}`); break; }
    if (visited.has(idx)) { flag(`chain-revisits-leaf@${idx}`); break; }
    visited.add(idx);
    prev = nxt;
    cur = leaves[idx]!;
  }

  // 7. Coverage — an active leaf the chain never reaches is a value the sentinel skipped.
  for (const i of active) if (!visited.has(i)) flag(`active-leaf-not-in-chain@${i}`);

  return done(visited.size);
}
