/**
 * merkle-air.ts — P4 Algebraic Intermediate Representation (AIR) for batched
 * Merkle inclusion + non-membership proofs (backlog item 14).
 *
 * An AIR is a set of polynomial constraints over an execution trace (a matrix of
 * field elements). This module encodes both proof types so a Plonky3 prover can
 * produce a single STARK over the combined trace. The TypeScript side handles:
 *   - Trace generation from existing LeanIMT+ witnesses.
 *   - Pure constraint verification (checks that every row satisfies the AIR).
 *
 * The actual STARK proof lives in the Rust zkp-vault; this file is the TypeScript
 * AIR specification and the witness adapter — the "reduction to practice" for patent
 * purposes that proves the constraint system is sound.
 *
 * ## AIR columns (one row = one hash step in the Merkle path)
 *   0  current_in   — the running digest entering this step
 *   1  sibling      — the sibling node at this level
 *   2  sibling_left — direction bit: 1 if sibling is the LEFT input, 0 if right
 *   3  current_out  — hashNode(L, R) where (L, R) is (sibling, current_in) or vice versa
 *
 * ## Constraints
 *   Per-row (transition):
 *     R0: current_out = hashNode(sibling_left ? sibling : current_in,
 *                                sibling_left ? current_in : sibling)
 *     R1: sibling_left ∈ {0, 1}   (binary)
 *   Boundary:
 *     B0: trace[0].current_in = leafDigest
 *     B1: trace[n-1].current_out = claimedRoot
 *   Continuity (transition between rows):
 *     C0: for i < n-1: trace[i].current_out = trace[i+1].current_in
 *
 * ## Non-membership extension
 *   A non-membership AIR batches a full inclusion trace for the low-leaf, then
 *   checks the ordering constraint at the boundary: lowLeaf.value < target < lowLeaf.next
 *   (or lowLeaf.next === 0n means the list's tail, i.e. target > lowLeaf.value).
 *   The ordering constraint is checked on bigint arithmetic, not field arithmetic,
 *   because the LeanIMT+ design stores raw bigint values (not field-element encodings).
 */

import { type Hash2 } from '../memory/proof-carrying-index';
import { hashNode } from '../memory/proof-carrying-index';
import { type InclusionWitness, type NonMembershipWitness, encodeLeaf, type LeanIMTPlus } from '../memory/leanimt-plus';
import { poseidon2LeafHash, poseidon2PairHash } from './poseidon2-leaf';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of the Merkle AIR execution trace. */
export interface MerkleAIRRow {
  current_in: string;
  sibling: string;
  sibling_left: 0 | 1;
  current_out: string;
}

/** Full AIR for a Merkle inclusion proof. */
export interface InclusionAIR {
  type: 'inclusion';
  leaf_digest: string;
  claimed_root: string;
  rows: MerkleAIRRow[];
}

/** Full AIR for a non-membership proof: includes the low-leaf inclusion AIR. */
export interface NonMembershipAIR {
  type: 'non_membership';
  target_value: bigint;
  low_leaf_inclusion: InclusionAIR;
  /** The low-leaf's encoded value and next, checked by the ordering constraint. */
  low_leaf_value: bigint;
  low_leaf_next: bigint;
  low_leaf_tombstoned: boolean;
}

/** Batched AIR over multiple proof items (inclusion + non-membership interleaved). */
export interface BatchedMerkleAIR {
  proofs: (InclusionAIR | NonMembershipAIR)[];
}

/** Result of constraint verification. */
export interface AIRVerifyResult {
  ok: boolean;
  failure?: string;
}

// ---------------------------------------------------------------------------
// Default hash functions (Poseidon2-BabyBear, Plonky3-native field)
// ---------------------------------------------------------------------------

const DEFAULT_LEAF_HASH: (s: string) => string = poseidon2LeafHash;
const DEFAULT_HASH2: Hash2 = poseidon2PairHash;

// ---------------------------------------------------------------------------
// Trace generation
// ---------------------------------------------------------------------------

/**
 * Convert a LeanIMT+ inclusion witness into a Merkle AIR trace.
 * The leaf digest is computed from `witness.leaf` using `leafHash`.
 */
