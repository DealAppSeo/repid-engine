# Two measurements: the formula-version blast radius, and 568 verdicts no code can produce

**2026-08-17.** All figures `[V SQL 2026-08-17]` against `repid_score_events` (152,161 rows,
2026-04-14 … 2026-08-17). Code: `src/scoring/hal-verdict-reachability.ts`,
`tests/hal-verdict-reachability.test.ts`.

Both items here were **open caveats on work that merged tonight** (PR #434). A caveat is a debt;
these are the payments.

---

## 1. Formula-version blast radius — was UNMEASURED, now measured

`docs/FORMULA-VERSIONING.md` shipped saying *"Blast radius is UNMEASURED … must not be estimated."*
`NORTH-STAR.md` shipped asserting *"pre-fix deltas will fail ZK re-verification"* — a stated
consequence with no evidence behind it. Both are now measured.

**Method.** The three risk bands that map to each stored integer delta were derived by running the
**real** `computeDelta` (a8) locally over the reachable clean domain; SQL then only counted rows per
band. The formula is never restated in SQL.

| | rows | share |
|---|---:|---:|
| `repid_score_events`, all | 152,161 | 100% |
| deltas produced by `computeDelta` (`event_type='HAL_SCORE_EVENT'`, `hal_decision='clean'`) | **10,648** | 7.0% |
| …of those, would **FAIL** a recompute under a8 | **10,627** | 99.80% of the population |
| …would still verify | 21 | — |
| …with `zk_proof_triggered` and a `zk_proof_id` | 1,065 | 10.0% of the population |
| …with an EAS attestation | **0** | — |

**So the claim was right in direction and wrong in scale.** The recompute failure is real at 10,627
rows. **Nothing is anchored on-chain** — zero EAS attestations on this population — so no on-chain
attestation asserts a stale delta. That materially lowers severity.

### The ZK exposure is NOT MEASURABLE from the ledger, and 1,065 must not be quoted as if it were

I drafted this section claiming *"1,065 rows carry a ZK proof, so that is the re-verification
exposure."* **That was wrong, and it is withdrawn.** `repid_score_events.zk_proof_id` is a `uuid`;
`repid_zkp_proofs.id` is a `bigint`, so the two cannot join at all. The only uuid on the proofs
table that could plausibly carry the link is `event_id` — and:

- **0** of the 1,065 uuids match any `repid_zkp_proofs.event_id`;
- `event_id` is **NULL for all 79,062 rows** in that table, so the join can never match for *any*
  event, not just these.

So `zk_proof_id` is a **dangling identifier**: 1,065 events assert a proof exists and there is no
discoverable row it refers to. The honest verdict on ZK exposure is therefore **NOT CHECKED** — not
zero, and certainly not 1,065. A number cannot be derived because the linkage does not exist.

This is independently consistent with `NORTH-STAR.md` #83, which measured that the sole
`IBindingScheme` throws, so the proof cannot be produced in the first place. Two different
measurements arriving at "there is no proof here" is the reason to trust it — but the *count* stays
unmeasurable until something links an event to a proof row.

**Uncertainty is bounded, not hand-waved.** 10 rows sit exactly on a float band edge (0.1375 /
0.3875), so the true failure count is 10,617–10,637 under any boundary convention. The 21 survivors
are entirely explained: risk 0.39375 (14 rows) and 0.395 (7 rows) are the only band where the
pre- and post-fix formulas agree. Two independent numbers matching to the row is the check that the
band derivation is correct.

**The inversion as it actually landed** — not a simulation:

| | |
|---|---|
| clean HAL decisions that **removed** RepID | **407 events** |
| agents affected | **12** |
| RepID removed | **407** (each −1) |
| risk range of those events | **0.000000 – 0.050000** — the best-grounded answers |
| window | **2026-06-02 → 2026-06-03** (two days) |

406 of the 407 were at risk **exactly 0** — a perfectly grounded claim, penalised. 571 rows stored a
negative clean delta; only 407 were applied, the other 164 zeroed by a gate. **Why the applied
penalties stop after 06-03 is MEASURED BUT UNEXPLAINED** — do not assume the gate was the vesting
cliff without checking.

---

## 2. 568 stored verdicts that no producer in this repo can emit

`repid_score_events.hal_decision` feeds `total_clean` on the **public, unauthenticated**
`GET /agents/:id` (`routes/agents-external.ts`), which counts `hal_decision='clean'` with no
producer filter.

| shape | rows | verdict |
|---|---:|---|
| `hal_decision='clean'` with `hal_score >= 0.40` | **556** | **impossible** — `deriveHalDecision` returns `clean` only below 0.40 and nothing overrides a decision *to* `clean` |
| `hal_decision='APPROVE'` | **12** | **impossible** — not a member of the `HALDecision` union at all |
| `hal_decision='clean'` with `hal_score` NULL | 70 | verdict recorded, evidence discarded |
| `hal_decision='flagged'` with `hal_score < 0.40` | 3,063 | **LEGITIMATE — do not "fix" these** (see below) |

The argument for the 556 is falsifiable, not rhetorical: the pair is unreachable through the only
function that derives decisions, under **every** combination of the two inputs the row does not
store (`vetoed`, `comma_severity`). Same unreachable-state test as `formula-golden-vector.ts`.

### The 3,063 rows that nearly made this guard useless

The obvious implementation is "recompute `deriveHalDecision`, compare". Run that against prod and it
flags 3,063 rows. **All 3,063 are correct.** `scoring/pipeline.ts` reads

```ts
const decision = halError ? 'flagged' : deriveHalDecision(...)
```

so a HAL *exception* forces `flagged` at whatever score is on the row — flagging when the detector
failed is the fail-closed direction. A guard that cried wolf 3,063 times would have been switched
off, which is worse than no guard. Reachability is a question about the whole producer set, not
about one function; every override is enumerated in the module and cites the code that performs it.

### Mutation-verified, including the control that makes it mean something

| mutation | result |
|---|---|
| drop the `halError` override | **3 tests red** — the false-positive protection is load-bearing |
| restate the 0.40 threshold as a literal, then move the gate to 0.30 | **1 test red** — drift caught |
| move the gate to 0.30, keep the threshold **derived** | **stays green** |

The third row is the point: it proves the second failure was caused by the restatement, not by the
gate moving. The module follows the gate for free.

---

## 3. Corrections to my own intermediate claims tonight

Recorded because the intermediate versions were wrong and someone reading a transcript would
otherwise inherit them.

- **"6 agents have a fabricated `avg_hal_score`" → the figure is 22 of 45.** I counted from a
  listing truncated at 12 rows instead of aggregating. 22 of 45 agents get an `avg_hal_score`
  computed from zero `HAL_SCORE_EVENT` rows; 14 are partly mixed; only 9 are clean.
- **"`PREDICTION_RESOLVE.hal_score` is contamination" → withdrawn.** That path stores quorum
  `dissonance` and passes it through the real `deriveHalDecision` (`agents-external.ts`). It is a
  HAL-shaped risk score from a *different detector*, which is defensible, not fabricated. The
  finding narrowed to the 556 + 12 provably-impossible rows.
- **"the 0.5 rows are a pipeline default" → wrong mechanism.** `pipeline.ts` does default
  `hal_score = 0.5` on HAL failure, but it pairs that with `flagged`, never `clean`, and it only
  ever writes `HAL_SCORE_EVENT`. The 556 come from a different, unguarded writer.

## 4. Open, owned by nobody yet

- **`avg_hal_score` mixes producers without saying so** on a public endpoint, and rests on zero HAL
  verdicts for 22 of 45 agents. `partitionByReachability` exists to make the fix reportable — the
  response-shape change is a product decision, deliberately **not** taken unilaterally here.
- **Which writer emits the 556 + 12.** Not identified. `runScoreEvent` is excluded (it only writes
  `HAL_SCORE_EVENT` and derives its decision).
- **Why applied clean penalties stop after 2026-06-03.** Measured, unexplained.
- **Re-issuance of the 1,065 proof-bearing rows** — product decision, not a proof-system one.
