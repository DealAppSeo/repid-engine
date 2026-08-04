/**
 * delta-anchor.ts — what a batch of RepID delta STATEMENTS would commit to, and the
 * root computation + verification for it. Computes; never sends.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ════════════════════════════════════════════════════════════════════════════════
 * `repid_zkp_proofs` carries `eas_schema` and `eas_attestation_uid`, and both are
 * already used at scale: 22,244 rows carry an attestation UID under two schema labels
 * [V SQL 2026-08-04]. Delta statements have neither — there are ZERO `REPID_DELTA`
 * rows [V SQL 2026-08-04], because the statement layer is `off` by default.
 *
 * An anchor is worth building BEFORE those rows exist, for the same reason the
 * statement format was frozen before a circuit existed: a root computed one way and
 * verified another verifies nothing, and the cheapest moment to get it exact is while
 * nothing depends on it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE ROOT COMMITS TO — the whole answer, in one place
 * ════════════════════════════════════════════════════════════════════════════════
 * One anchor commits to FIVE things, all bound into a single 32-byte value:
 *
 *   1. THE ORDERED LIST OF STATEMENT DIGESTS. Each `statement_digest` already binds
 *      every public input of one delta (domain, both commitments, delta, both scores,
 *      the band, the formula commitment, the nullifier). So the root transitively
 *      binds every public field of every delta in the batch. Order is positional and
 *      part of the commitment.
 *   2. THE COUNT. Bound explicitly — see the malleability section; without it a batch
 *      of 3 and a batch of 4 with the last one repeated have the SAME tree root.
 *   3. THE DOMAIN. So a batch anchored under `hyperdag/repid/delta/v1` can never be
 *      re-presented as a batch from another vertical (Invariant 3).
 *   4. THE FORMULA COMMITMENT. This is what makes an anchor say something a single
 *      statement cannot: every delta under this root was scored against the SAME
 *      committed formula. If the formula were quietly changed for one favoured agent
 *      mid-epoch, that agent's statement carries a different `formula_commitment` and
 *      cannot be under this root at all.
 *   5. THE EPOCH LABEL, and an optional source RANGE (first/last scope label), so a
 *      root can be placed in time and — where the reader independently knows the range
 *      is dense — omissions become detectable.
 *
 * ── WHAT IT DOES NOT COMMIT TO, stated because these are the ways to misread it ──
 *   - NOT that any delta is correct. A statement is a claim with a canonical shape;
 *     `is_real=false`, `scheme='poseidon2-statement-v1'`, no `proof_bytes`. Anchoring
 *     a claim makes it TIMESTAMPED AND NON-REPUDIABLE, not true. An anchored wrong
 *     delta is a wrong delta you can no longer deny having published.
 *   - NOT COMPLETENESS. Nothing stops the batch builder from omitting an inconvenient
 *     delta. The count binds what IS in the batch, not what should have been. The
 *     optional range narrows this and does not close it; only a rule that the batch
 *     covers every row in a range, checked against the ledger, would.
 *   - NOT the nullifier's identity binding. That is unproven at the statement layer
 *     and anchoring inherits the gap unchanged. See `nullifier-identity.ts`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS DOES NOT CALL `buildRoot` FROM merkle-root.ts — a measured defect
 * ════════════════════════════════════════════════════════════════════════════════
 * `merkle-root.ts` builds Bitcoin-style trees: an odd level duplicates its last node.
 * That is CVE-2012-2459 and it is not theoretical here — `tests/zkp2-delta-anchor.test.ts`
 * runs it: under the `poseidon2` scheme, a 3-leaf batch and a 4-leaf batch whose last
 * leaf is repeated produce the IDENTICAL root. For an anchor whose job includes "these
 * N deltas", a root that cannot distinguish N from N+1 is the wrong primitive.
 *
 * `buildRoot` is NOT changed here, deliberately. It is load-bearing for the live
 * POSTCARD epoch anchor (`src/services/zkp-epoch-anchor.ts`) and for 4,573 rows that
 * already carry a `merkle_root` computed by it [V SQL 2026-08-04]; silently changing
 * the shape would invalidate them, and that is a separate, sequenced job with its own
 * migration. Instead this module builds its own tree over the SAME audited Poseidon2
 * primitives (`poseidon2Compress` / `poseidon2Sponge` / `fieldsToHex` — the parity-gated
 * ones from `poseidon2-leaf.ts`), with two changes:
 *
 *   - AN ODD NODE IS PROMOTED, not duplicated. There is no self-pairing, so the
 *     duplicate-padding collision has no expression.
 *   - THE COUNT IS ABSORBED into the final root. Even if a future tree shape changed,
 *     two batches of different sizes cannot share a root.
 *
 * ── Leaf/node domain separation ──────────────────────────────────────────────────
 * A leaf is `Sponge(LEAF_TAG ‖ domain ‖ digestBytes)`; an internal node is
 * `Compress(left, right)`. Sponge and TruncatedPermutation are different uses of the
 * permutation, so a leaf value and an internal-node value are produced by different
 * constructions and an internal node cannot be re-presented as a leaf. The explicit
 * `LEAF_TAG` makes that separation intentional rather than incidental.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NO TRANSACTION. NO DEFAULT SENDER.
 * ════════════════════════════════════════════════════════════════════════════════
 * `anchorDeltaBatch` takes the chain write as a REQUIRED injected argument with NO
 * default. `memory-root-anchor.ts` defaults its `attestFn` to the real `attestProof`,
 * which is reasonable there and is exactly the shape that turns "I called the builder"
 * into a funded on-chain send. This module has no import of `ethers`, no import of
 * `../services/eas-attestation-service`, and no import of `db`. It cannot send, cannot
 * write, and cannot be made to by a missing argument.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVARIANT COMPLIANCE (ZKP_ARCHITECTURE_INVARIANTS v1)
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. Poseidon2 over BabyBear ONLY, via the parity-gated primitives. No sha256, no
 *    keccak, no ethers hashing — pinned by a test that greps this module's source.
 * 2. Nothing here is scoped to reputation: `domain` and the labels are parameters.
 * 3. `domain` is absorbed into every leaf AND into the final root.
 * 5. No new proving surface, no Plonky3 pin touched.
 * 6. `REPID_DELTA_ANCHOR_DOMAIN` is the registry namespace key for this family.
 */

