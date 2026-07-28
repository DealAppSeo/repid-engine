/**
 * memory-publication.ts — the PUBLICATION CHANNEL for a proof-carrying memory root (D-094, Patent #1).
 *
 * `auditCommitment` establishes that a published leaf set is a well-formed commitment, which is what
 * makes the cheap per-witness proofs sound against a committer who is not assumed honest. But an
 * audit is only ever an audit OF SOMETHING, and until now nothing in the system could hand a peer
 * the pair it audits: `ProofCarryingMemory` exposed `root()` and never the list, so the property was
 * real, provable in tests, and unobtainable in deployment.
 *
 * This module is that pair, plus the one binding the audit cannot supply on its own.
 *
 * THE CHAIN OF TRUST, end to end:
 *   1. the agent commits entries               → root R at epoch E
 *   2. the agent anchors (E, R) on EAS         → `anchorMemoryRoot` (already built, P3)
 *   3. the agent publishes the leaf set for E  → `publishMemory`            ← this file
 *   4. a peer audits the list against R AND against the on-chain anchor → `verifyPublication`
 *   5. thereafter every O(log n) per-witness proof against R is sound
 *
 * Step 4 is the whole point, and it has two halves that are easy to mistake for one. The audit binds
 * the LIST to the ROOT (it re-derives R from the leaves). Only the anchor binds the ROOT to a TIME
 * and a PURPOSE. An audited-but-unanchored root is a root the committer asserted about itself: the
 * list is well-formed, and the committer remains free to have produced a different well-formed list
 * a moment earlier and shown that one instead. Which is to say: the audit buys well-formedness, not
 * currency, and "current-valid" is the claim Patent #1 actually makes.
 *
 * WHAT THIS DOES NOT BUY, stated so it is not assumed:
 *   • It does not fetch anything. The anchor fields are an INPUT (see `decodeAnchorFields`). The
 *     soundness core is pure and synchronous; the network lives at the caller's edge, where its
 *     failure modes are visible instead of folded into a boolean.
 *   • It does not establish that the anchored epoch is the LATEST epoch — only that the published
 *     one is the anchored one. Detecting a withheld later epoch needs the anchor stream, not a
 *     single anchor, and is the next thing this channel needs (batched/epoch publication).
 *   • An audit is valid for exactly ONE root, and the root changes on every insert and revoke, so
 *     this is O(n) per published epoch. Publishing every write does not scale; publishing epochs
 *     does. The epoch field is what makes that possible, which is the second reason it must be
 *     checked rather than merely written.
 */
import {
  auditCommitment, MAX_AUDIT_LEAVES,
  type CommitmentAudit, type IndexedLeaf, type Hex, type LeafHash,
} from './leanimt-plus';
import type { Hash2 } from './proof-carrying-index';
import type { ProofCarryingMemory } from './proof-carrying-memory';
import { MEMORY_ROOT_PROOF_TYPE, type AnchorFields } from './memory-root-anchor';

/** What an agent publishes for one epoch: the commitment, and the list it commits to. */
export interface MemoryPublication {
  epoch: number;
  root: Hex;
  leaves: IndexedLeaf[];
}

/** What a peer already knows and requires of the publication. */
export interface PublicationExpectation {
  /** Decoded on-chain anchor for this epoch. Omitted ⇒ the publication is unanchored ⇒ NOT `ok`. */
  anchor?: AnchorFields | null;
  agentId?: string;
  tier?: string;
  maxLeaves?: number;
}

/**
 * Two properties, reported separately and deliberately not collapsed into one word: `audit.ok` is
 * well-formedness, `anchorBound` is currency-and-purpose. `ok` requires BOTH, because that pair is
 * what "this is the agent's memory as of epoch E" means. A caller that genuinely wants only the
 * offline half reads `audit.ok` and has thereby said so.
 */
export interface PublicationVerdict {
  ok: boolean;
  audit: CommitmentAudit;
  anchorBound: boolean;
  reasons: string[];
}

/** Publish the committed leaf set for an epoch. Pure w.r.t. the memory (the leaf set is copied). */
export function publishMemory(memory: ProofCarryingMemory, epoch: number): MemoryPublication {
  return { epoch, root: memory.root(), leaves: memory.leafSet() };
}

const MAX_REASONS = 32;

