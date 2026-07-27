/**
 * POSTCARD leaf dual-write — sha256 commitment stays primary, Poseidon2 leaf rides
 * alongside it (backlog 4.2 / ZKP_ARCHITECTURE_INVARIANTS Invariant 1).
 *
 * ## The gap this closes
 * `proof-drain-service.ts` has carried the dual-write PLUMBING since A5/D-062: it
 * accepts `poseidon2Leaf` + `leafScheme` and writes them into
 * `repid_zkp_proofs.poseidon2_leaf` / `.leaf_scheme` behind
 * `PROOF_DRAIN_RECORD_REAL_FIELDS`. But the only SOURCE of that value is the
 * prover's JSON response (`proof.poseidon2_leaf`), and the deployed zkp-postcard
 * prover has never emitted it: [V 2026-07-26] `poseidon2_leaf` and `leaf_scheme`
 * are non-null on 0 of 78,783 rows. The pipe exists; nothing was ever put in it.
 *
 * Now that the TS Poseidon2 leaf hash is real and parity-gated bit-exact against
 * the independent Rust oracle (4.0-b/4.0-c, `./poseidon2-leaf`), the engine can
 * derive the leaf itself instead of waiting on a prover redeploy. That is what this
 * module does — and only that. It computes; it decides nothing about the primary.
 *
 * ## Invariants this deliberately preserves
 * 1. **The primary never moves.** `zk_commitment` stays the nonce-bound sha256
 *    commitment. The 220 EAS attestations already anchored on Base Sepolia commit
 *    to keccak256 merkle roots over exactly those strings [V Beat 26 — root
 *    recomputed and matched on chain]. Changing the primary would orphan that
 *    audit trail. This is a SECOND column, never a replacement.
 * 2. **The prover wins when it speaks.** If a future leaf-aware prover does emit
 *    `poseidon2_leaf`, that value is used unchanged and tagged as prover-sourced.
 *    The engine only fills a hole; it never overrides upstream.
 * 3. **Leaf is taken over the CANONICAL stored commitment** — the same string that
 *    lands in `zk_commitment` — so the Poseidon2 leaf of a row is exactly the
 *    `poseidon2` scheme's merkle leaf for that row (`merkle-root.ts` `leaf()`).
 *    That equality is what makes the column aggregation-ready rather than merely
 *    present: a future Plonky3 PACKAGE-tier fold over these leaves reproduces the
 *    same digests without re-deriving anything.
 * 4. **Shadow-first, three states, default inert.** `off` is byte-identical to
 *    today's behavior. `shadow` computes and logs but writes NOTHING — it proves
 *    the hash runs clean over live commitments at production volume before any
 *    row changes. `on` writes. One env var, instantly reversible, no DDL (the two
 *    columns already exist and are 100% NULL [V Beat 24]).
 * 5. **Fail-safe.** Any throw inside the hash is caught and logged loudly; the
 *    caller gets `null` and the proof row is written exactly as it would have been.
 *    A cosmetic lineage column must never be able to fail a proof write.
 */
import { poseidon2LeafHash } from './poseidon2-leaf';

/**
 * Lineage tag written to `repid_zkp_proofs.leaf_scheme` for an engine-derived leaf.
 * Deliberately distinct from whatever a leaf-aware prover would send, so a later
 * audit can tell the two provenances apart in SQL without guessing.
 */
export const ENGINE_LEAF_SCHEME = 'poseidon2-babybear-sponge-v1/engine';

export type LeafDualWriteMode = 'off' | 'shadow' | 'on';

export interface LeafDualWriteResult {
  /** Value to persist in `poseidon2_leaf`, or null to leave the column untouched. */
  leaf: string | null;
  /** Value to persist in `leaf_scheme`, or null. */
  scheme: string | null;
  /** The digest that was computed, even in shadow mode where nothing is persisted. */
  computed: string | null;
  /** Where the value came from — for logs and tests. */
  source: 'prover' | 'engine' | 'none';
  /** True when the mode computed a digest but deliberately withheld it from the write. */
  shadowed: boolean;
}

const INERT: LeafDualWriteResult = {
  leaf: null,
  scheme: null,
  computed: null,
  source: 'none',
  shadowed: false,
};

/**
 * Resolve the mode from the environment. Unknown/absent/malformed ⇒ `off`, so a
 * typo can never silently enable a write path (fail-safe, not fail-open).
 */
export function leafDualWriteMode(env: NodeJS.ProcessEnv = process.env): LeafDualWriteMode {
  const raw = (env.POSEIDON2_LEAF_DUAL_WRITE ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === 'enforce') return 'on';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Decide what (if anything) to write into the Poseidon2 leaf columns for one proof.
 *
 * @param commitment      the canonical commitment that will be stored in `zk_commitment`
 * @param proverLeaf      `poseidon2_leaf` from the prover response, if it sent one
 * @param proverScheme    `leaf_scheme` from the prover response, if it sent one
 *
 * Pure apart from the fail-safe `console` call, so it is fully unit-testable.
 */
export function resolveLeafDualWrite(
  commitment: string | null | undefined,
  proverLeaf: string | null | undefined,
  proverScheme: string | null | undefined,
  mode: LeafDualWriteMode = leafDualWriteMode()
): LeafDualWriteResult {
  // Invariant 2: a prover-supplied leaf is authoritative and is passed through in
  // every mode, including `off` — that is exactly today's behavior, unchanged.
  if (typeof proverLeaf === 'string' && proverLeaf.length > 0) {
    return {
      leaf: proverLeaf,
      scheme: typeof proverScheme === 'string' && proverScheme.length > 0 ? proverScheme : null,
      computed: proverLeaf,
      source: 'prover',
      shadowed: false,
    };
  }

  if (mode === 'off') return INERT;
  if (typeof commitment !== 'string' || commitment.length === 0) return INERT;

  let computed: string;
  try {
    computed = poseidon2LeafHash(commitment);
  } catch (e) {
    // Invariant 5: never let a lineage column break a proof write.
    console.error(
      `[LeafDualWrite] Poseidon2 leaf computation FAILED for commitment '${commitment.slice(0, 18)}…' ` +
        `(mode=${mode}; proof row written without the leaf):`,
      e instanceof Error ? e.message : e
    );
    return INERT;
  }

  if (mode === 'shadow') {
    console.log(
      `[LeafDualWrite] shadow: WOULD write poseidon2_leaf=${computed} scheme=${ENGINE_LEAF_SCHEME} ` +
        `for commitment '${commitment.slice(0, 18)}…' (nothing persisted)`
    );
    return { leaf: null, scheme: null, computed, source: 'engine', shadowed: true };
  }

  return { leaf: computed, scheme: ENGINE_LEAF_SCHEME, computed, source: 'engine', shadowed: false };
}
