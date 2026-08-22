# zkRepID — the canonical name

**Decided 2026-08-17 (Sean).** `zkRepID` is the canonical name for the layer that proves a
RepID without revealing it. Recorded in `DECISIONS.md` §9; the boundary is code, in
`src/zkrepid/boundary.ts`, and it is checked by `tests/zkrepid-boundary.test.ts`.

> **This document is machine-checked.** Every module path below is asserted to appear here
> by the test suite, in both directions. If you add or remove a module from the boundary
> and do not update this page, the build goes red. That is deliberate: a definition that
> drifts from the thing it defines is how `HAL_CANONICAL_v1.md` came to describe a module
> with three live consumers as "dead code".

---

## The one sentence

**zkRepID is the RepID-specific half of `src/zkp/` — the modules that exist because a
*RepID* is being proved, anchored, or bound to an identity.** The other half is
general-purpose zero-knowledge machinery that zkRepID uses, and it keeps the name `zkp`,
because `zkp` is what it is.

## Why the directory was not renamed

The obvious reading of "make zkRepID canonical" is `git mv src/zkp src/zkrepid`. Scoping it
showed that would be **wrong on the merits, not merely risky**.

`src/zkp/` holds two different kinds of thing:

- Poseidon2 is a **hash function**. Plonky3 is a **proving backend**. `merkle-root.ts`
  describes itself as *hash-agnostic*. `zkp-vault/` is a **separate Rust crate** with its
  own required CI check. None of these has anything to do with RepID. They would make just
  as much sense in a system that had never heard of it.
- The other six modules exist *only* because a RepID is the thing being proved.

Renaming the first group to `zkRepID` would make the vocabulary **worse** — it would attach
a product name to general cryptographic primitives and leave the codebase less able to say
which is which.

Two further constraints make a wholesale rename impossible rather than just unwise:

1. **The database columns cannot be renamed from this repo.** `zkp_circuit`,
   `zkp_proof_cid`, `zkp_sbt_proof_cid` and `custodian_zkp_proof` live in an
   **externally-managed** Supabase schema — no migrations live here (`CLAUDE.md`).
2. **`zkp-vault` is a Rust crate** owning a required CI job.

So a "full rename" would land **half-applied by construction**, and a name that is
canonical in some places and not others is not a canonical name. The rule this follows is
LESSONS §5: match the real names, not the tidy ones you imagine.

## What IS zkRepID

Test applied to each: *would this module still make sense in a system that had never heard
of RepID?* If yes, it is not zkRepID.

| Module | Role | Kind |
|---|---|---|
| `src/zkp/repid-delta-statement.ts` | the canonical public statement a RepID delta proof commits to | pure |
| `src/zkp/delta-anchor.ts` | batches RepID delta statements into a Merkle root for on-chain anchoring | pure |
| `src/zkp/erc8004-linkage.ts` | joins a RepID proof to an on-chain ERC-8004 identity | pure |
| `src/zkp/holder-identity-binding.ts` | binds a RepID proof to the holder who earned it | pure |
| `src/zkp/nullifier-identity.ts` | per-identity nullifiers, so one RepID cannot be replayed as many | pure |
| `src/zkrepid/disclosure.ts` | the selective-disclosure seam: prove `repid >= threshold` without publishing the score | pure |
| `src/zkp/formula-golden-vector.ts` | pins the scoring formula's observable behaviour per version, so a statement's `formula_version` cannot silently stop describing the formula that produced it | pure |
| `src/zkp/statement-registry.ts` | the family of RepID statements and what each one binds — the answer to "which statement does this proof prove?", which a proof cannot answer about itself because the verifier ignores any field it does not already know | pure |
| `src/zkp/repid-delta-bridge.ts` | the wire from the live scoring path into a RepID delta statement | **I/O edge** |

`disclosure.ts` is the first module to live in `src/zkrepid/` itself rather than be re-exported from
`src/zkp/`. That is deliberate: it is new code with no existing consumers, so there is nothing to
avoid breaking, and a module whose only reason to exist is RepID-specific disclosure belongs at the
name that means RepID-specific. The `src/zkp/` entries above are older files the barrel adopted in
place; they were not moved, and moving them is still not planned. Design and the shape of the
threshold statement: [`ZKREPID-DISCLOSURE.md`](ZKREPID-DISCLOSURE.md).

## What is NOT zkRepID

The interesting half of a definition is what it excludes. Without this list, the next reader
asks "why isn't Poseidon2 in there?" and either adds it or renames the directory.

| Module | Why not |
|---|---|
| `src/zkp/poseidon2-babybear.ts` | a hash function; nothing to do with RepID |
| `src/zkp/poseidon2-hash2.ts` | a hash function; nothing to do with RepID |
| `src/zkp/poseidon2-leaf.ts` | hash primitives; nothing to do with RepID |
| `src/zkp/merkle-root.ts` | self-describes as hash-agnostic; a general Merkle implementation |
| `src/zkp/plonky3-real.ts` | a proving backend, usable for any statement |
| `src/zkp/plonky3-stub.ts` | a proving backend, usable for any statement |
| `src/zkp/commitment.ts` | general POSTCARD commitment construction |
| `src/zkp/leaf-dual-write.ts` | general leaf-encoding migration machinery |
| `src/zkp/proof-router.ts` | routes proofs by type; not RepID-specific |
| `src/zkp/proof-statement-guard.ts` | a general fail-closed statement builder/validator |
| `src/zk-proof/prover.ts` | a generic prover request/response wrapper |

Also outside the boundary, and not renameable from here: the `zkp-vault/` Rust crate, and
the `zkp_*` database columns named above.

## Using it

```ts
import { statement, anchor, erc8004, holder, nullifier } from '../zkrepid';

statement.REPID_DELTA_DOMAIN;   // 'hyperdag/repid/delta/v1'
```

**The barrel is purely additive.** No file moved, no import changed, no behaviour altered.
Every module remains importable by its own path and every existing consumer is untouched.

Two properties the tests enforce:

- **It imports with no environment set.** A consumer wanting a domain constant is never
  forced to hold database credentials.
- **It is namespaced, not flattened.** `feltsFromString` is exported by *both*
  `repid-delta-statement` and `nullifier-identity`, with different domain-separation tags.
  A flat `export *` would silently resolve one of them — and for a domain-separation helper
  that means a digest computed under the wrong intent. `statement.feltsFromString` and
  `nullifier.feltsFromString` cannot be confused.

`repid-delta-bridge` is zkRepID but is **not** in the barrel: it imports `../db`, which
throws at module scope without credentials. Re-exporting it would make the canonical entry
point throw for every consumer, and an entry point harder to import than the modules under
it does not get used. Import it directly and knowingly:

```ts
import { recordDeltaStatement } from '../zkp/repid-delta-bridge';
```

## Adding a module under `src/zkp/`

Classify it in `src/zkrepid/boundary.ts` — either as zkRepID or as explicitly not, with a
reason. The test suite fails until you do, and updating this page is part of the same
change.