import { poseidon2Sponge, poseidon2Compress, fieldsToHex, hexToFields } from './poseidon2-leaf';
import { feltsFromHex, feltsFromString } from './nullifier-identity';

// ---------------------------------------------------------------------------
// Namespace + labels
// ---------------------------------------------------------------------------

/** Registry key for the anchor family (Invariant 6). Distinct from the statement domain. */
export const REPID_DELTA_ANCHOR_DOMAIN = 'hyperdag/repid/delta-anchor/v1';

export const DELTA_ANCHOR_LEAF_TAG = 'hyperdag/repid/delta-anchor/leaf/v1';
export const DELTA_ANCHOR_ROOT_TAG = 'hyperdag/repid/delta-anchor/root/v1';

/**
 * The value that would go in `repid_zkp_proofs.eas_schema` for anchored delta rows.
 *
 * A DATABASE LABEL, not an on-chain schema. The live table already distinguishes
 * `constitutional-compliance-v1` (56,823 rows) from `repid-postcard-epoch-v1` /
 * `repid-real-proof-batch-v1` (22,239 rows) the same way [V SQL 2026-08-04]. The
 * on-chain attestation would ride the ALREADY-REGISTERED
 * `constitutional-compliance-v1` schema — no new schema registration, no new on-chain
 * infrastructure — exactly as `memory-root-anchor.ts` does for memory roots.
 */
export const REPID_DELTA_ANCHOR_EAS_SCHEMA = 'repid-delta-statement-batch-v1';

/** `proofType` carried inside the attestation payload. The DOMAIN field of the anchor. */
export const REPID_DELTA_ANCHOR_PROOF_TYPE = 'REPID_DELTA_BATCH';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/**
 * Leaf := `Sponge(LEAF_TAG ‖ domain ‖ digestBytes)`.
 *
 * The digest is absorbed as its 32 RAW BYTES (`feltsFromHex`), not as the 66 characters
 * of its hex rendering. Both are injective; bytes are what a circuit will hold, and
 * absorbing the rendering would make the in-circuit and off-circuit leaves disagree —
 * the precise failure `poseidon2-leaf.ts` was parity-gated to prevent.
 */
