# INBOX_GA_ZKP — the GateRun event shape for prove → verify outcomes

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is a specification
returned as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA_ZKP.md \
  --requires reasoning,repo_read
```

---

## Read this before you plan anything

**The proof schema already exists and is fixed.** A first pass at this sprint was about
to ask you to *"design proof schemas"*. Statement A1's public values are already
implemented in Rust and shipped in a published npm package; designing a schema for them
would be re-deriving a settled fact. The same mistake in this estate once cost two
sprints optimising a component already at 97.9% of its bound.

Your lane is the **GateRun event** — the record that says *what ran, against what, and
what the verdict was*. That does not exist, and its absence is currently the difference
between a measurement we can trust and one we cannot.

---

## Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check it.
Do not claim to have read a file outside this repo, and do not invent its contents.

### The trust vocabulary — four states

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy, not the real quantity. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning and **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

Two outcomes collapse "we did not look" into "it passed". Every status field you design
must express all four. **A boolean cannot, so do not design one.**

**Exit-code convention** for anything runnable: `0` VERIFIED, `2` NOT_CHECKED, anything
else FAILED.

### Statement A1 — fixed, do not redesign

Implemented as `RepIdRangeCheckAir` in the `@hyperdag/proof-verifier` crate (published to
npm, Apache-2.0, Rust → WASM).

- **Public values: 18 BabyBear field elements.** `[0..16]` = `agent_id` (16 bytes, one per
  element) · `[16]` = `threshold` · `[17]` = `repid_score`.
- **Claim:** `repid > threshold`, via a 16-bit range check, value-bound by
  `reconstructed == repid_score - threshold - 1`.
- **Documented assumption:** `repid - threshold < 65536`, true while RepID clamps to
  `[10, 10000]`.

Your event references this statement; it does not restate or re-encode it.

### The verdict shape that ALREADY EXISTS — extend it, do not reinvent it

`trinity-ecosystem` holds `lib/trustshell/attestation-presence.ts`. **You cannot open
it**, so its relevant shape is stated here. It is real, tested code, and it is the house
pattern your event must compose with:

```
type AttestationPresence = 'MEASURED' | 'NOT_CHECKED' | 'FAILED'

