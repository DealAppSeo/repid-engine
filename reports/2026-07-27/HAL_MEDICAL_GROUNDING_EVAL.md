# HAL Medical-Flavored Grounding / Abstention Eval

**Date:** 2026-07-27 · **Author:** CC (Claude Opus 4.8) · **Branch:** `feat/cc-2026-07-27-medical-hal-grounding-eval`
**Type:** measurement (mechanism eval on curated, real-sourced fixtures) · **Guardrails:** additive only; no flags flipped; `HAL_GROUNDING_MODE` stays default `shadow`; no prod/DB touched.

> **Illustrative test fixtures — historical/bibliographic; NOT medical advice.** Every case is a factual
> statement about the *published regulatory/guideline record* ("guidance X was issued around date Y and
> later superseded by Z"), sourced to a real public URL. No patient data, no PHI, no medical advice.

---

## Objective

Measure, with real numbers from real code runs, whether the merged proof-carrying-retrieval primitive
(`src/memory/proof-carrying-memory.ts` + `src/hal/hal-grounding.ts`) actually delivers the property the
patent claims in a medically-flavored setting: **an agent that cited a piece of guidance ABSTAINS once that
guidance is provably superseded, while a naive agent keeps re-asserting the retracted guidance
(hallucination).** And it must NOT abstain when the guidance is still current (no false abstentions).

This is item #1 of the TrustMedical HAL/RepID hardening line — the medical vertical's version of the
`proof-carrying-e2e` convergence run.

## Method

Files (all additive):
- `tests/hal/medical-grounding/cases.ts` — 10 sourced fixtures: 7 "should-abstain" positives (4 superseded
  clinical-guidance reversals + 3 newly-found drug interaction/contraindication withdrawals) and 3
  still-valid controls. Each carries real public source URLs (searched/fetched 2026-07-27).
- `scripts/hal/medical-grounding-eval.ts` — the runnable measurement. Extends the style of
  `scripts/demo/proof-carrying-e2e.ts` (RULE-10). Exports `runCase` / `evaluate`.
- `tests/hal/medical-grounding/medical-grounding.test.ts` — jest assertion of the mechanism per case
  (runs under `npm test`; `tests/` is a jest root).

The mechanism, per case (pure crypto — real Poseidon2, the default injected hashes; no network, no DB, no mocking):

1. **Commit** the guidance as a `MemoryEntry` into a fresh `ProofCarryingMemory` → value `v`.
2. **Ground + bind:** the proof-carrying agent calls `emitGroundedAnswer(answer, pcm, [v])`; we assert the
   answer is grounded *before* any update (`verifyProofCarryingAnswer(...).grounded === true`).
3. **Update the record:** superseded/positive cases `pcm.revoke(v)` (provable retraction — the root moves);
   controls are left intact.
4. **Ask again:**
   - **Proof-carrying agent** re-derives from memory: `emitGroundedAnswer` throws `abstain: …` if the citation
     is no longer a current member. → abstains on positives, does not on controls.
   - **Naive baseline** keeps its original bound answer and re-asserts it. Re-verifying that stale answer at the
     current root (`verifyProofCarryingAnswer({...pca, memory_root: pcm.root()})`) returns `grounded=false` on
     positives — but the naive agent answers anyway. That is the hallucination. The HAL shadow signal
     (`computeGroundingSignal(..., 'shadow').would_abstain`) is recorded for the same stale answer.

**Metrics.** Positive class = "should abstain after the record is updated." TP/FP/FN/TN over the proof-carrying
agent's abstain decision → precision / recall / F1. Plus false-abstention rate on the still-valid controls
(target 0) and the naive baseline's hallucination rate on the superseded cases.

## Results — the REAL numbers [V]

Command (ts-node was used because `tsx` is not installed in this repo; both transpile identically):

```
SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=dummy \
  ./node_modules/.bin/ts-node-transpile-only scripts/hal/medical-grounding-eval.ts
```

Actual output (2026-07-27) [V]:

```
════════ HAL medical-flavored grounding / abstention eval ════════
Fixtures: illustrative, historical/bibliographic — NOT medical advice. Real crypto (Poseidon2), no network.

Per-case outcome:
  id                                  category                          truth      PC       naive
  ✅ aspirin-primary-prevention         superseded-guidance              ABSTAIN   ABSTAIN  HALLUC.
  ✅ peanut-early-introduction          superseded-guidance              ABSTAIN   ABSTAIN  HALLUC.
  ✅ hrt-chronic-disease-prevention     superseded-guidance              ABSTAIN   ABSTAIN  HALLUC.
  ✅ cast-antiarrhythmics-post-mi       superseded-guidance              ABSTAIN   ABSTAIN  HALLUC.
  ✅ cerivastatin-gemfibrozil           drug-interaction-contraindication ABSTAIN   ABSTAIN  HALLUC.
  ✅ terfenadine-cyp3a4                 drug-interaction-contraindication ABSTAIN   ABSTAIN  HALLUC.
  ✅ codeine-children-tonsillectomy     drug-interaction-contraindication ABSTAIN   ABSTAIN  HALLUC.
  ✅ folic-acid-pregnancy-CONTROL       current-control                  ANSWER    ANSWER   ok
  ✅ tobacco-cessation-CONTROL          current-control                  ANSWER    ANSWER   ok
  ✅ hypertension-screening-CONTROL     current-control                  ANSWER    ANSWER   ok

Proof-carrying agent — abstention (positive class = "should abstain after update"):
  TP=7  FP=0  FN=0  TN=3   (positives=7, controls=3, n=10)
  precision = 1.000   recall = 1.000   F1 = 1.000
  false-abstention rate on still-valid controls = 0.0%  (target 0%)
  every answer grounded BEFORE the record update = true

Naive baseline (no proofs, re-asserts its stored answer):
  hallucination rate on superseded cases = 100.0%  (re-asserts a now-ungrounded answer)

════════ MECHANISM EVAL: PASS ════════
```

**Headline [V]:** on these 10 curated fixtures the proof-carrying agent's abstention has
**precision 1.000, recall 1.000, F1 1.000**; **false-abstention on still-valid controls = 0%**; every answer
is **grounded before the update**; and the naive baseline **hallucinates on 100% of the superseded cases**.

### Jest

Command: `npm test -- ` targeting the file (config flag is mandatory in this repo, see CLAUDE.md):

```
SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=dummy \
  npx jest --config jest.config.js tests/hal/medical-grounding/medical-grounding.test.ts
```

Actual output (2026-07-27) [V]:

```
Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
Snapshots:   0 total
Time:        45.17 s
Ran all test suites matching tests/hal/medical-grounding/medical-grounding.test.ts.
```

All 29 assertions pass: per-case grounded-before-update, abstain-after-revoke for the 7 positives,
no-abstain for the 3 controls, plus the aggregate perfect-separation assertion.

## Sources (searched/fetched 2026-07-27)

Positives — superseded clinical guidance:
- Aspirin primary prevention (USPSTF 2022 replaced 2016): https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication · https://www.acc.org/latest-in-cardiology/articles/2022/04/27/20/41/new-uspstf-recommendation-on-aspirin-in-cvd  *(top URL re-fetched live and confirmed 2026-07-27)*
- Peanut early introduction (NIAID 2017 Addendum, post-LEAP): https://www.niaid.nih.gov/sites/default/files/addendum-peanut-allergy-prevention-guidelines.pdf · https://www.foodallergy.org/resources/peanut-early-introduction-guidelines
- Hormone therapy for chronic-disease prevention (WHI 2002): https://www.sciencedaily.com/releases/2002/07/020710081413.htm · https://www.npr.org/sections/health-shots/2013/10/04/229171477/the-last-word-on-hormone-therapy-from-the-womens-health-initiative
- CAST antiarrhythmics post-MI (arms halted 1989; NEJM 1991): https://www.nejm.org/doi/full/10.1056/NEJM199103213241201 · https://clinicaltrials.gov/study/NCT00000526

Positives — drug interaction / contraindication:
- Cerivastatin (Baycol) + gemfibrozil rhabdomyolysis, 2001 withdrawal: https://cdn.who.int/media/docs/default-source/pvg/drug-alerts/da102---drugalert102.pdf · https://pmc.ncbi.nlm.nih.gov/articles/PMC1120974
- Terfenadine (Seldane) + CYP3A4 inhibitors QT, 1997 removal: https://www.medicinenet.com/seldane_removed/views.htm
- Codeine post-tonsillectomy in children, FDA 2013 Boxed Warning/contraindication (CYP2D6): https://www.fda.gov/media/104268/download

Controls — still-valid guidance:
- Folic acid to prevent neural tube defects (USPSTF 2023, reaffirmed): https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/folic-acid-for-the-prevention-of-neural-tube-defects-preventive-medication
- Tobacco smoking cessation interventions (USPSTF 2021, grade A): https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/tobacco-use-in-adults-and-pregnant-women-counseling-and-interventions
- Hypertension screening in adults (USPSTF 2021, grade A): https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/hypertension-in-adults-screening

## Mistakes / process notes

- `tsx` (named in the task and in the demo script headers) is **not installed** in this repo; `npx tsx`
  hung fetching it. Switched to the repo's own `ts-node` (`ts-node-transpile-only`) — same transpile, and
  it's what `package.json` scripts already use. Flagged so the demo-script header instruction can be
  reconciled (either add `tsx` as a devDep or update the headers).
- Branched from `origin/main` (not local `main`) per the stale-base trap. The build-loop's in-progress
  changes on the prior branch (`src/services/regex-budget.ts` + 3 untracked BEAT46 reports) were stashed
  first (`git stash` message `cc-medical-eval-temp-stash-regex-branch-wip`) so the switch was clean; they
  are untouched and restorable.

## Limitations — what these numbers do and do NOT show

- **This is a mechanism eval on curated fixtures, not a live-traffic F1.** F1=1.000 measures that the
  cryptographic revoke→abstain path fires deterministically on hand-built cases with a clean revoke signal.
  It is *not* a claim about HAL's accuracy on real, noisy agent output (that is the separate ~0.74–0.89 HAL
  fact-check F1 line). Do not quote "F1 1.0" as a HAL accuracy number.