export function deltaAnchorLeaf(statementDigest: string, domain: string): string {
  if (!HEX32.test(statementDigest)) {
    throw new Error(
      `[delta-anchor] a statement digest is 0x+64 hex, got '${statementDigest}'. ` +
        `statementDigest() from repid-delta-statement.ts always produces that shape, so a ` +
        `different one means the wrong field was passed.`,
    );
  }
  return fieldsToHex(
    poseidon2Sponge([
      ...feltsFromString(DELTA_ANCHOR_LEAF_TAG),
      ...feltsFromString(domain),
      ...feltsFromHex(statementDigest),
    ]),
  );
}

/** Internal node := `Compress(left, right)` — the audited TruncatedPermutation<2,8,16>. */
function node(aHex: string, bHex: string): string {
  return fieldsToHex(poseidon2Compress(hexToFields(aHex), hexToFields(bHex)));
}

/**
 * Tree root over pre-hashed leaves. An odd node is PROMOTED, never duplicated.
 *
 * Exported so the malleability test can compare it directly against `buildRoot` from
 * `merkle-root.ts` rather than take the difference on trust.
 */
export function deltaTreeRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) {
    throw new Error('[delta-anchor] refusing to build a root over an empty batch');
  }
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      if (i + 1 < level.length) {
        next.push(node(left, level[i + 1]!));
      } else {
        next.push(left); // PROMOTE — no self-pairing, so no duplicate-padding collision
      }
    }
    level = next;
  }
  return level[0]!;
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

export interface DeltaAnchorRange {
  /** First scope label covered, e.g. the first score-event id. */
  firstLabel: string;
  lastLabel: string;
}

export interface DeltaAnchorParams {
  /** `statement_digest` of each statement, in the order they are committed. */
  statementDigests: readonly string[];
  /** The STATEMENT domain (`REPID_DELTA_DOMAIN`), absorbed into every leaf. */
  domain: string;
  /** The one formula commitment every statement in the batch must carry. */
  formulaCommitment: string;
  /** Monotonic epoch label. Carried as `proofId` in the attestation payload. */
  epoch: number;
  range?: DeltaAnchorRange | null;
}

export interface DeltaAnchor {
  /** `0x`+64 hex. THE anchored value — see the header for exactly what it binds. */
  root: string;
  /** Root of the leaf tree alone, before the header is absorbed. Diagnostic. */
  treeRoot: string;
  /** The committed digests, in order. Kept so an inclusion proof can be built later. */
  statementDigests: string[];
  leaves: string[];
  leafCount: number;
  domain: string;
  formulaCommitment: string;
  epoch: number;
  range: DeltaAnchorRange | null;
}

/**
 * Compute the anchor root.
 *
 * `root := Sponge(ROOT_TAG ‖ domain ‖ formulaCommitmentBytes ‖ epoch ‖ leafCount ‖
 *                 rangeFirst ‖ rangeLast ‖ treeRootBytes)`
 *
 * Rejects duplicate digests. Two identical statement digests in one batch mean the
 * same delta was committed twice — the exact condition the nullifier exists to detect —
 * and silently anchoring it would inflate the count while the tree shape hides it.
 */
export function buildDeltaAnchor(p: DeltaAnchorParams): DeltaAnchor {
  if (p.statementDigests.length === 0) {
    throw new Error('[delta-anchor] refusing to anchor an empty batch');
  }
  if (!HEX32.test(p.formulaCommitment)) {
    throw new Error(
      `[delta-anchor] formula commitment must be 0x+64 hex, got '${p.formulaCommitment}'`,
    );
  }
  if (!Number.isInteger(p.epoch) || p.epoch < 0) {
    throw new Error(`[delta-anchor] epoch must be a non-negative integer, got ${p.epoch}`);
  }

  const seen = new Set<string>();
  for (const d of p.statementDigests) {
    const k = d.toLowerCase();
    if (seen.has(k)) {
      throw new Error(
        `[delta-anchor] duplicate statement digest ${d} in the batch. Two identical ` +
          `statements are the same delta committed twice; anchoring it would inflate the ` +
          `committed count while the tree shape hid the repeat.`,
      );
    }
    seen.add(k);
  }

  const leaves = p.statementDigests.map((d) => deltaAnchorLeaf(d, p.domain));
  const treeRoot = deltaTreeRoot(leaves);
  const range = p.range ?? null;

  const root = fieldsToHex(
    poseidon2Sponge([
      ...feltsFromString(DELTA_ANCHOR_ROOT_TAG),
      ...feltsFromString(p.domain),
      ...feltsFromHex(p.formulaCommitment),
      BigInt(p.epoch),
      BigInt(leaves.length),
      // A PRESENCE FLAG, then the labels.
      //
      // The flag is here because the first version of this absorbed only the labels,
      // substituting '' for an absent range — and the test caught that `range: null`
      // and `range: {firstLabel:'', lastLabel:''}` then produce the IDENTICAL root. An
      // anchor that cannot distinguish "no range was claimed" from "an empty range was
      // claimed" lets a builder assert a range after the fact. One field element fixes
      // it, so "no range" is now a committed choice rather than a hole.
      range ? 1n : 0n,
      ...feltsFromString(range ? range.firstLabel : ''),
      ...feltsFromString(range ? range.lastLabel : ''),
      ...feltsFromHex(treeRoot),
    ]),
  );

  return {
    root,
    treeRoot,
    statementDigests: p.statementDigests.map((d) => d.toLowerCase()),
    leaves,
    leafCount: leaves.length,
    domain: p.domain,
    formulaCommitment: p.formulaCommitment,
    epoch: p.epoch,
    range,
  };
}