export function generateInclusionTrace(
  witness: InclusionWitness,
  opts: { leafHash?: (s: string) => string; hash2?: Hash2 } = {},
): InclusionAIR {
  const leafHash = opts.leafHash ?? DEFAULT_LEAF_HASH;
  const hash2 = opts.hash2 ?? DEFAULT_HASH2;

  const leaf_digest = leafHash(encodeLeaf(witness.leaf));

  if (witness.path.length === 0) {
    // Single-leaf tree: the leaf IS the root; one degenerate row.
    return {
      type: 'inclusion',
      leaf_digest,
      claimed_root: leaf_digest,
      rows: [
        {
          current_in: leaf_digest,
          sibling: leaf_digest,
          sibling_left: 0,
          current_out: leaf_digest,
        },
      ],
    };
  }

  const rows: MerkleAIRRow[] = [];
  let current = leaf_digest;

  for (const step of witness.path) {
    const sibling_left: 0 | 1 = step.siblingOnLeft ? 1 : 0;
    const [l, r] = step.siblingOnLeft ? [step.sibling, current] : [current, step.sibling];
    const current_out = hashNode(l, r, hash2);
    rows.push({ current_in: current, sibling: step.sibling, sibling_left, current_out });
    current = current_out;
  }

  return { type: 'inclusion', leaf_digest, claimed_root: current, rows };
}

/**
 * Convert a LeanIMT+ non-membership witness into a non-membership AIR.
 * Also generates the inclusion AIR for the low-leaf.
 */
export function generateNonMembershipTrace(
  target: bigint,
  witness: NonMembershipWitness,
  opts: { leafHash?: (s: string) => string; hash2?: Hash2 } = {},
): NonMembershipAIR {
  const low_leaf_inclusion = generateInclusionTrace(witness.lowLeaf, opts);
  const lf = witness.lowLeaf.leaf;
  return {
    type: 'non_membership',
    target_value: target,
    low_leaf_inclusion,
    low_leaf_value: lf.value,
    low_leaf_next: lf.next,
    low_leaf_tombstoned: lf.tombstoned,
  };
}

// ---------------------------------------------------------------------------
// Constraint verification (the AIR)
// ---------------------------------------------------------------------------

/**
 * Verify a single inclusion AIR.
 * Checks all three constraint classes: per-row (R0/R1), boundary (B0/B1), continuity (C0).
 */
export function verifyInclusionAIR(
  air: InclusionAIR,
  opts: { hash2?: Hash2 } = {},
): AIRVerifyResult {
  const hash2 = opts.hash2 ?? DEFAULT_HASH2;
  const { rows, leaf_digest, claimed_root } = air;

  if (rows.length === 0) return { ok: false, failure: 'empty trace' };

  // B0: first row's current_in must equal the leaf digest
  if (rows[0]!.current_in !== leaf_digest) {
    return { ok: false, failure: `B0: trace[0].current_in ${rows[0]!.current_in} ≠ leaf_digest ${leaf_digest}` };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // R1: direction bit must be binary
    if (row.sibling_left !== 0 && row.sibling_left !== 1) {
      return { ok: false, failure: `R1 row ${i}: sibling_left is not binary (${row.sibling_left})` };
    }

    // R0: hash constraint — current_out = hashNode(L, R)
    const [l, r] = row.sibling_left === 1
      ? [row.sibling, row.current_in]
      : [row.current_in, row.sibling];

    // Special case: degenerate single-leaf tree (no path)
    let expected_out: string;
    if (rows.length === 1 && air.leaf_digest === air.claimed_root) {
      expected_out = row.current_in; // degenerate: root = leaf
    } else {
      expected_out = hashNode(l, r, hash2);
    }

    if (row.current_out !== expected_out) {
      return { ok: false, failure: `R0 row ${i}: current_out ${row.current_out} ≠ expected ${expected_out}` };
    }

    // C0: continuity — this row's output = next row's input
    if (i < rows.length - 1) {
      const next_row = rows[i + 1]!;
      if (row.current_out !== next_row.current_in) {
        return {
          ok: false,
          failure: `C0 row ${i}→${i + 1}: current_out ${row.current_out} ≠ next current_in ${next_row.current_in}`,
        };
      }
    }
  }

  // B1: last row's output = claimed root
  const last_out = rows[rows.length - 1]!.current_out;
  if (last_out !== claimed_root) {
    return { ok: false, failure: `B1: trace[-1].current_out ${last_out} ≠ claimed_root ${claimed_root}` };
  }

  return { ok: true };
}