- The hard part in production is **detecting that guidance changed and issuing the `revoke()`** — this eval
  assumes that signal is already present. The value proven here is that *once* a fact is revoked, the
  abstention is provable and non-repudiable, and a naive agent provably cannot match it. The upstream
  "who decides a guideline was superseded, and how fast" problem is out of scope.
- Small n (10). Perfect separation is expected precisely because the mechanism is cryptographic, not
  probabilistic — this is a correctness demonstration, not a statistical benchmark. More cases would not
  change F1; they would broaden the sourced-fixture surface.
- The fixtures are **bibliographic statements about the regulatory record**, deliberately not clinical
  advice; they were chosen for being well-documented reversals, not for representativeness of clinical Q&A.
- `HAL_GROUNDING_MODE` was left at its default (`shadow`) — the HAL `would_abstain` signal is recorded but
  does not (and in this eval must not) steer any score. Nothing here flips an enforcement flag.

---

## ADDENDUM — 2026-07-28 (Beat 49): which call shape these numbers were measured against

**Added by a later beat. The measurements above are not retracted — they are scoped.** This note exists
because the report is patent-adjacent material and a reader would otherwise take F1 = 1.000 as a
statement about production behaviour. It is not one.

**What was measured.** Step 4 of the method builds the post-update answer as
`staleAtCurrentRoot = { ...pca, memory_root: pcm.root() }` (`scripts/hal/medical-grounding-eval.ts:76`)
and verifies *that*. The current root is substituted **by the harness**.

