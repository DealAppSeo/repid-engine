/**
 * proof-carrying-memory.ts — P2 of PROOF_CARRYING_RETRIEVAL_v0 (D-094).
 *
 * The retrieval API + ANSWER-BINDING — the keystone
 * ("binding the verified proof set into the agent's output"):
 *   • retrieval returns each entry WITH an inclusion / current-validity proof
 *     against the committed memory root (revoked entries are excluded — a
 *     retracted fact can no longer be retrieved or cited);
 *   • an agent's answer is BOUND to the exact proof-set it cited, so the answer
 *     is grounded, tamper-evident, non-repudiable, and (after a cited entry is
 *     revoked) provably stale;
 *   • `emitGroundedAnswer` ABSTAINS (throws) unless every citation verifies —
 *     the HAL knowledge-boundary primitive: no proof ⇒ no answer.
 *
 * Built on P1 `LeanIMTPlus` (membership + provable retraction) + the Poseidon2
 * leaf. Hashes are injected (default = real Poseidon2) so it is free + testable.
 * Content lives OFF-index; only its commitment (the derived value) is in the tree.
 */
import {
  LeanIMTPlus, verifyMembership,
  type InclusionWitness, type NonMembershipWitness, type IndexedLeaf, type Hex, type LeafHash,
} from './leanimt-plus';
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';
import type { Hash2 } from './proof-carrying-index';

/** A reputation-weighted memory entry. `content` is stored off-index; its commitment is the tree value. */
export interface MemoryEntry {
  content: string;
  source_id: string;
  source_repid: number;
  hal_verdict: string; // clean | flagged | vetoed | …
  epoch: number;
}
export interface RetrievedEntry { entry: MemoryEntry; value: string; witness: InclusionWitness; }
export interface Citation { content: string; value: string; witness: InclusionWitness; }
export interface ProofCarryingAnswer {
  answer: string;
  memory_root: Hex;
  citations: Citation[];
  binding: Hex; // commitment over answer ‖ root ‖ citation-set
}
export interface AnswerVerification {
  grounded: boolean;
  binding_ok: boolean;
  verified_citations: number;
  total_citations: number;
  reasons: string[];
}
export interface PcmOptions { leafHash?: LeafHash; pairHash?: Hash2; }

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/**
 * Canonical, domain-separated serialization of an entry → its committed value key.
 * Exported so a content-persistence boundary (memory-content-store.ts) can verify a stored
 * row's `content` actually hashes to the `value` it claims, without re-deriving this format
 * itself and risking drift from what the tree was actually built against.
 */
export function encodeEntry(e: MemoryEntry): string {
  return `pcr.entry.v0|${e.content}|${e.source_id}|${e.source_repid}|${e.hal_verdict}|${e.epoch}`;
}

// ── The memory: an append-only, revocable, proof-carrying index ────────────────
export class ProofCarryingMemory {
  private readonly tree: LeanIMTPlus;
  private readonly store = new Map<string, MemoryEntry>(); // value(string) → entry (off-index content)
  private readonly leafHash: LeafHash;
  private readonly pair: Hash2;

  constructor(opts: PcmOptions = {}) {
    this.leafHash = opts.leafHash ?? dfltLeaf;
    this.pair = opts.pairHash ?? dfltPair;
    this.tree = new LeanIMTPlus({ leafHash: this.leafHash, pairHash: this.pair });
  }

  /** Content-addressed value = numeric interpretation of the entry's leaf commitment. */
  private valueOf(e: MemoryEntry): bigint {
    return BigInt(this.leafHash(encodeEntry(e)));
  }

  /** Commit an entry. Idempotent (re-adding identical content returns the same value). */
  add(e: MemoryEntry): string {
    const v = this.valueOf(e);
    const key = v.toString();
    if (!this.store.has(key)) {
      this.tree.insert(v);
      this.store.set(key, e);
    }
    return key;
  }

  /** Provable retraction — the entry can no longer be retrieved or cited; non-membership now proves. */
  revoke(value: string): void {
    this.tree.revoke(BigInt(value));
  }

  root(): Hex { return this.tree.root(); }
  get(value: string): MemoryEntry | undefined { return this.store.get(value); }

  /**
   * The committed leaf set — the AUDIT'S INPUT, and the only thing that makes non-membership sound
   * against a committer who is not assumed honest (`auditCommitment`, scope 2).
   *
   * Until this existed the memory exposed `root()` and nothing else, so a peer could obtain a root
   * but never the list behind it: the whole-commitment audit was reachable only from tests, and the
   * deployed non-membership guarantee stayed scope-1 — sound only *relative to* a well-formed
   * commitment that nothing could check. Defensive copy (`LeanIMTPlus.leafSet` copies each leaf), so
   * a published list cannot be aliased back into the tree.
   *
   * Leaks no content: leaves carry the derived value only, and content lives off-index in `store`.
   */
  leafSet(): IndexedLeaf[] { return this.tree.leafSet(); }

  /** Membership witness for an ACTIVE entry (throws if revoked/absent — used by the abstain path). */
  membershipWitness(value: string): InclusionWitness { return this.tree.membershipProof(BigInt(value)); }
  /** Non-membership witness — proves a value is absent (never added, or revoked). */
  nonMembershipWitness(value: string): NonMembershipWitness { return this.tree.nonMembershipProof(BigInt(value)); }