// ---------------------------------------------------------------------------
// Inclusion
// ---------------------------------------------------------------------------

export interface DeltaInclusionProof {
  statementDigest: string;
  index: number;
  siblings: Array<{ hash: string; position: 'left' | 'right' }>;
  /** Everything the header absorbs, so a verifier can rebuild the root unaided. */
  leafCount: number;
  domain: string;
  formulaCommitment: string;
  epoch: number;
  range: DeltaAnchorRange | null;
  root: string;
}

/**
 * Inclusion proof for one statement.
 *
 * Levels where the node was PROMOTED contribute no sibling — the path is simply
 * shorter. That is unambiguous because `leafCount` is carried in the proof and bound
 * into the root, so the tree shape is fully determined by a value the verifier checks.
 */
export function buildDeltaInclusion(anchor: DeltaAnchor, index: number): DeltaInclusionProof {
  if (!Number.isInteger(index) || index < 0 || index >= anchor.leaves.length) {
    throw new Error(`[delta-anchor] index ${index} out of range 0..${anchor.leaves.length - 1}`);
  }
  const siblings: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let level = anchor.leaves.slice();
  let idx = index;

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      next.push(i + 1 < level.length ? node(left, level[i + 1]!) : left);
    }
    if (idx % 2 === 0) {
      if (idx + 1 < level.length) siblings.push({ hash: level[idx + 1]!, position: 'right' });
      // else: promoted, no sibling at this level
    } else {
      siblings.push({ hash: level[idx - 1]!, position: 'left' });
    }
    idx = Math.floor(idx / 2);
    level = next;
  }

  return {
    statementDigest: anchor.statementDigests[index]!,
    index,
    siblings,
    leafCount: anchor.leafCount,
    domain: anchor.domain,
    formulaCommitment: anchor.formulaCommitment,
    epoch: anchor.epoch,
    range: anchor.range,
    root: anchor.root,
  };
}

export interface DeltaInclusionVerdict {
  included: boolean;
  /** Why not, when not. Never a bare false. */
  reason: string | null;
  /** What a passing verdict still does NOT establish. Never empty. */
  unproven: string[];
}

/**
 * Recompute the root from a statement digest + its path, and compare.
 *
 * Total: any malformed input is a `false` with a reason, never a throw, because the
 * proof arrives from outside.
 */
