<!-- triggers: zkp zk proof plonky3 poseidon poseidon2 groth16 circuit witness statement arity nullifier merkle eas attestation commitment selective-disclosure -->
# ZKP / proof-system lessons

Appended when a brief concerns proofs, circuits, or attestations. LESSONS §11's analogue lives
here: when a proof-system invariant rejects a design, the design is wrong — never loosen it.

## A proof cannot say which statement it proves
The verifier binds only what is in the statement. **A field added to a proof's public inputs that
the verifier does not read binds NOTHING** — it appears in the proof, appears in the ledger, and
is silently unverified. The A1 verifier ignores unknown fields, so `RESERVED_ARITY_A1 = 18` is
permanent, and `resolveStatement()` returns `null` for an unknown statement — it must **never**
default to A1, or a mismatched proof reads as a valid A1. The ledger was once "lying" this way
(#460): a proof recorded under a statement id it did not actually prove.

## Selective disclosure needs a new statement, not a new field
A domain-scoped proof needs a **new statement (A2)** with a distinct arity, or an explicit
domain-separation tag inside the transcript — **not** a field added to A1 (see above: it would be
silently unverified). Five-minute decision now, unrecoverable later.

## The witness must not reach the public surface
`ForbiddenWitnessFields` is enforced by the compiler: the public output type must reject any
witness-bearing field (`repid_score`, `tier`, `agent_id`, `identitySecret`, …). A test that
spawns `tsc` and gets **zero diagnostics** cannot conclude "guard perfect" — zero can also mean
`tsc` never ran (its own §7 self-check), so it fail-safes. Never weaken the type to make it pass.

## One hash, one field, one pin
Poseidon2 over the prover's native field (BabyBear unless the live prover is on
Goldilocks/Mersenne31) for both the leaf (Groth16) and aggregation (Plonky3) tiers, so leaves are
aggregation-ready — the current sha256 POSTCARD path must migrate before merkle+EAS wiring, or
leaves are incompatible. **One Plonky3 pin governs every Plonky3 circuit**; a per-circuit fork of
the pin breaks lockstep silently. Nullifier = `Poseidon2(secret, scope)` with scope a PARAMETER
(agentId, studyId, …) — never hardcode the scope to one vertical.

## PHI never touches Trinity prod
Shared crypto substrate, **isolated data planes**: health/PHI gets its own Supabase project; it
never co-mingles into the Trinity prod project. This is both the regulatory boundary and the
no-conflict guarantee between verticals.
