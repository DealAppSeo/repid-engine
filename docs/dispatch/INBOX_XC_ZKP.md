# INBOX_XC_ZKP — STARK/FRI parameter policy, pin reconciliation, and the mutation matrix

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is a specification returned
as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC_ZKP.md \
  --requires reasoning,repo_read
```

---

### Read this before you plan anything

**The statement is already written, in Rust.** A first pass at this sprint was about to
ask you to *"define the ZKP statement"*. That would have been wasted work — it exists,
it is shipped, and it is quoted below. The same mistake in this estate once cost two
sprints optimising a component already at 97.9% of its bound.

Your lane is **not** the statement. It is the three things nobody has done:

1. the **STARK/FRI parameter policy** — what security level may we claim, and does the
   deployed configuration deliver it;
2. the **Invariant-5 pin reconciliation decision** — a genuinely open call, currently
   deferred, with a written rationale you should attack;
3. the **mutation matrix** — four mutations are covered; you are the red-team lane, and
   the uncovered ones are where a soundness break would actually live.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check
it. Do not claim to have read a file outside this repo, and do not invent its contents.

### Statement A1 — fixed, do not redesign

Implemented as `RepIdRangeCheckAir` in the `@hyperdag/proof-verifier` crate
(`DealAppSeo/hyperdag-proof-verifier`, published to npm, Apache-2.0, Rust → WASM).

- **Public values: 18 BabyBear field elements.**
  `[0..16]` = `agent_id` (16 bytes, one byte per element) · `[16]` = `threshold` ·
  `[17]` = `repid_score`.
- **Claim:** `repid > threshold`, established by a **16-bit range check**.
- **Value binding:** the circuit asserts `reconstructed == repid_score - threshold - 1`,
  so the range check is bound to the *declared* public values and cannot be satisfied by
  an unrelated in-range number.
- **Documented assumption:** `repid - threshold < 65536`. True today because RepID clamps
  to `[10, 10000]`, so the difference cannot exceed 9990.

That assumption is a **policy input, not a fact of nature.** It holds only while the
clamp holds. Say what must be true for it to keep holding, and what breaks if the clamp
is ever raised.

### The two pins — the open decision (ZKP Invariant 5)

Invariant 5: *one Plonky3 pin governs ALL Plonky3 circuits.* It is **violated today**,
knowingly, and the violation is documented in `docs/zkp/PLONKY3_PIN_RECONCILIATION.md` —
read that file, it is in this repo.

| Tier | Governs | Pin mechanism | Value |
|---|---|---|---|
| Aggregation / prover | the deployed prover + the published verifier WASM | Plonky3 **git rev** | `27d59f7350` |
| Leaf | `zkp-vault` (Poseidon2-BabyBear KAT crate, in this repo) | **crates.io** `p3-* = "0.3.0"` | `0.3.0` |

The deferral rationale, which you should treat as an argument to be attacked rather than
a settled fact: `27d59f7350` came off an abandoned custom-STARK salvage branch and its
`p3-*` API is not guaranteed compatible with the crates.io `0.3.0` release; `zkp-vault`'s
Poseidon2 vectors are frozen **bit-exact** against `0.3.0` and a repin risks breaking
them; and the leaf is not yet wired into the aggregation tier, so the pins do not have to
agree at runtime *yet*.

`tests/plonky3-pin-single-source.test.ts` machine-checks that the divergence can neither
silently worsen nor silently "resolve". Read it.

### What is already MEASURED, and what is not

Do not propose re-doing any of the first three rows.

| DoD item | State | Evidence |
|---|---|---|
| Real prover produces proofs for a documented statement | **PARTIAL** | prover deployed, statement documented; **nobody has confirmed the deployed prover's output verifies under the published verifier** |
| Verifier accepts valid / rejects invalid | **MEASURED (crate-internal)** | `tests/zkp-proof-verifier-crosscheck.test.ts` runs a genuine Plonky3 proof through the real WASM, over a mutation matrix (see deliverable 4 — read the file for the current list). **Caveat: the proof comes from the crate's own prover, not from the deployed service.** |
| Product path fail-closed without a proof | **MEASURED** | `tests/verify-proof-fail-closed.test.ts` — and it pins a *real fail-open that shipped*: `!!someObject` is always true, so every stored proof reported `cryptographically_verified: true`, including ones the verifier had just rejected |
| GateRun MEASURED; mutants/invalid FAIL | **NOT_CHECKED** | mutants already fail in CI; no GateRun wrapper emits the verdict |

The single blocking measurement is **"does the deployed prover's output verify under the
published verifier"**. `scripts/zkp/live-prover-crosscheck.ts` exists to answer it and
cannot run from an agent sandbox — the egress allowlist denies the prover host. It is a
human-run script today. **Do not report its result. You have not run it.**

### The trust vocabulary — four states, and the distinctions ARE the product

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning, **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED. A gate that goes red
for environmental reasons gets ignored within a week, at which point it is worse than no
gate — so a prover that is unreachable is `NOT_CHECKED`, never `FAILED`.

---

### Deliverables — four specifications

### 1. STARK/FRI parameter policy

The question nobody in this estate has answered: **what security level are we entitled to
claim, and from which parameters does it follow?**

Must cover:
- Which parameters determine soundness for this configuration — field and extension
  degree, FRI blowup/rate, query count, proof-of-work/grinding bits — and how they
  combine into a bit-security figure.
- **Conjectured vs provable soundness stated separately.** Most deployed STARK parameter
  sets quote the conjectured bound. Quoting a conjectured figure as if it were proven is
  exactly the overclaim this track exists to prevent.
- The **claim rule**: what may appear in user-facing text about proof strength, and what
  must be labelled. If the parameters cannot be read from this repo — they are in the
  verifier crate, which you cannot open — say **UNVERIFIED** and name the file and the
  constant a human should read. Do not estimate a bit level from the field size alone.
- The soundness consequence of the **BabyBear** field specifically: a single-query
  soundness error near `1/|F|` is weak, which is why the extension field and query count
  carry the security. State what would have to be misconfigured for that to fail quietly.

### 2. Pin reconciliation policy

Not "should we reconcile" — **under what conditions, and what must be re-frozen when we
do.**

Must cover: the trigger condition that forces reconciliation (leaf-wiring is the stated
one — is it the only one?); which artefacts must be re-frozen deliberately rather than
regenerated; what a runtime pin mismatch means for a verdict, which is the part that
matters most — **a proof produced under one pin and rejected under another is `FAILED` to
a naive reader and is not a soundness failure at all.** Your policy must make that
distinguishable, or the first real divergence will be misread as a broken circuit.

Also: state what evidence would *settle* whether `27d59f7350`'s `p3-*` API is compatible
with crates.io `0.3.0`. The deferral rests on "not guaranteed compatible", which is an
absence of evidence, not evidence of absence.

### 3. GateRun predicates for the prove→verify path

Predicates that turn a crosscheck run into a four-state verdict.

Must cover, at minimum, these distinct outcomes — and they must **not** share a branch:
- prover unreachable / not configured → `NOT_CHECKED`
- prover reachable, returned a proof, proof **verifies** → `MEASURED`
- prover reachable, returned a proof, proof **rejected** → `FAILED`
- prover reachable, returned a proof, and the **mutants also verified** → `FAILED`, and
  this is the worst outcome of the four, because it is a soundness break rather than a
  liveness problem. Say why it must be reported louder than a plain rejection.
- verifier module absent / failed to load → `NOT_CHECKED`, never a silent pass

**The fail-open shape to defend against, by name.** This repo shipped `!!someObject` as a
verification check. It is always true. Every predicate you write must state what its
value is when the thing it depends on is *absent* rather than *false*, because that is
the branch that shipped the bug.

**Provenance is a required predicate input, not a nicety.** A proof from the crate's own
prover and a proof from the deployed service are different measurements. A predicate that
cannot tell them apart will report the crate-internal pass as end-to-end MEASURED — which
would close DoD item 1 on evidence that does not support it. Name the field you need from
GA and state the verdict when it is missing.

### 4. Mutation matrix — extend it (your highest-value deliverable)

**What is covered today.** Read `tests/zkp-proof-verifier-crosscheck.test.ts` yourself —
it is in this repo — and take the list from the file, not from me. As of writing it pins
seven behaviours of the verifier: accepts the honest statement; rejects an **inflated
score**, a **substituted `agent_id`**, a **lowered threshold**, and a **statement claiming
a score at or below its own threshold**; rejects a **tampered proof body** (one flipped
byte mid-proof breaks deserialisation); and pins one documented **limitation** — see
below. The same file also pins the fail-closed boundary: a verifier that **throws** and a
verifier that returns a **garbage non-boolean shape** both resolve to `verified === false`
rather than coercing truthy.

**The pinned limitation, and why it is your problem.** `tier` is **not a bound public
input**. Substituting `tier: 'VETERAN'` into an otherwise honest statement **still
verifies**, and there is a test asserting exactly that so it cannot silently change. The
mitigation is that `zkp-audit-service` derives tier database-side and never trusts the
prover's tier claim.

That is the shape you should generalise: **a valid proof travelling alongside an unbound
claim.** The proof is sound; the *statement as presented to a product surface* carries
more than the proof covers. Enumerate what else can ride along unbound, and state the rule
for it — because "the proof verified" is a true sentence that a reader will over-read
every single time.

**What to enumerate.** For each candidate: what it attacks, what a correct verifier does,
what a vulnerable one does, and whether a named test in this repo covers it. This list is
a starting point, not a bound — the ones I have not listed are the ones worth finding:

- **Replay across subjects** — a valid proof for agent A presented as agent B's, with the
  public values swapped to match. What binds the proof to its public values?
- **Length mutation of the proof body** — truncated and over-long. Distinct from the
  covered case: a *flipped byte* fails content deserialisation, while a *length* change
  exercises the framing/bounds path. Does it reject, or panic? A WASM panic a caller
  catches and reads as "not verified" is fine; one that unwinds into a `catch` returning
  `true` is the fail-open again.
- **Public-values length ≠ 18** — over-long and under-long. Does a short vector read
  garbage or reject?
- **Field-element overflow** — a byte value or score at or above the BabyBear modulus.
  Non-canonical encodings are a classic soundness gap: two byte-strings that reduce to the
  same field element let a prover equivocate on `agent_id`.
- **The 65536 boundary** — a witness with `repid - threshold ≥ 65536`. The documented
  assumption says this cannot occur under the clamp. What does the circuit *actually* do
  if it does — reject, or wrap and accept a false claim? That is the difference between a
  documented precondition and an enforced one, and it is the single most important
  question on this list.
- **Wrong circuit, right shape** — a proof from a different AIR whose public values happen
  to be 18 elements. Is the circuit/AIR identity bound into what is verified?

Mark every candidate `NOT_CHECKED` unless you can cite the test that covers it. Do not
predict the outcome of a mutation you have not seen run — and note that "tier still
verifies" was only knowable because someone *ran* it, not because someone reasoned about
the circuit.

---

### Acceptance criteria

- Every predicate distinguishes all four vocabulary states and names its **fail-closed
  default**.
- Every mutation is marked `NOT_CHECKED` or cites the test that covers it. No predicted
  results.
- Each spec names the specific way it could **fail open**. A spec that cannot describe its
  own failure mode has not been thought through.
- Where you are uncertain, write **UNVERIFIED** and say what evidence would settle it —
  naming the file or the command a human should run.

### What will be rejected

- Any claim you read a file outside this workspace, including the verifier crate.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning statement A1, or proposing a different circuit. A1 is fixed.
- Proposing that a Sprint-3 stub be "fixed" by hardcoding a pass. That converts an honest
  absence into a false measurement, which is worse than the gap.
- Any bit-security number not derived from named parameters. An estimate is an overclaim.
- Any recommendation to remove the UI's *"Not live yet"* label. That is gated on a
  MEASURED GateRun, not on a specification.

### Fixtures — the #376 fence

PR #376 committed a proof lifted from the production proofs table — real agent UUID, real
score — into this **public** repo. It cannot be withdrawn.
`scripts/hooks/prod-fixture-guard.js` blocks that shape permanently.

Every fixture and every witness you propose must be **fabricated**: a NIL-variant UUID no
real agent can hold, and a made-up score. If you propose a test vector, propose it in that
shape.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. No
credentials, project identifiers, row counts, host names or service names in your output.
