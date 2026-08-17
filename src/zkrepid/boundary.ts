/**
 * boundary.ts — what "zkRepID" names, and what it deliberately does not.
 *
 * DECIDED 2026-08-17 (Sean): **zkRepID is the canonical name** for the layer that proves a RepID
 * without revealing it. See docs/ZKREPID.md for the prose and DECISIONS.md §9 for the decision.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY A BOUNDARY OBJECT AND NOT A DIRECTORY RENAME
 * ════════════════════════════════════════════════════════════════════════════════
 * The obvious reading of "make zkRepID canonical" is `git mv src/zkp src/zkrepid`. Scoping it
 * showed that would be wrong on the merits, not merely risky:
 *
 *   `src/zkp/` holds TWO different kinds of thing. Poseidon2 is a hash function. Plonky3 is a
 *   proving backend. `merkle-root.ts` describes itself as hash-AGNOSTIC. `zkp-vault/` is a
 *   separate Rust crate with its own CI job. **None of those is about RepID** — they are
 *   general-purpose zero-knowledge machinery that zkRepID happens to use, and `zkp` is the
 *   correct, standard name for them. Renaming them to zkRepID would make the vocabulary WORSE.
 *
 * Two further constraints make a wholesale rename impossible rather than just unwise: the
 * database columns (`zkp_circuit`, `zkp_proof_cid`, `zkp_sbt_proof_cid`, `custodian_zkp_proof`)
 * live in an externally-managed schema this repo explicitly does not own — no migrations live
 * here — and the `zkp-vault` crate owns a required CI check. A "full rename" would therefore land
 * half-applied by construction, which is the worst of the three outcomes: a canonical name that
 * is canonical in some places and not others is not a canonical name.
 *
 * So the name is made real the way a name should be: by saying precisely what it covers, backing
 * that with code you can import, and pinning it with a test. LESSONS §5 — match the real names,
 * not the tidy ones you imagine.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE PURE/IMPURE SPLIT IS LOAD-BEARING
 * ════════════════════════════════════════════════════════════════════════════════
 * Five of the six modules import with NO environment set. `repid-delta-bridge` does not: it
 * imports `../db`, and `src/config.ts` throws at module scope without Supabase credentials.
 *
 * That is why `./index.ts` re-exports only the pure surface. A canonical entry point that was
 * harder to import than the modules beneath it would not get used, and the name would go back to
 * naming nothing. The bridge is still zkRepID — it is listed below as the I/O edge — it is just
 * not something a barrel should drag into every consumer.
 *
 * PURITY: pure data. No imports, no I/O. This module describes the boundary; ./index.ts is the
 * boundary.
 */

/** A module that is part of zkRepID. */
export interface ZkRepIdModule {
  /** Path relative to `src/`, without extension. */
  readonly path: string;
  /** What it contributes to proving a RepID. */
  readonly role: string;
  /**
   * `pure` — imports with no environment set, and is re-exported by ./index.ts.
   * `io-edge` — reaches the database or the network, and is NOT re-exported by the barrel.
   */
  readonly kind: 'pure' | 'io-edge';
}

/**
 * The zkRepID surface.
 *
 * Every entry here is about a REPID being proved, anchored, or bound to an identity. If a module
 * would still make sense in a system that had never heard of RepID, it does not belong on this
 * list — that is the test applied to each one.
 */
export const ZKREPID_MODULES: readonly ZkRepIdModule[] = [
  {
    path: 'zkp/repid-delta-statement',
    role: 'the canonical public statement a RepID delta proof commits to',
    kind: 'pure',
  },
  {
    path: 'zkp/delta-anchor',
    role: 'batches RepID delta statements into a Merkle root for on-chain anchoring',
    kind: 'pure',
  },
  {
    path: 'zkp/erc8004-linkage',
    role: 'joins a RepID proof to an on-chain ERC-8004 identity',
    kind: 'pure',
  },
  {
    path: 'zkp/holder-identity-binding',
    role: 'binds a RepID proof to the holder who earned it',
    kind: 'pure',
  },
  {
    path: 'zkp/nullifier-identity',
    role: 'per-identity nullifiers, so one RepID cannot be replayed as many',
    kind: 'pure',
  },
  {
    path: 'zkrepid/disclosure',
    role: 'the selective-disclosure seam: prove repid >= threshold without publishing the score',
    kind: 'pure',
  },
  {
    path: 'zkp/formula-golden-vector',
    role: "pins the scoring formula's observable behaviour per version, so a RepID statement's " +
      'formula_version cannot silently stop describing the formula that produced it',
    kind: 'pure',
  },
  {
    path: 'zkp/repid-delta-bridge',
    role: 'the wire from the live scoring path into a RepID delta statement',
    kind: 'io-edge',
  },
];

/**
 * Explicitly NOT zkRepID, with the reason.
 *
 * This list exists because the interesting half of a definition is what it excludes. Without it,
 * the next reader asks "why isn't Poseidon2 in there?" and either adds it or renames the
 * directory — which is exactly the outcome this boundary was chosen to prevent.
 */
export const NOT_ZKREPID: readonly { readonly path: string; readonly why: string }[] = [
  { path: 'zkp/poseidon2-babybear', why: 'a hash function; nothing to do with RepID' },
  { path: 'zkp/poseidon2-hash2', why: 'a hash function; nothing to do with RepID' },
  { path: 'zkp/poseidon2-leaf', why: 'hash primitives; nothing to do with RepID' },
  { path: 'zkp/merkle-root', why: 'self-describes as hash-AGNOSTIC; a general Merkle implementation' },
  { path: 'zkp/plonky3-real', why: 'a proving backend, usable for any statement' },
  { path: 'zkp/plonky3-stub', why: 'a proving backend, usable for any statement' },
  { path: 'zkp/commitment', why: 'general POSTCARD commitment construction' },
  { path: 'zkp/leaf-dual-write', why: 'general leaf-encoding migration machinery' },
  { path: 'zkp/proof-router', why: 'routes proofs by type; not RepID-specific' },
  { path: 'zkp/proof-statement-guard', why: 'a general fail-closed statement builder/validator' },
  { path: 'zk-proof/prover', why: 'a generic prover request/response wrapper' },
];

/** The modules the barrel re-exports: the pure surface, in declaration order. */
export const ZKREPID_PURE_MODULES: readonly ZkRepIdModule[] = ZKREPID_MODULES.filter(
  (m) => m.kind === 'pure',
);

/** The modules that are zkRepID but reach I/O, so a consumer imports them directly and knowingly. */
export const ZKREPID_IO_EDGE_MODULES: readonly ZkRepIdModule[] = ZKREPID_MODULES.filter(
  (m) => m.kind === 'io-edge',
);
