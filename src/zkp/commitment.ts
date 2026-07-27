/**
 * POSTCARD commitment construction with a per-proof nonce (sprint 2026-05-29, Part B),
 * plus the Poseidon2 family and the shadow-mode selector (backlog 4.0-e).
 *
 * ROOT CAUSE (verified [sql:2026-05-29]): repid_zkp_proofs has 22,780 POSTCARD
 * rows but only 4,124 distinct zk_commitment values (18.1% unique). Each colliding
 * commitment maps to exactly ONE agent — the commitment is deterministic per
 * (agent, score/tier) with NO per-proof nonce, so every re-proof of an agent at a
 * stable score yields the identical commitment (top value repeated 2,775×).
 *
 * FIX (additive [rule:3]): bind a fresh per-proof nonce into the commitment so
 * every proof is unique, regardless of whether the upstream prover varies its
 * inputs.
 *
 * ## 4.0-e — the sha256 -> Poseidon2 migration, shadow-first
 * ZKP_ARCHITECTURE_INVARIANTS Invariant 1 requires commitments to end up as Poseidon2
 * over a Plonky3-native field so they are aggregation-ready. This module now carries
 * BOTH families over ONE shared preimage:
 *   - `postcardCommitmentSha256`    — today's live construction, unchanged.
 *   - `postcardCommitmentPoseidon2` — the same preimage through the Poseidon2-BabyBear
 *     sponge (`poseidon2-leaf.ts`, 4.0-c), which is bit-exact against the independent
 *     Rust oracle. No new hash surface is introduced here.
 * Sharing the preimage is the whole point: a "migration" where the two families hash
 * different bytes is not a migration, it is a second, unrelated statement.
 *
 * ## Why there is NO persist mode (deliberate)
 * `repid_zkp_proofs` has `leaf_scheme` for the Merkle leaf but **no column recording
 * which hash family produced `zk_commitment`**, and both families emit the identical
 * shape (`0x` + 64 hex). Canonicality is NOT a reliable discriminator: a Poseidon2
 * digest always has 8 big-endian u32 limbs < p, but a sha256 digest satisfies that by
 * chance with probability (p/2^32)^8 = 0.2331%. Measured on the live table
 * [sql:2026-07-27]: **131 of 56,622 distinct commitments (135 rows) already look
 * canonical** — predicted 131.98. So an untagged cutover would leave ~131 historical
 * rows permanently misclassifiable, with no way to tell a pre-cutover row from a
 * post-cutover one. Therefore `POSTCARD_COMMITMENT_MODE` supports `sha256` (default)
 * and `shadow` ONLY; anything that looks like a persist instruction resolves to
 * `sha256` and warns once. The cutover lands when a scheme tag exists (a
 * `commitment_scheme` key in the existing `statement` jsonb needs no DDL).
 *
 * ## Inherited preimage ambiguity — do not fix in one family alone
 * The preimage is a `|`-join, so a component containing `|` could in principle be
 * re-split differently. It is NOT exploitable today: all five components are
 * engine-controlled (`agentId` is a DB uuid, `score` a number, `tier` a constrained
 * enum string, `nonce` engine hex, `proverCommitment` prover hex) and none can contain
 * `|`. It is pinned by a test so that adding a free-text component becomes a visible
 * failure. Fixing it means changing BOTH families in the same change — changing only
 * sha256 breaks every historical commitment; changing only Poseidon2 breaks the
 * shared-preimage property above.
 */
import { createHash, randomBytes } from 'crypto';
import { poseidon2LeafHash } from './poseidon2-leaf';

/** Fresh 16-byte per-proof nonce as 0x-hex. */
export function generateNonce(): string {
  return '0x' + randomBytes(16).toString('hex');
}

export interface PostcardCommitmentInput {
  agentId: string;
  score: number;
  tier: string;
  nonce: string;
  /** The upstream prover's commitment, bound in when present (preserves the tie
   *  to the proof while the nonce guarantees uniqueness). */
  proverCommitment?: string | null;
}

/** Scheme tags — the values a future `statement.commitment_scheme` would carry. */
export const SHA256_COMMITMENT_TAG = 'sha256-v1';
export const POSEIDON2_COMMITMENT_TAG = 'poseidon2-babybear-sponge-v1';

/**
 * The canonical preimage BOTH families hash. Frozen: changing it invalidates every
 * historical sha256 commitment. See the ambiguity note in the module header.
 */
export function postcardCommitmentPreimage(input: PostcardCommitmentInput): string {
  return [
    input.agentId,
    String(input.score),
    input.tier,
    input.nonce,
    input.proverCommitment ?? '',
  ].join('|');
}