/**
 * Verify a published memory against its commitment and its on-chain anchor.
 *
 * Clauses, and what each one stops:
 *   - `publication-malformed`        — the publication is not a publication (not an object, root not
 *                                      a string, leaves not an array). Checked first; nothing below
 *                                      means anything otherwise.
 *   - `epoch-not-a-safe-integer`     — the epoch is compared to a `uint64` as a bigint, and
 *                                      `BigInt(1.5)` throws. A publication that cannot be placed in
 *                                      time is refused rather than coerced into a time. This clause
 *                                      is a TERM OF `ok` in its own right, not merely a reported
 *                                      reason: for a FRACTIONAL epoch the anchor comparison happens
 *                                      to refuse too (`BigInt` would throw, so the guard short-
 *                                      circuits to a mismatch), but for a NEGATIVE one it does not —
 *                                      `BigInt(-5)` is a perfectly good bigint, so an anchor carrying
 *                                      `proofId: -5n` binds cleanly and the publication verified
 *                                      `ok: true` while carrying this very reason. A clause that is
 *                                      computed, named, and then not read is the exact defect this
 *                                      module was written to close on `proofType`/`proofId`; it is
 *                                      not permitted one level up in the module's own verdict.
 *   - `commitment-audit-failed`      — the leaf set is not a well-formed commitment to this root.
 *                                      Delegated whole to `auditCommitment`; its findings are
 *                                      carried in `audit.violations`, not duplicated here.
 *   - `unanchored-publication`       — no anchor supplied. Fail-closed: a root with no anchor is a
 *                                      root with no time, and this verifier does not silently
 *                                      downgrade to the weaker claim.
 *   - `anchor-root-mismatch`         — the anchor commits to a different root than the one published.
 *   - `anchor-proof-type-mismatch`   — the anchor is not a memory-root anchor. DOMAIN SEPARATION:
 *                                      the encoder's default `proofType` is `'POSTCARD'`, so without
 *                                      this clause any other attestation of the same agent/tier/root
 *                                      satisfies a memory-root check.
 *   - `anchor-epoch-mismatch`        — the anchor was made for a different epoch. FRESHNESS: this is
 *                                      the field `buildMemoryRootAttest` carries on purpose and that
 *                                      the existing three-field comparison decodes and discards.
 *   - `anchor-agent-mismatch` / `anchor-tier-mismatch` — the anchor is someone else's, or claims a
 *                                      different tier. Only checked when the peer states an
 *                                      expectation, since a peer that does not know who it is
 *                                      talking to cannot have one.
 *
 * Pure, TOTAL, and TERMINATING on untrusted input — the three properties `auditCommitment` had to
 * learn separately. Totality is enforced at an outer boundary rather than by the field checks alone,
 * because every field check must dereference the untrusted object to judge it (an accessor that
 * throws escapes any enumeration of per-field guards). Termination is inherited: the only unbounded
 * work is the audit, and the audit bounds itself by leaf count before it hashes anything.
 */
export function verifyPublication(
  pub: MemoryPublication, expect: PublicationExpectation = {},
  leafHash?: LeafHash, pair?: Hash2,
): PublicationVerdict {
  try { return verifyPublicationInner(pub, expect, leafHash, pair); }
  catch {
    return {
      ok: false, anchorBound: false, reasons: ['verify-threw'],
      audit: { ok: false, violations: ['audit-not-reached'], activeCount: 0 },
    };
  }
}

function verifyPublicationInner(
  pub: MemoryPublication, expect: PublicationExpectation,
  leafHash?: LeafHash, pair?: Hash2,
): PublicationVerdict {
  const reasons: string[] = [];
  const flag = (m: string): void => { if (reasons.length < MAX_REASONS) reasons.push(m); };
  const noAudit: CommitmentAudit = { ok: false, violations: ['audit-not-reached'], activeCount: 0 };

  if (typeof pub !== 'object' || pub === null || typeof pub.root !== 'string' || !Array.isArray(pub.leaves)) {
    return { ok: false, anchorBound: false, reasons: ['publication-malformed'], audit: noAudit };
  }
  const epochOk = typeof pub.epoch === 'number' && Number.isSafeInteger(pub.epoch) && pub.epoch >= 0;
  if (!epochOk) flag('epoch-not-a-safe-integer');

  // Well-formedness. Delegated whole — this module adds no invariant of its own about leaves.
  const opts = expect.maxLeaves === undefined ? {} : { maxLeaves: expect.maxLeaves };
  const audit = auditCommitment(pub.leaves, pub.root, leafHash, pair, opts);
  if (!audit.ok) flag('commitment-audit-failed');

  // Currency and purpose. The half no audit of a list can supply.
  const a = expect.anchor;
  let anchorBound = false;
  if (a === undefined || a === null) {
    flag('unanchored-publication');
  } else {
    const before = reasons.length;
    if (typeof a.merkleRoot !== 'string' || a.merkleRoot.toLowerCase() !== pub.root.toLowerCase()) flag('anchor-root-mismatch');
    if (a.proofType !== MEMORY_ROOT_PROOF_TYPE) flag('anchor-proof-type-mismatch');
    if (typeof a.proofId !== 'bigint' || !Number.isSafeInteger(pub.epoch) || a.proofId !== BigInt(pub.epoch)) flag('anchor-epoch-mismatch');
    if (expect.agentId !== undefined && a.agentId !== expect.agentId) flag('anchor-agent-mismatch');
    if (expect.tier !== undefined && a.tier !== expect.tier) flag('anchor-tier-mismatch');
    anchorBound = reasons.length === before;
  }

  // `anchorBound` deliberately stays a report of the anchor↔publication relation as checked: with a
  // negative epoch the anchor really does carry the matching `proofId`, so the binding held — it is
  // the TIME that is not a time. The verdict is where that has to bite, so the terms are spelled out.
  // The trailing `reasons.length === 0` is the structural half: it makes every clause above, and
  // every clause a later beat adds, verdict-bearing by construction rather than by remembering to
  // wire it in. Fail-closed is the right default for a term nobody has thought about yet.
  const ok = audit.ok && anchorBound && epochOk && reasons.length === 0;
  return { ok, audit, anchorBound, reasons };
}

/** Re-exported so a caller wiring a publication channel does not have to know where the cap lives. */
export { MAX_AUDIT_LEAVES };
