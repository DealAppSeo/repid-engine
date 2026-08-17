# Formula versioning — so an old proof verifies under the formula it was issued under

**Status: SPEC + the first corrective bump applied. The mechanism in §3 is NOT built.**
Owner: the selective-disclosure lane. Decided 2026-08-17.

---

## The failure this exists to close, measured not hypothesised

`FormulaParams` already carries a `version`, and it is hashed into `formulaCommitment()`.
So the earlier claim that the statement "carries a commitment but no version" was **wrong**,
and the real hole is narrower and worse.

On 2026-08-17 the clean branch's orientation was corrected — it consumed hallucination *risk*
where it needed *quality* — which changed **every delta the formula produces**. The band, floor
and ceiling did not change. `version` was not bumped. Therefore:

**`formula_commitment` stayed byte-identical while the formula's behaviour changed.**

The consequence is the most misleading failure available:

| | |
| :-- | :-- |
| An old proof's `formula_commitment` | still **matches** |
| The recompute check against its stored delta | now **disagrees** |
| So a version skew presents as | **a forged delta** |

`src/zkp/repid-delta-statement.ts` recomputes the delta from the witness and rejects a
mismatch. That is the right design. But it recomputes with *today's* formula, so every delta
issued under the old orientation now fails a check whose error message blames the delta.

Three facts make this a **wired-at-one-end** defect rather than a missing feature:

1. `version` exists, and **nothing bumps it** — the comment said "bumped by hand".
2. **Nothing reads it.** Its only use is being hashed; grep confirms no dispatch.
3. It is **not on the wire.** A verifier can only compare `formula_commitment` against one it
   already expects, so it can never *discover* which version a proof was issued under.

The pinned statement-digest test did not catch the bump either: its fixture supplies
`formula_commitment` as a literal rather than computing it. A test that hardcodes the output of
the thing it is guarding cannot guard it.

## 1. Applied now — the corrective bump

`CURRENT_FORMULA_PARAMS.version` → `repid-delta-a8-quality-oriented`, with the reason inline.
This makes new proofs commit differently from old ones, which is the minimum honest state. It
does **not** by itself let an old proof verify — that needs §2 and §3.

## 2. Put the version on the wire

Add `formula_version` as a **public, cleartext field** on the statement, and include it in
`statement_digest`.

Cleartext is safe and is the point: the version is an opaque label, and the *parameters* stay
hidden inside the salted commitment. Publishing `repid-delta-a8-quality-oriented` reveals
nothing about the scoring formula, while making the proof **self-describing** — a verifier reads
which regime to check against instead of having to be told.

Verification then dispatches on the declared version:

- `formula_commitment` must equal `formulaCommitment(registry[declared].params)`.
  A mismatch is **FAILED** — that is a real forgery or a corrupted statement.
- The recompute is checked against **that version's** delta function, not today's.

## 3. The registry, and the NOT_CHECKED that keeps it honest

A registry maps version → `{ params, recompute? }`.

`recompute` is **optional on purpose.** Retaining every historical delta function as live code
is a real commitment, and pretending otherwise is how a registry becomes a fiction. So:

| declared version | commitment | recompute | verdict |
| :-- | :-- | :-- | :-- |
| current | checked | checked | VERIFIED / FAILED |
| historical, function retained | checked | checked under that version | VERIFIED / FAILED |
| historical, function not retained | checked | **NOT_CHECKED**, with the reason | VERIFIED-on-what-was-checkable |
| unknown version | — | — | **FAILED** — refuse, never assume current |

An old proof therefore verifies **against the version it was issued under**, and where a check
genuinely cannot be performed it says so rather than returning a false FAILED. Three outcomes,
never two — the same rule the rest of this codebase runs on.

## 4. Make the bump machine-enforced, not remembered

The defect was not that someone forgot; it is that forgetting was possible and silent.

**Pin a golden vector.** A small fixed set of `(hal_score, hal_decision, agent state) → delta`
pairs, hashed, asserted equal to a constant stored *next to* the version string. Change the
delta function's observable behaviour without bumping the version and the test goes **red**.

This is the piece that converts "bumped by hand" into a checked invariant, and it is the part
worth building first — without it, §2 and §3 just move the same silence somewhere newer.

## What this does not resolve

**Blast radius is UNMEASURED.** How many stored deltas were issued under the pre-bump formula
needs a count of clean-decision score events, which needs the database. Until that number
exists, "how many old proofs are affected" has no answer and must not be estimated.

**Re-issuance is not designed here.** Whether affected statements are re-issued, or simply
verify with a NOT_CHECKED recompute forever, is a product decision, not a proof-system one.