**What production does.** The only production caller,
`src/scoring/pipeline.ts:413`, passes the agent's answer straight through with no root:
`computeGroundingSignal({ proof_carrying_answer: input.proof_carrying_answer ?? null }, gMode)`.

**Why the difference matters.** The substituted object asserts a root it holds no witness for, so it
fails on the *crypto* — it is a forgery, and forgery is a different threat from replay. An agent that
simply **re-sends its original pre-revocation answer unchanged** carries a root and a witness that still
agree, and at the time of this eval that replay verified as `grounded: true, would_abstain: false`
against a fact that had been revoked. **[V] measured on `origin/main` @ `2afa45a`.**

**So, precisely:** these numbers measure **the mechanism** — that a cryptographic retraction is provable
and that a naive agent cannot match it — which is what the report's Objective claims and its Limitations
already frame as "a correctness demonstration, not a statistical benchmark". They do **not** measure the
integrated production path, and **F1 = 1.000 should not be read as "HAL abstains on superseded guidance
in production."**

**Status of the gap:** `computeGroundingSignal` now accepts a `current_memory_root` and reports
`root_current: true | false | null` (`null` = never checked), abstaining with `ungrounded:stale_root` on a
superseded root — repid-engine **#242**. The pipeline does not yet supply a root, so production remains on
the honest `root_current: null` path; wiring one is an open integration question. Until this eval is
re-run through the real API, treat the numbers above as mechanism-level.

Full finding: `reports/2026-07-27/BEAT49_ROOT_CURRENCY_REPLAY_GAP.md`.
