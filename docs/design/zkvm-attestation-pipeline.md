# zkVM attestation pipeline (design-only)

**Status: design, not implementation.** No zkVM guest, no TEE quote generation, no new
circuit exists anywhere in this ecosystem after this doc. This is the shape a real
build would take, so the next agent that picks it up isn't re-deriving the public-input
contract from scratch — it already exists, in trinity-ecosystem's Suite ZB. Nothing here
touches `src/zkp/plonky3-stub.ts` / `plonky3-real.ts`, which stay exactly what
`CLAUDE.md`'s hard stops say they are: Sprint-3 contract surfaces, not to be "fixed" by
hardcoding behavior.

## Why this doc exists now

Sean's overnight brief asked for this pipeline design alongside ERC-7579. Two things
already real enough to build on, found by checking rather than assuming:

- **trinity-ecosystem's `docs/policy/zk-attestation-predicates.md` Suite ZB (ZB1-ZB6)**,
  landed in PR #117, already specifies the exact public-input vector this pipeline must
  produce. This doc does not invent a second one — it adopts ZB's `PI` verbatim and shows
  where each element comes from and where it's consumed.
- **`lib/trustshell/attestation-presence.ts`** (trinity-ecosystem) already implements the
  MEASURED/NOT_CHECKED/FAILED verdict logic for both attestation kinds — real inputs in,
  honest three-outcome verdict out, zero imports, structurally mirrored types. A real
  guest's output plugs into these existing functions; they don't need to be rebuilt.
- **`hyperdag-protocol/packages/circuits/reputation_proof.circom`** (+ compiled
  `.vkey.json`) is a real, already-compiled circuit — not this pipeline's circuit (it
  proves a RepID range claim client-side, see `@hyperdag/proof-verifier`), but proof
  that this repo family has already taken a circuit from source to compiled artifact
  once. Worth reading before choosing a proving stack for ZB.

## The pipeline

```
 ┌──────────────┐   ┌───────────────────┐   ┌──────────────┐   ┌─────────────────────┐
 │ TEE / enclave│──▶│ zkVM guest         │──▶│ SNARK proof  │──▶│ GateRun /            │
 │ produces a   │   │ (RISC Zero / SP1-  │   │ (Groth16 or  │   │ validation-attestation
 │ quote (or a  │   │  class): runs DCAP │   │  equivalent) │   │ .v0 ZK_PROOF payload │
 │ Nitro doc)   │   │ verification       │   │ over PI below│   │ — verify SNARK only  │
 └──────────────┘   │ OFF-CHAIN, emits PI│   └──────────────┘   └──────────────────────┘
                     └───────────────────┘
```

The one sentence version: **don't verify the TEE quote itself on every call — verify a
cheap proof that someone else already checked it correctly**, once, inside the guest.
That's the whole reason to route through a zkVM here rather than doing DCAP verification
directly on the hot path.

### The public-input vector — adopted from Suite ZB, not re-derived

```
PI = ( used_S_real, builder_ok, decision, C(S_real), axis_id, [lo,hi],
       scheme_id, soft_landing_active, program_id )
```

Witness (guest sees it, `PI` never does): exact `S_real`, exact `R_route`, exact axis
`x`, any signing key. That witness/PI split is the entire point — Z1-Z5's axis-range
claim and ZR1-ZR5's `A_eff` inequality both need to be provable **without** the exact
number leaking into `PI`, which is exactly what a zkVM guest is for: it computes on the
witness, but only commits `PI` publicly.

`program_id` binds the vector to one pinned guest image — ZB5's whole job is making sure
a verifier can't be tricked into accepting a proof from a different (weaker) program.

### Where GA's schema and XC's predicates meet

`docs/contracts/validation-attestation.v0.md`'s `ZK_PROOF` `proof_payload` —
`{circuit_identifier, proof_bytes_hex, public_inputs}` — is the wire shape this pipeline
targets for High-Stakes (`value_at_risk_usd > $10,000`) lanes:

| `validation-attestation.v0` field | Sourced from |
|---|---|
| `circuit_identifier` | `program_id` (ZB5) |
| `proof_bytes_hex` | the SNARK itself |
| `public_inputs[]` | the `PI` vector above, in ZB's fixed order |
| `metadata.real_collateral_bit` | `used_S_real` (ZB2) |
| `metadata.contracted_eval_bit` | independence check feeding `describeCollateralEvalAttestationPresence` |
| `metadata.soft_landing_active` | `soft_landing_active` (ZB4) |

Medium-Stakes (`$500-$10,000`) lanes want `TEE_ATTESTATION` instead —
`{enclave_measurement_hex, quote_bytes_hex, tee_provider}` — which is just the **left
half** of this pipeline (the raw quote) without the zkVM step. That's a legitimate,
cheaper posture for a lower value-at-risk band; it is not this pipeline's job to make
every tier pay the zkVM cost.

### What GateRun does with a real proof

Nothing new to build here — the consumer side already exists:

```
guest output → describeCollateralEvalAttestationPresence(collateral, evaluation)
             → describeSoftLandingRangeAttestationPresence(proof)
```

`describeSoftLandingRangeAttestationPresence`'s existing logic already refuses to report
MEASURED when `witnessHidden=false` — which is every provider available today
(`WebCryptoProofProvider` is commitment-only; the hiding provider is blocked on
trinity-ecosystem task #75). **A real zkVM guest is exactly what would flip
`witnessHidden` to `true` for the first time.** Until one exists, ZB1/ZB4 (and by
extension the axis-range attestation) stay `NOT_CHECKED` — not a gap in this design, a
fact about the world it describes.

## What's real, greenfield, or blocked today

| Piece | State |
|---|---|
| Public-input vector (`PI`) | **Real spec** — Suite ZB, PR #117 |
| GateRun verdict functions | **Real code** — `attestation-presence.ts`, tested |
| `validation-attestation.v0` wire schema | **Real spec** — GA's contract |
| A compiled circuit anywhere in this family | **Real** — `reputation_proof.circom`, different claim, same toolchain proof-of-concept |
| TEE quote generation (SGX/SEV/Nitro) | **Greenfield** — zero code across repid-engine, trinity-ecosystem, hyperdag-protocol, trinity-symphony-shared, trustshell (confirmed by search, not assumed) |
| DCAP verification running inside a zkVM guest | **Greenfield** |
| A guest that actually binds `PI` and emits a SNARK over it | **Greenfield** — this is what flips ZB1-ZB6 from NOT_CHECKED |
| `witnessHidden=true` on any production path | **Blocked** — no `IBindingScheme` implementation exists that doesn't throw |
| Sprint-3 ZKP stubs (`plonky3-stub.ts`, `plonky3-real.ts`) | **Untouched, hard stop** — this doc does not propose changing them |

## What this doc does not authorize

- Standing up a zkVM guest or any TEE integration tonight — design only, per Sean's
  explicit "no mandatory full zkVM implement tonight."
- Changing `plonky3-stub.ts` / `plonky3-real.ts` or any circuit public input, cross-lane
  or otherwise.
- Claiming `provenWithoutSecret=true` anywhere — still permanently false until a real
  hiding provider exists.
- Treating this pipeline as live, on-chain, or an ERC-8004 Validation Registry
  submission — no confirmed live deployment target exists (`validation-attestation.v0`
  §1, trinity-ecosystem's `attestation-presence.ts` header).
- A second, competing public-input schema. `PI` above is Suite ZB's, verbatim.