/**
 * Today's live commitment: sha256 over the canonical preimage, `0x` + 64 hex.
 * Deterministic given inputs (incl. nonce); unique across proofs because the nonce
 * is fresh per proof.
 */
export function postcardCommitmentSha256(input: PostcardCommitmentInput): string {
  return '0x' + createHash('sha256').update(postcardCommitmentPreimage(input)).digest('hex');
}

/**
 * The aggregation-ready commitment: the SAME preimage through the Poseidon2-BabyBear
 * sponge. Output is `0x` + 64 hex whose 8 big-endian u32 limbs are all canonical
 * field elements (< p), which is what makes it foldable by the Plonky3 side.
 */
export function postcardCommitmentPoseidon2(input: PostcardCommitmentInput): string {
  return poseidon2LeafHash(postcardCommitmentPreimage(input));
}

/**
 * Resolved mode. `poseidon2` is intentionally absent — see the module header.
 *  - `sha256` (default): byte-identical to the pre-4.0-e behaviour, no logging.
 *  - `shadow`: persists the sha256 value unchanged, additionally computes and logs
 *    the Poseidon2 value so the migration can be measured before it is committed to.
 */
export type CommitmentMode = 'sha256' | 'shadow';

/** Mode strings that read as "start persisting Poseidon2" — refused, loudly, once. */
const PERSIST_LIKE = new Set(['poseidon2', 'on', 'enforce', 'true', '1', 'enabled']);

let warnedPersistLike = false;

/**
 * Fail-safe resolver: ONLY the exact string `shadow` (case/space-insensitive) turns
 * shadow on. Everything else — unset, empty, a typo, or a persist-like instruction —
 * resolves to `sha256`. A persist-like value additionally warns once, so an operator
 * who tried to cut over is told why nothing changed instead of assuming it worked.
 */
export function resolveCommitmentMode(
  raw: string | undefined | null = process.env.POSTCARD_COMMITMENT_MODE,
  warn: (msg: string) => void = console.warn
): CommitmentMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (PERSIST_LIKE.has(v)) {
    if (!warnedPersistLike) {
      warnedPersistLike = true;
      warn(
        `[postcard-commitment] POSTCARD_COMMITMENT_MODE='${raw}' requests Poseidon2 persistence, ` +
          `which is NOT implemented: repid_zkp_proofs has no commitment-scheme column and ` +
          `canonicality misclassifies 131 existing rows. Falling back to 'sha256'. ` +
          `See src/zkp/commitment.ts header (backlog 4.0-e).`
      );
    }
    return 'sha256';
  }
  return 'sha256';
}

// --- shadow logging (sampled: the drain processes tens of thousands of rows) ---

const SHADOW_LOG_FIRST = 20;
const SHADOW_LOG_EVERY = 500;
let shadowCount = 0;

/** Test hook: reset the sampler + the one-time persist warning. */
export function resetCommitmentShadowState(): void {
  shadowCount = 0;
  warnedPersistLike = false;
}

/**
 * The value that gets PERSISTED. Signature and return value are unchanged from the
 * pre-4.0-e implementation, so no call site changes: in every supported mode this
 * returns the sha256 commitment. `shadow` only adds sampled log lines.
 */
export function buildPostcardCommitment(
  input: PostcardCommitmentInput,
  deps: { mode?: CommitmentMode; log?: (msg: string) => void } = {}
): string {
  const sha = postcardCommitmentSha256(input);
  const mode = deps.mode ?? resolveCommitmentMode();
  if (mode !== 'shadow') return sha;

  shadowCount++;
  const sampled = shadowCount <= SHADOW_LOG_FIRST || shadowCount % SHADOW_LOG_EVERY === 0;
  if (sampled) {
    const log = deps.log ?? console.log;
    let p2: string;
    try {
      p2 = postcardCommitmentPoseidon2(input);
    } catch (e: unknown) {
      // A shadow computation must never be able to fail a real proof write.
      log(
        `[postcard-commitment] shadow n=${shadowCount} poseidon2 FAILED: ` +
          `${e instanceof Error ? e.message : String(e)} (persisted sha256 unaffected)`
      );
      return sha;
    }
    log(
      `[postcard-commitment] shadow n=${shadowCount} agent=${input.agentId} ` +
        `persisted=${SHA256_COMMITMENT_TAG}:${sha} candidate=${POSEIDON2_COMMITMENT_TAG}:${p2}`
    );
  }
  return sha;
}