export function verifyDeltaInclusion(proof: DeltaInclusionProof): DeltaInclusionVerdict {
  const unproven = [
    'that the anchored statement is CORRECT — a statement is a claim with a canonical ' +
      'shape (is_real=false, no proof_bytes); anchoring makes it non-repudiable, not true',
    'that the batch is COMPLETE — nothing prevents a builder omitting a delta; the root ' +
      'binds what is in the batch, not what should have been',
    'that the nullifier in the statement was derived from the secret behind its ' +
      'identity_commitment (unproven at the statement layer; the anchor inherits the gap)',
    'that the root was ever sent on-chain — this module computes and verifies only, and ' +
      'an on-chain UID must be checked against the chain separately',
  ];
  const fail = (reason: string): DeltaInclusionVerdict => ({ included: false, reason, unproven });

  try {
    if (!HEX32.test(proof.statementDigest)) return fail('statement digest is not 0x+64 hex');
    if (!HEX32.test(proof.root)) return fail('root is not 0x+64 hex');
    if (!Number.isInteger(proof.leafCount) || proof.leafCount < 1) {
      return fail(`leafCount ${proof.leafCount} is not a positive integer`);
    }
    if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= proof.leafCount) {
      return fail(`index ${proof.index} out of range for leafCount ${proof.leafCount}`);
    }

    let acc = deltaAnchorLeaf(proof.statementDigest, proof.domain);
    for (const s of proof.siblings) {
      if (!HEX32.test(s.hash)) return fail(`sibling ${s.hash} is not 0x+64 hex`);
      acc = s.position === 'left' ? node(s.hash, acc) : node(acc, s.hash);
    }

    const rebuilt = fieldsToHex(
      poseidon2Sponge([
        ...feltsFromString(DELTA_ANCHOR_ROOT_TAG),
        ...feltsFromString(proof.domain),
        ...feltsFromHex(proof.formulaCommitment),
        BigInt(proof.epoch),
        BigInt(proof.leafCount),
        proof.range ? 1n : 0n,
        ...feltsFromString(proof.range ? proof.range.firstLabel : ''),
        ...feltsFromString(proof.range ? proof.range.lastLabel : ''),
        ...feltsFromHex(acc),
      ]),
    );

    return rebuilt.toLowerCase() === proof.root.toLowerCase()
      ? { included: true, reason: null, unproven }
      : { included: false, reason: 'recomputed root does not match the anchored root', unproven };
  } catch (e) {
    return fail(`malformed proof: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// The attestation payload — built, never sent
// ---------------------------------------------------------------------------

/**
 * Structural mirror of `ProofAttestInput` (`src/services/eas-attestation-service.ts`),
 * declared here rather than imported ON PURPOSE: importing that module pulls in
 * `ethers`, a funded attester key, and `db`. This module must remain impossible to
 * make send, and an unimportable sender is a stronger guarantee than an unused one.
 * A caller that wires the send imports both and passes this straight through; the
 * shape is pinned by a test.
 */
export interface DeltaAnchorAttestation {
  proofId: number;
  agentId: string;
  tier: string;
  merkleRoot: string;
  repidSnapshot: number | null;
  proofType: string;
}

/**
 * Map an anchor onto the ALREADY-REGISTERED `constitutional-compliance-v1` EAS schema.
 * Pure. Sends nothing.
 *
 * `agentId` is a BATCH label, not an agent: an anchor covers many agents by design, and
 * the schema's `agentId` field is the only string slot available. It is prefixed so no
 * reader mistakes it for a real agent id — a batch row whose `agentId` looks like an
 * agent is how a per-agent claim gets made from a per-batch artefact.
 */
export function buildDeltaAnchorAttestation(
  anchor: DeltaAnchor,
  opts: { batchLabel?: string; tier?: string } = {},
): DeltaAnchorAttestation {
  return {
    proofId: anchor.epoch,
    agentId: opts.batchLabel ?? `batch:${REPID_DELTA_ANCHOR_DOMAIN}:${anchor.epoch}`,
    tier: opts.tier ?? 'BATCH',
    merkleRoot: anchor.root,
    repidSnapshot: null,
    proofType: REPID_DELTA_ANCHOR_PROOF_TYPE,
  };
}

export type DeltaAttestFn = (
  input: DeltaAnchorAttestation,
) => Promise<{ uid: string | null; txHash: string | null; error?: string }>;

/**
 * Anchor a batch. The chain write is a REQUIRED argument with NO DEFAULT.
 *
 * That is a deliberate difference from `memory-root-anchor.ts`, whose `attestFn`
 * defaults to the real `attestProof`. A default sender means a forgotten argument is a
 * funded transaction. Here, omitting it is a compile error.
 *
 * Nothing in this repository calls this function today. It exists so the wiring is one
 * obvious, reviewable call rather than something invented under time pressure later.
 */
export async function anchorDeltaBatch(
  anchor: DeltaAnchor,
  attestFn: DeltaAttestFn,
  opts: { batchLabel?: string; tier?: string } = {},
): Promise<{ uid: string | null; txHash: string | null; anchored: boolean; error?: string }> {
  if (!HEX32.test(anchor.root)) {
    return { uid: null, txHash: null, anchored: false, error: `invalid anchor root '${anchor.root}'` };
  }
  const r = await attestFn(buildDeltaAnchorAttestation(anchor, opts));
  return { uid: r.uid, txHash: r.txHash, anchored: !!r.uid, ...(r.error ? { error: r.error } : {}) };
}
