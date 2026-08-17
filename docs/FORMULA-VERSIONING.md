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

## 4. Make the bump machine-enforced, not remembered — **LANDED 2026-08-17**

The defect was not that someone forgot; it is that forgetting was possible and silent.

**Pin a golden vector.** A small fixed set of `(hal_score, hal_decision, agent state) → delta`
pairs, hashed, asserted equal to a constant stored *next to* the version string. Change the
delta function's observable behaviour without bumping the version and the test goes **red**.

This is the piece that converts "bumped by hand" into a checked invariant, and it is the part
worth building first — without it, §2 and §3 just move the same silence somewhere newer.

Built as `src/zkp/formula-golden-vector.ts` + `tests/formula-golden-vector.test.ts`. Two details
that are load-bearing and were not obvious when this section was written:

- **The digest is keyed BY VERSION, not pinned as one constant.** A single constant would let
  someone bump the version and repin the digest in the same motion — the exact silent drift this
  section is about. Keyed by version, *both* directions go red: change behaviour without bumping
  and today's digest stops matching this version's entry; bump without adding an entry and there
  is no entry to match. `BEHAVIOUR_DIGESTS` therefore doubles as the seed of §3's registry.
- **The vector contains only REACHABLE cases.** `deriveHalDecision` never emits `clean` at or
  above risk 0.40, and the orientation defect survived its own unit tests precisely because those
  tests asserted on `clean` at risk 0.75 — a combination production cannot produce. An unreachable
  row pins behaviour that does not exist and reads as coverage, which is worse than no pin.

Mutation-verified in both directions: perturbing the delta arithmetic without a version bump fails
`observable behaviour matches the digest pinned for this version`; bumping the version without an
entry fails two assertions. `repid-delta-a7` is listed in `UNRECOMPUTABLE_VERSIONS` and deliberately
has **no** digest entry — its delta function is not in the tree, so a digest under that key could
only hold a8's behaviour. That absence is §3's NOT_CHECKED row, expressed as data.

One coupling worth knowing before flipping a flag: `REPID_DELTA_FLOOR_RECONCILED` changes
floor-protection behaviour, and the vector's floor rows straddle it, so flipping it changes the
digest. That is correct — it *is* a behaviour change — and it means the flag needs its own version
when Sean flips it. The test asserts the flag is off rather than assuming it, so the failure names
the precondition instead of looking like unexplained drift.

## What this does not resolve

**Blast radius — MEASURED 2026-08-17**, superseding the "UNMEASURED, must not be estimated" note
that shipped here. Full method and caveats:
[`reports/2026-08-17/LEDGER-VERDICT-REACHABILITY.md`](../reports/2026-08-17/LEDGER-VERDICT-REACHABILITY.md).

- **10,648** stored deltas came from `computeDelta` (`event_type='HAL_SCORE_EVENT'` +
  `hal_decision='clean'`) — **7.0%** of the ledger, not "every delta".
- **10,627 of those (99.80%)** fail a recompute under a8. Bounded 10,617–10,637: 10 rows sit on a
  float band edge. The 21 survivors are the one band where both formulas agree (risk 0.39375 and
  0.395), which is a check on the derivation, not a coincidence.
- **ZK re-verification exposure: NOT CHECKED — and it cannot be counted today.** 1,065 of those
  rows set `zk_proof_triggered` and carry a `zk_proof_id`, but that column is a **dangling
  identifier**: it is a `uuid` while `repid_zkp_proofs.id` is a `bigint`, and the only uuid that
  could carry the link (`event_id`) is NULL for all 79,062 proof rows. So none of the 1,065 resolve
  to a proof. **Do not quote 1,065 as "proof-bearing rows"** — an earlier draft of this section did,
  and it was wrong. Consistent with the independent finding that the sole `IBindingScheme` throws,
  so no proof can be produced at all.
- **0** carry an EAS attestation. Nothing on-chain asserts a stale delta, which is what keeps this
  a correctable ledger problem rather than an irreversible one.

Method note worth copying: the risk→delta bands were derived by running the **real** `computeDelta`
locally, and SQL only counted rows per band. Restating the formula in SQL would have measured the
restatement.

**Re-issuance is not designed here.** Whether affected statements are re-issued, or simply
verify with a NOT_CHECKED recompute forever, is a product decision, not a proof-system one.