interface AttestationPresenceVerdict {
  presence: AttestationPresence
  tag: string      // fixed per attestation kind, e.g. 'trustshell:soft-landing-range:v1'
                   // — deliberately NOT computed from the verdict, so it is greppable
  detail: string
}
```

Two of its design decisions you must not contradict:

- **An unmeasured half is not a half-true attestation.** Where a verdict depends on two
  inputs, either input being `NOT_CHECKED` makes the whole verdict `NOT_CHECKED`. Only
  once both inputs are resolved does a confirmed negative become `FAILED`.
- **A fact about the TOOLING is not a fact about the SUBJECT.** That module reports
  `witnessHidden = false` — no available prover can hide a witness — as `NOT_CHECKED`,
  **not** `FAILED`, because calling it FAILED would describe every agent as out of range
  when the real situation is that the prover is unavailable. Your event must preserve that
  distinction or it will libel the subject for a tooling gap.

Its `ProofResultLike` carries `witnessHidden`, `proven`, `predicateHolds` — and **no
provenance field**. That gap is the centre of this task; see deliverable 1.

### What is already MEASURED, and what is not

| DoD item | State | Evidence |
|---|---|---|
| Real prover produces proofs for a documented statement | **PARTIAL** | prover deployed, statement documented; **nobody has confirmed the deployed prover's output verifies under the published verifier** |
| Verifier accepts valid / rejects invalid | **MEASURED (crate-internal)** | `tests/zkp-proof-verifier-crosscheck.test.ts` runs a genuine Plonky3 proof through the real WASM and asserts a matrix: accepts honest; rejects inflated score, substituted `agent_id`, lowered threshold, score-at-or-below-threshold, tampered proof body; and pins one documented limitation where the mutation **still verifies** (see deliverable 1). Read the file for the current list. **Caveat: the proof comes from the crate's own prover, not the deployed service.** |
| Product path fail-closed without a proof | **MEASURED** | `tests/verify-proof-fail-closed.test.ts` — it pins a *real fail-open that shipped*: `!!someObject` is always true, so every stored proof reported `cryptographically_verified: true`, including ones the verifier had just rejected |
| GateRun MEASURED; mutants/invalid FAIL | **NOT_CHECKED** | mutants already fail in CI; **no GateRun wrapper emits the verdict — that is your deliverable** |

### Two pins, one invariant

`docs/zkp/PLONKY3_PIN_RECONCILIATION.md` is in this repo — read it. Summary: the
aggregation/prover tier pins Plonky3 by **git rev** and the leaf tier (`zkp-vault`) pins
the `p3-*` crates from **crates.io**. Two pins where the invariant requires one, knowingly
deferred. XC owns the reconciliation *policy*; you own making the pin **observable in the
record**, because a proof produced under one pin and rejected under another is not the
same event as a proof that is simply invalid.

### Existing shapes in THIS repo to align to (read them, don't guess)

- `src/providers/cost-class.ts` — the **three-state** doctrine, and the best example in
  the repo of why `unpriced` must never collapse into `free`. Your provenance field has
  the identical hazard: "we don't know which prover produced this" is not "the service
  produced it".
- `src/services/effective-authority.ts` — how an honest approximation is labelled:
  compute it, stamp it (`rRouteIsLedgerApproximation: true`), never silently upgrade it.
- `src/services/bounty-authorization.ts` — the house authorization pattern, and a worked
  example of a fix that *looks* correct and closes nothing.

---

## Deliverables — three documents, in this order

### 1. `zkp-gaterun.v0` — the prove → verify event (the one that matters)

One record of one crosscheck run. It must make the following **impossible to confuse**,
because today they are indistinguishable and that is why DoD item 2 reads
"MEASURED (crate-internal)" instead of "MEASURED":

**Provenance — required, and it is the point of this schema.**
A proof produced by the verifier crate's own prover and a proof produced by the deployed
prover service are **different measurements of different things**. The crate-internal one
proves the circuit is self-consistent. Only the service one proves the *deployed system*
works. A record that cannot tell them apart will let a crate-internal pass close item 1
on evidence that does not support it.

Design that field so the **unknown case is representable and is not the default**. An
absent provenance must read as "we do not know which prover produced this", never as
"the service produced it" — the `unpriced`/`free` hazard, in a place where the cost of
getting it wrong is a false end-to-end claim.

Must also express:
- **Statement identity** — which statement was proven (A1 today) and its version.
  Reference, not re-encoding.
- **Pin observability** — which Plonky3 pin each side ran at (prover side, verifier side),
  as separate fields. Equality is not something to assume; it is something the record
  should show. See "two pins" above.
- **Verdict** — the four-state vocabulary, composing with `AttestationPresenceVerdict`
  above. Reuse its `tag` convention: fixed per kind, greppable, never computed from the
  verdict.
- **The mutation matrix as first-class data**, not a summary count. Per mutation: its
  label, and its individual outcome. A count of "6/6 rejected" hides *which* six, and the
  matrix is expected to grow — XC is enumerating uncovered mutations in parallel
  (replay-across-subjects, proof-body length mutation, wrong public-values length,
  field-element overflow, the 65536 boundary, wrong-circuit-right-shape). The shape must
  accommodate a matrix that grows without a schema change, and must be able to say
  `NOT_CHECKED` for a mutation nobody has run.

- **A mutation whose expected outcome is "still verifies".** This is not hypothetical and
  it will break a naive schema. `tier` is **not a bound public input** of statement A1:
  substituting `tier: 'VETERAN'` into an otherwise honest statement **still verifies**, and
  `tests/zkp-proof-verifier-crosscheck.test.ts` asserts exactly that so the limitation
  cannot silently change. It is mitigated outside the circuit — `zkp-audit-service` derives
  tier database-side and never trusts the prover's tier claim.

  So a matrix entry needs **both** what happened and what was expected. A shape that
  records only `verified: true|false` reports this row identically to a soundness break.
  The record must distinguish *rejected as designed* · *accepted as designed* ·
  **accepted when it should have been rejected** · *not run*. Only the third is an
  incident, and it is the one the schema exists to make impossible to miss.
- **The distinction between "no proof presented" (`NOT_CHECKED`), "prover unreachable"
  (`NOT_CHECKED`), and "proof rejected" (`FAILED`)** — three different situations, and the
  first two are absences while only the third is a finding. If your shape gives them one
  field, say how a reader tells them apart.
- **Mutants-also-verified as its own outcome.** If a mutated statement verifies, that is a
  **soundness break**, not an ordinary failure, and it must be louder in the record than a
  plain rejection. A schema that flattens it into `FAILED` alongside "the prover was down"
  has thrown away the only signal that matters.

**Hard constraint:** nothing in this schema may be named or documented in a way that
implies the end-to-end path is proven. It is not. `NOT_CHECKED` is the correct and
expected value today for the live-path fields of every real row.

### 2. Event-emission contract

Where this event comes from and what is allowed to write it.

Must express: the trigger (a crosscheck run completing); the guarantee that a run which
**could not start** still produces a record — a missing row and a `NOT_CHECKED` row are
different claims, and the absence of a row must not be readable as "not applicable";
required vs optional fields, with the failure mode of each optional one stated; and
whether a run may be recorded more than once, and how a reader picks the current answer.

**The trap, by name.** This repo shipped `!!someObject` as a verification check. It is
always true. For every field whose value depends on something that might be *absent*
rather than *false*, state what the field holds in the absent case. That is the branch the
bug shipped in.

### 3. Retention and disclosure posture

Short. What of this record is safe to surface publicly, and what is not.

`repid-engine` is a **PUBLIC** repository and this record concerns real agents. Reason
about: whether an `agent_id` belongs in a public record at all, given that A1's whole
purpose is proving a fact about a score **without disclosing the score**; and whether a
threshold plus a verdict leaks the score across repeated runs — a sequence of proofs at
different thresholds narrows the value, which is a disclosure the single-proof analysis
misses. Name it even if you cannot quantify it.

**The #376 fence:** PR #376 committed a proof lifted from the production proofs table —
real agent UUID, real score — into this public repo. It cannot be withdrawn.
`scripts/hooks/prod-fixture-guard.js` blocks that shape permanently. Every example row you
write must use a **fabricated** witness: a NIL-variant UUID no real agent can hold, and a
made-up score.

---

## Acceptance criteria

- Every status field can express all four vocabulary states.
- No field name, comment or example implies the end-to-end path is proven.
- Provenance is required, its unknown state is representable, and unknown is not the
  default.
- The mutation matrix can grow without a schema change and can say `NOT_CHECKED`.
- Each document names its own **open questions** explicitly rather than resolving them by
  assumption. An unresolved question stated plainly is a better deliverable than a
  confident wrong answer.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.

## What will be rejected

- Any claim you read a file outside this workspace, including the verifier crate and
  `attestation-presence.ts`.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning statement A1 or re-encoding its public values. A1 is fixed.
- A two-state (boolean) status anywhere.
- A schema in which a crate-internal proof and a service proof are indistinguishable.
- Proposing that a Sprint-3 stub be "fixed" by hardcoding a pass.

## Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not include
credentials, project identifiers, row counts, host names or service names in your output.