/**
 * Verify a non-membership AIR:
 *   1. Verify the low-leaf's inclusion AIR (all Merkle constraints hold).
 *   1b. Re-commit the prover-supplied ordering fields against the committed leaf_digest to
 *       prevent forged non-membership proofs: without this check a prover can supply a valid
 *       inclusion proof for leaf X but fake (low_leaf_value, low_leaf_next, low_leaf_tombstoned)
 *       to falsely claim non-membership of a value that IS in the tree.
 *   2. Check the ordering constraint: low_leaf_value < target < low_leaf_next
 *      (or low_leaf_next === 0n, meaning the tail — target > low_leaf_value suffices).
 *   3. Reject if the low-leaf is tombstoned (a tombstoned leaf can't serve as a low-leaf).
 */
export function verifyNonMembershipAIR(
  air: NonMembershipAIR,
  opts: { leafHash?: (s: string) => string; hash2?: Hash2 } = {},
): AIRVerifyResult {
  const leafHash = opts.leafHash ?? DEFAULT_LEAF_HASH;

  // Step 1: low-leaf inclusion must be sound
  const inc = verifyInclusionAIR(air.low_leaf_inclusion, opts);
  if (!inc.ok) return { ok: false, failure: `low-leaf inclusion: ${inc.failure}` };

  // Step 1b: bind ordering fields to the committed leaf digest.
  // The inclusion AIR authenticates leaf_digest against the Merkle root, but it does NOT
  // constrain what (value, next, tombstoned) that digest encodes — those come from the
  // prover. Re-derive the digest and require it to match before trusting the fields.
  const expectedDigest = leafHash(
    encodeLeaf({ value: air.low_leaf_value, next: air.low_leaf_next, tombstoned: air.low_leaf_tombstoned }),
  );
  if (expectedDigest !== air.low_leaf_inclusion.leaf_digest) {
    return {
      ok: false,
      failure: `low-leaf fields do not match committed digest: recomputed ${expectedDigest} ≠ ${air.low_leaf_inclusion.leaf_digest}`,
    };
  }

  // Step 2: tombstone check (authenticated by the digest check above)
  if (air.low_leaf_tombstoned) {
    return { ok: false, failure: 'low-leaf is tombstoned — cannot prove non-membership' };
  }

  // Step 3: ordering constraint (authenticated by the digest check above)
  const { target_value, low_leaf_value, low_leaf_next } = air;
  if (target_value <= low_leaf_value) {
    return {
      ok: false,
      failure: `ordering: target ${target_value} ≤ low_leaf.value ${low_leaf_value}`,
    };
  }
  if (low_leaf_next !== 0n && target_value >= low_leaf_next) {
    return {
      ok: false,
      failure: `ordering: target ${target_value} ≥ low_leaf.next ${low_leaf_next}`,
    };
  }

  return { ok: true };
}

/**
 * Verify a batched AIR — each proof is verified independently.
 * Returns ok=true only if every proof in the batch is valid.
 */
export function verifyBatchedMerkleAIR(
  batch: BatchedMerkleAIR,
  opts: { hash2?: Hash2 } = {},
): AIRVerifyResult {
  for (let i = 0; i < batch.proofs.length; i++) {
    const proof = batch.proofs[i]!;
    const result =
      proof.type === 'inclusion'
        ? verifyInclusionAIR(proof, opts)
        : verifyNonMembershipAIR(proof, opts);
    if (!result.ok) {
      return { ok: false, failure: `proof[${i}]: ${result.failure}` };
    }
  }
  return { ok: true };
}
