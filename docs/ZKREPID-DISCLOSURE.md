# zkRepID selective disclosure — prove `repid >= threshold` without publishing the score

Code: [`src/zkrepid/disclosure.ts`](../src/zkrepid/disclosure.ts) ·
tests: [`tests/zkrepid-disclosure.test.ts`](../tests/zkrepid-disclosure.test.ts) ·
boundary: [`ZKREPID.md`](ZKREPID.md)

Status **SHADOW**. This is a statement, not a proof. `ZKREPID_DISCLOSURE_MODE=enforce` currently
**refuses**, by design — see [§5](#5-the-gate-and-why-enforce-throws-today).

---

## 1. The hole this opens against, which is live in production today

`src/zkp/proof-statement-guard.ts` builds the public statement every real proof row carries. Its
canonical four keys are:

```
{ agent_id, tier, repid_score, threshold }
```

The proof asserts `score > threshold`. The statement publishes **`repid_score` in the clear, next
to the threshold it is compared against.**

So the deployed "threshold proof" discloses the exact quantity a threshold proof exists to
withhold. It is a signed disclosure with a proof stapled to it. `tier` compounds it: even with
`repid_score` removed, a published tier narrows the score to one of five bands.

This is not a criticism of that module — it is fail-closed, well-tested, and it fixed a real
corpus-hygiene defect (7,958 agent-less rows). It solves *binding*. It was never asked to solve
*disclosure*, and nobody had written down that it does not.

**The old shape is not changed by this work, deliberately.**
`@hyperdag/proof-verifier@0.2.0` parses exactly those four keys and 22,239 rows are stored in that
shape; changing it would invalidate the published verifier and the corpus in one move. The
threshold statement is a **new statement family with its own domain tag**
(`hyperdag/zkrepid/threshold/v1`), so the two coexist — and so "we have selective disclosure"
cannot be claimed of the old rows.

## 2. The shape: verifier-nominated, holder-consented

Two steps, two parties, and neither can act alone.

| Step | Who | Call | Result |
| :-- | :-- | :-- | :-- |
| 1. nominate | verifier | `nominateThreshold({ threshold, verifierId, purpose, epoch })` | `ThresholdRequest` |
| 2a. consent | holder | `consentToThreshold({ request, witness, consent: true })` | `ThresholdStatement` |
| 2b. decline | holder | `declineThreshold({ request, reason, demandReasonable })` | `ThresholdDecline` |

**Why the verifier picks the bar.** A holder-chosen threshold is not evidence. A holder would name
the highest bar they clear, and a verifier who repeats the question learns the score by binary
search. The verifier asks "are you at or above 5000?"; they never ask "what is your score?".

**Why the holder must consent.** An automatic answer to a verifier's question is a read primitive
on private data. The consent step is the only thing that makes this disclosure rather than
surveillance. `consent !== true` throws `CONSENT_MISSING`; there is no default.

**Why a decline is a value, not an exception.** A decline is a legitimate answer that the incentive
layer in [§6](#6-declining-is-not-free--the-incentive-layer-design-only) has to be able to count.
It also carries **no** score information — not even a below/above hint — because a decline that
leaked the answer would leave the holder with no private option at all.

**No extra binding field for the nomination.** The nominated threshold appears verbatim in the
public surface, so the verifier checks `statement.threshold === whatINominated` themselves. A
`request_digest` field would add a public input for a check the verifier can already do.

## 3. The public surface

```ts
{
  threshold:       number,   // the bar the VERIFIER nominated, verbatim
  formula_version: string,   // cleartext regime label, e.g. 'repid-delta-a8-quality-oriented'
  epoch: { label, start, end, root },
  nullifier:       string,   // 0x + 64 hex, scoped to (threshold, epoch)
  digest:          string,   // Poseidon2 over all of the above + the domain
}
```

The absences are the design, and each is asserted by a test:

| absent | why |
| :-- | :-- |
| `repid_score` | the entire point |
| `tier` | a tier is a score band; publishing it narrows the score to one of five |
| `agent_id` | the nullifier is the only identity handle, and its pre-image is secret |
| `met` | see below |

**`met` is returned to the holder and is NOT on the wire.** The holder can see what they are about
to hand over before they hand it over — including that it says `met: false`, which is usually a
statement they should not send, and if they do send it that is a disclosure decision they made
knowingly. Publishing `met` today would be an unproven assertion dressed as an output. When a
circuit exists, `met` becomes the *proven* predicate and moves onto the public surface.

The strongest available statement of "the score is not on the wire" is a test, not a paragraph:
two holders with the same identity secret, the same epoch and the same nominated bar — one at 4000
and one at 6000 — produce **byte-identical** public surfaces, digest included.

### `formula_version` is cleartext, not the salted commitment

Deliberately, and for a measured reason. On 2026-08-17 a behaviour change shipped without a version
bump; the skew presented as a **forged delta**, because the version existed only inside a salted
hash a verifier cannot open. A verifier needs to know *which regime to check against*.
See [`FORMULA-VERSIONING.md`](FORMULA-VERSIONING.md) and
[`formula-golden-vector.ts`](../src/zkp/formula-golden-vector.ts).

### The epoch is mandatory, and the window is spelled out

Without an epoch, "I am above 5000" is undated: a holder who cleared 5000 last March could replay
the same statement forever, which turns a reputation claim into a bearer certificate that never
expires. The epoch is **required, has no default**, and is bound into the digest.

The surface carries the epoch **window** (`label`, `start`, `end`) alongside `root`, not just the
root. An opaque 32-byte root does not tell a verifier what freshness they accepted — they would have
to ask the issuer what window that root covers, which puts the issuer back in the trust path for the
one property the verifier is trying to check independently. One extra line of disclosure buys a
checkable claim.

`epoch.root` ties to the **existing** machinery in `src/services/zkp-epoch-anchor.ts` (`dayEpoch`,
`computeEpochMerkleRoot`). This module invents no second notion of epoch and does no I/O.

> ⚠ **Scope limit.** Binding the root makes the statement *dated*; it does not yet make it
> *anchored*. Nothing here proves the holder's score is a leaf under that root — that is a
> Merkle-inclusion argument the circuit must carry. Until then a wrong-but-well-formed root is
> undetectable from the statement alone. `verifyThresholdStatement` reports this in `notChecked`.

### Nullifier scope: `threshold:<t>@<epoch label>`

Per (threshold, epoch). One holder answering **two** verifiers about the **same** bar in the **same**
epoch produces the **same** nullifier, so those two answers are linkable across verifiers. Stated
plainly rather than claimed away: a per-verifier scope would break exactly the replay detection the
nullifier exists for. Unlinkability across *different* bars and *different* epochs does hold.

## 4. The two guards, measured rather than asserted

`DisclosureGuards` is returned in shape — the same doctrine as `UnlinkabilityStatement` — so a route
cannot publish a stronger claim than the construction supports.

**`witnessHidden`** — computed by inspecting the *built* surface, not by reviewing the code that
built it. That distinction is the whole value: the deployed 4-key statement was written by someone
who intended a threshold proof and publishes the score anyway. Two checks:

1. the key set must be exactly `THRESHOLD_PUBLIC_KEYS` — this catches an added field regardless of
   its value, and is what would have caught the 4-key shape;
2. every field is compared *by equality* against the score and each identity-secret field element,
   with substring matching used **only** for the 8-hex form of a secret felt inside a hex field.

A substring scan over the serialised surface was the first implementation and it was wrong: `":5"`
matches `"threshold":5000`, and a 4-digit score lands inside a 64-hex nullifier by chance often
enough to fire on correct statements. A guard that cries wolf gets switched off, which is strictly
worse than a narrower guard that does not.

Limits, stated: this finds a witness value appearing **verbatim**, or an unexpected field existing
at all. A value *transformed* before publication — a score divided by ten, a coarse bucket — passes.
It is a tripwire against the mistake that actually happened here, not a proof of zero knowledge.

**`provenWithoutSecret`** — typed as `false`, not `boolean`. There is no Plonky3 circuit for
`hyperdag/zkrepid/threshold/v1`, so a verifier holding this statement is trusting the engine. It is
hard-coded because a flag someone could set to `true` without a circuit is the fake-pass this
codebase keeps relearning (CLAUDE.md RULE-4).

## 5. The gate, and why `enforce` throws today

`ZKREPID_DISCLOSURE_MODE`:

- **`shadow`** (default) — statements are built and can be recorded; they gate **nothing**.
  `enforceable: false`, explicitly, so no caller has to infer it from the mode.
- **`enforce`** — a statement may gate real access. Requires both guards true, so it currently
  **throws `NOT_PROVEN_WITHOUT_SECRET`**.

That refusal is the intended behaviour of the flag, not a gap in it. The alternative is a flag whose
flip silently promotes an unproven claim to an access decision. The refusal also does not depend on
the answer — `enforce` refuses a holder at 10000 against a bar of 10 — because a gate that only
refuses the awkward cases is not a gate.

Anything unrecognised (`''`, `'true'`, `'1'`, `'ENFORCE_LATER'`) resolves to **shadow**. An
unrecognised value must not fail open into enforcement.

When a circuit lands, the test named *"enforce mode THROWS"* changes in the same commit as the
circuit. That visibility is the point of pinning the refusal as behaviour.

## 6. Declining is not free — the incentive layer (DESIGN ONLY)

**Not implemented. Nothing in `disclosure.ts` applies a cost.** The module records a decline as a
value; that is all. This section is the design, to be built after the seam is gated.

### The problem

If declining a threshold proof is free, the disclosure channel is worthless to a verifier: an agent
with something to hide simply always declines, and a verifier learns nothing they could not have
assumed. If declining is *expensive from the first refusal*, privacy is punitive and the
self-sovereign claim is hollow — a right you are fined for exercising is not a right.

### The shape: same spirit as blinds

Free at first, accelerating after. A small number of declines in applicable contexts are absorbed
as ordinary privacy; beyond that, cost rises faster than linearly, so a policy of universal refusal
becomes untenable while an occasional refusal costs nothing.

- **Starting heuristic: ~3 free declines** per rolling window, then accelerating cost.
- Cost applies to **standing or to future access**, not to the score's history — it is a
  forward-looking access price, not a retroactive penalty.
- The window is rolling, so cost decays; a decline is not a permanent mark.

**The 3 is a heuristic, not a measurement.** It has not been simulated. Before it ships it belongs
in the strategy tournament (`src/incentives/strategy-sim.ts`) as a treatment, against at least:
a genuinely private honest agent, an agent hiding a low score, and a verifier who spams
unreasonable demands to farm declines. That last one is the failure mode most likely to be missed —
see below.

### Where it lives, and where it must not

**In reputation / ratchet policy. NOT in the disclosure circuit, and NOT in this module.**

Three reasons, in order of how much they cost to get wrong:

1. **A circuit cannot see history.** Decline counting is stateful and contextual; a circuit proves
   one statement about one moment. Putting policy in the circuit means every policy change is a
   new circuit and a new verifier release.
2. **Policy changes; proofs are permanent.** A statement issued today must still verify in a year
   under the regime it was issued under — the whole point of
   [`FORMULA-VERSIONING.md`](FORMULA-VERSIONING.md). Baking a decline price into the statement
   makes an old proof unverifiable the first time the price changes.
3. **It would leak.** A cost visible in the statement tells an observer how often this holder has
   declined, which is a behavioural profile — reintroducing the disclosure the seam removes,
   through the side door.

### Open questions that must be answered before implementation

- **Who judges `demandReasonable`?** `ThresholdDecline` records the caller's judgement at the point
  it is made, and `disclosure.ts` explicitly does not judge — it has no context to. But a
  self-reported flag is gameable in both directions: a holder marks every demand unreasonable, or a
  verifier's own tooling marks its own demands reasonable. **Unresolved.** A plausible direction is
  that reasonableness attaches to the *verifier's* standing rather than to either party's
  self-report, but that is a design, not a decision.
- **The decline-farming attack.** If a decline costs the holder, a hostile verifier can nominate
  thresholds in bulk to drain a competitor. Any implementation needs a per-verifier rate limit and
  a cost to *asking* — probably symmetric: nominating a threshold that is declined as unreasonable
  should cost the verifier.
- **Purpose is never hashed.** `purpose` is free text carried for the incentive layer's judgement
  and is deliberately not in the digest — it is not a cryptographic commitment and must not be
  presented as one.

## 7. What is checked today, and what is not

`verifyThresholdStatement` returns three outcomes, never two, and always reports `notChecked`
alongside a `VERIFIED` verdict — otherwise `VERIFIED` reads as a proof of the threshold claim.

**Checked** (no witness, no circuit): the digest binds these public inputs; the threshold is an
integer inside the score clamp; the threshold matches the one nominated; the formula version is one
the verifier accepts; the epoch window is well-formed; the epoch contains `now` when supplied
(freshness).

**NOT_CHECKED** — structurally unavailable without a circuit:

- that the holder's score met the threshold — nothing here proves it;
- that the score is a leaf under `epoch_root` — needs Merkle inclusion;
- that the nullifier derives from a registered identity commitment.

## 8. Explicitly out of scope for v1

**No blind hybrid.** A scheme where both parties contribute to the threshold without either learning
the other's pick was considered and is out. It needs a commit-reveal round inside the circuit, and
every extra public input is a field a verifier must be taught to check. The simple statement ships
first.

**The old 4-key statement is not migrated.** Deciding whether the 22,239 stored rows are re-issued
under this family, or simply remain what they are, is a product decision. The blast radius is
**UNMEASURED** — it needs the database.