  /** Retrieve active entries matching `predicate`, each WITH a verifying inclusion proof. */
  retrieve(predicate: (e: MemoryEntry) => boolean): RetrievedEntry[] {
    const out: RetrievedEntry[] = [];
    for (const [value, entry] of this.store) {
      if (!predicate(entry)) continue;
      try {
        const witness = this.membershipWitness(value); // throws if revoked → excluded
        out.push({ entry, value, witness });
      } catch { /* revoked/absent → not retrievable */ }
    }
    return out;
  }
}

// ── Answer-binding (pure, stateless — what an agent emits and a peer/HAL verifies) ──

/** Order-sensitive digest over the cited (value, content) pairs. */
function citationsDigest(citations: Citation[], leafHash: LeafHash, pair: Hash2): Hex {
  let acc = leafHash('pcr.citations.v0');
  for (const c of citations) acc = pair(acc, leafHash(`${c.value}|${c.content}`));
  return acc;
}

/** Bind an answer to the exact proof-set it cited. The binding commits answer ‖ root ‖ citations. */
export function bindAnswer(
  answer: string, citations: Citation[], memory_root: Hex,
  leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair,
): ProofCarryingAnswer {
  const binding = pair(leafHash(`pcr.answer.v0|${answer}`), pair(memory_root, citationsDigest(citations, leafHash, pair)));
  return { answer, memory_root, citations, binding };
}

/** Verify a proof-carrying answer: the binding is intact AND every citation is a current member of memory_root. */
export function verifyProofCarryingAnswer(
  pca: ProofCarryingAnswer, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair,
): AnswerVerification {
  const reasons: string[] = [];
  // Adversarial-input safe applies to the BINDING too, not just the citation loop below: a peer/HAL
  // runs this on UNTRUSTED agent output, so a malformed root (or a citations field that isn't a list)
  // must make the binding UNCOMPUTABLE — it must never throw out of the verifier. Reported under its
  // own reason: "we could not compute a binding" is a different claim from "we computed one and it
  // disagreed", and an abstain decision should not misreport which one happened.
  const citations: Citation[] = Array.isArray(pca?.citations) ? pca.citations : [];
  let expected: Hex | null = null;
  try { expected = bindAnswer(pca.answer, citations, pca.memory_root, leafHash, pair).binding; }
  catch { expected = null; }
  const binding_ok = expected !== null && expected === pca.binding;
  if (!binding_ok) reasons.push(expected === null ? 'binding_uncomputable' : 'binding_mismatch');

  let verified = 0;
  for (const c of citations) {
    // Adversarial-input safe: a malformed value/witness (e.g. non-canonical hex) counts as
    // UNVERIFIED, it never crashes the verifier — a peer/HAL checks untrusted answers.
    // The failure LABEL is built inside the guard too. Stringifying `c.value` is itself untrusted
    // work — an accessor or a throwing `toString` escapes a catch that only wraps the verification,
    // which would throw out of computeGroundingSignal ("Never throws") and out of the scoring
    // pipeline. A citation we cannot even name is still just an unverified citation.
    let ok = false;
    let label = '?';
    try {
      label = String(c?.value ?? '').slice(0, 12);
      ok = verifyMembership(BigInt(c.value), c.witness, pca.memory_root, leafHash, pair);
    } catch { ok = false; }
    if (ok) verified++;
    else reasons.push(`citation_unverified:${label}…`);
  }
  const grounded = binding_ok && citations.length > 0 && verified === citations.length;
  return { grounded, binding_ok, verified_citations: verified, total_citations: citations.length, reasons };
}

/**
 * Guarded emit (HAL knowledge-boundary / abstain): build a proof-carrying answer only if EVERY cited
 * value is a current member of memory. If any is revoked/absent, THROW — the agent must abstain rather
 * than answer ungrounded. This is the enforcement that makes "grounded" the default, not the exception.
 */
export function emitGroundedAnswer(
  answer: string, memory: ProofCarryingMemory, citedValues: string[],
  leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair,
): ProofCarryingAnswer {
  if (citedValues.length === 0) throw new Error('abstain: an answer must cite at least one committed memory entry');
  const root = memory.root();
  const citations: Citation[] = [];
  for (const v of citedValues) {
    const entry = memory.get(v);
    if (!entry) throw new Error(`abstain: cited value ${v.slice(0, 12)}… is not in memory`);
    // A REVOKED citation is the abstain case this primitive exists for, and it must surface as an
    // ABSTENTION — not as the accumulator's internal "not active" error. `membershipProof` throws
    // its own low-level message, and a caller that distinguishes a principled abstain from a bug
    // (the whole point of the `abstain:` contract) would mis-classify a retraction as a fault.
    // The underlying cause is preserved in the message rather than swallowed.
    let witness: InclusionWitness;
    try {
      witness = memory.membershipWitness(v);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new Error(`abstain: cited value ${v.slice(0, 12)}… is not currently valid (${cause})`);
    }
    citations.push({ content: entry.content, value: v, witness });
  }
  const pca = bindAnswer(answer, citations, root, leafHash, pair);
  const check = verifyProofCarryingAnswer(pca, leafHash, pair);
  if (!check.grounded) throw new Error(`abstain: answer not grounded (${check.reasons.join(', ')})`);
  return pca;
}
