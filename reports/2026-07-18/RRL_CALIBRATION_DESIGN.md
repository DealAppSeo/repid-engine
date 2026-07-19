# RRL Calibration-Correction — Design + Proof of Concept (WS2.3)

**Branch:** `feat/rrl-calibration` (off `feat/hal-outcome-labeling`) · branch-only, no prod, `src/hal/lib/*` untouched.
**Deliverables:** `src/rrl/calibration.ts` (pure, unit-tested) · toggle in `src/rrl/scoring.ts` (default OFF) · `--calibrate` in `scripts/rrl/shadow-replay.ts`.
**Author:** CC · **Date:** 2026-07-18 · Claude+Grok concur (D-054) — in scope (RRL Stage-1 unblock, TRUE_NORTH V1.3/RRL).

---

## 1. The blocker

WS2.3's shadow RRL passed all four exit gates on **synthetic** agents. On **real** labeled HAL outcomes
(`reports/2026-07-18/hal-outcomes.jsonl`) **Gate-1 (calibration / Expected Calibration Error) FAILS**:

| | raw aggregate ECE | threshold |
|---|---:|---|
| Real committed provider answers | **0.132** | < 0.05 ❌ |

The cause is **not** an RRL bug. Real LLM providers do not report honest probabilities, and — importantly —
they are miscalibrated *heterogeneously*, not uniformly overconfident:

| Provider | n (committed) | realized acc | mean stated conf | over/under-confidence | raw ECE |
|---|---:|---:|---:|---:|---:|
| deepseek | 245 | 0.890 | 0.838 | **−0.05 (under)** | 0.194 |
| grok | 231 | 0.848 | 0.863 | +0.01 (near) | 0.051 |
| openrouter-qwen | 191 | 0.838 | 0.933 | +0.08 (over) | 0.096 |
| openrouter-gemini | 246 | 0.797 | 0.990 | **+0.19 (over)** | 0.194 |

Gemini says ~0.99 and is right ~0.80; deepseek is actually a bit *under*-confident and noisy. Because the
providers' confidence is a systematically-biased-but-*consistent* signal, it is **correctable** — and because
they differ, there is a **real calibration gradient to reward**.

---

## 2. The design choice (this is the crux)

The task frames three options. The trap is real: **Option A alone erases the very incentive RRL exists to
create.** Here is the reasoning and the recommendation.

### Option A — recalibrate confidence before RRL scores it
Fit each provider's reliability curve and map raw→calibrated confidence, then score the calibrated value.
- **Pro:** directly fixes the ECE — after recalibration the signal is well-calibrated by construction.
- **Con (the trap):** if RRL's calibration *reward* is computed on the recalibrated confidence, every provider
  looks calibrated afterwards, so RRL can no longer **reward** being calibrated. The incentive is erased.
- **Also:** measuring ECE on the *same* data you fit the calibrator on is **circular** — isotonic/binned
  calibration drives in-sample ECE toward ~0 by construction. In-sample ECE is not evidence of anything.

### Option B — score RELATIVE calibration
Reward providers better-calibrated than their peers (grade on a curve, since absolute calibration is
unwinnable on real LLMs).
- **Pro:** preserves an incentive gradient; our data shows it is real (grok ≪ gemini in ECE).
- **Con:** does not, by itself, make an *absolute* ECE gate pass; gives no signal if all providers are
  equally bad.

### Option C — per-provider baseline-adjusted scoring
Reward a provider for improving on its **own** historical calibration (antifragile / recovery-path).
- **Pro:** preserves the incentive to *improve*; matches RRL M9 ("reliability curve over time") and the
  design's required recovery path (v0.1 M13).
- **Con:** needs a **temporal baseline**. The current labeled corpus is **single-shot** — there is no
  per-provider calibration history yet, so C is **not measurable on today's data**.

### RECOMMENDATION — HYBRID: **A for the signal + B for the reward, C staged for Stage-1.5**

The resolution is to notice that **"calibration" is used for two different jobs on two different quantities**,
and to stop conflating them:

1. **The trusted SIGNAL (Option A).** RRL should recalibrate each provider's confidence into an honest
   posterior probability and *act on that* (weight verdicts, feed the quorum, report to consumers). This is
   the correct Bayesian move: "gemini says 0.99, but gemini-at-0.99 is right ~0.80, so the true probability is
   ~0.80." **Gate-1 is measured on this recalibrated signal, OUT-OF-SAMPLE** — because Gate-1's purpose is to
   certify *the probability RRL trusts*, not to certify the LLM vendors (which RRL cannot fix and must not be
   blocked on forever). Re-specifying the gate this way is an honesty fix, not tuning-to-pass, **provided the
   number is out-of-sample** (see §3).

2. **The REWARD / incentive (Options B, and C when data allows).** RRL's calibration *reward* stays computed
   on **raw** stated confidence — so honest self-reporting is still what pays (a provider that says 0.99 and is
   wrong still eats the Brier loss). To keep a live gradient once absolute calibration is unwinnable, the
   *credential* is scored **relative to peers (B)** now, and **relative to the provider's own rolling baseline
   (C)** once history exists. Because providers differ a lot, this gradient is real and is **not** flattened by
   step 1 — the two operate on different quantities (recalibrated signal vs raw report) for different purposes
   (trust vs reward).

**Why this keeps the incentive intact:** recalibration de-biases *what RRL believes*; the credential rewards
*how honestly the provider reported*. A perfectly honest reporter needs no recalibration and earns the full
relative credential; an overconfident one gets its signal corrected **and** its credential shaved. Neither
erases the other.

The retained diagnostic — **raw ECE per provider** — is kept and surfaced (it is the provider-honesty signal),
but it is **not** the Stage-1 blocker, because "is this LLM vendor honest?" is not a property RRL controls.

---

## 3. Proof of concept on real data

`npx tsx scripts/rrl/shadow-replay.ts --mode real [--calibrate]` (source: `hal-outcomes.jsonl`, **N = 250
labeled rows / 890+ committed provider verdicts across 4 living providers**; groq is infra-dead — 401 stale
key — and excluded from calibration).

### Gate-1 ECE, before vs after

| Measurement | ECE | vs < 0.05 | note |
|---|---:|---|---|
| **Raw** (self-reported confidence) | **0.132** | ❌ | provider-honesty diagnostic — kept, not the gate |
| Recalibrated, **in-sample** | 0.005 | ✅ | **circular — NOT claimed as the result** |
| Recalibrated, **5-fold out-of-sample** | **0.022** | ✅ | **the honest gate number** |
| Recalibrated, **10-fold out-of-sample** | 0.018 | ✅ | corroborates |

Per-provider 5-fold OOS ECE: grok 0.027 · qwen 0.012 · gemini 0.039 · **deepseek 0.084** (the noisy,
under-confident provider is still > 0.05 *individually*, but the **aggregate** is robust because errors
partially cancel and the well-fit providers dominate).

**Result: the calibration correction moves the honest (out-of-sample) Gate-1 ECE from 0.132 → 0.022, comfortably
under 0.05, without tuning to force a pass** (K-fold holds out the evaluation data from the fit).

Incentive check (Option B) on the same run — the reward gradient survives recalibration:

| Provider | raw ECE | relative-calibration credential (×) |
|---|---:|---:|
| grok | 0.051 | 1.00 |
| openrouter-qwen | 0.096 | 1.00 |
| deepseek | 0.194 | 0.41 |
| openrouter-gemini | 0.194 | 0.41 |

### Method
Per-provider **binned reliability curve** (10 conf bins) with **Beta-shrinkage toward the provider prior**
(`(correct + K·prior)/(n + K)`, K = 10) and **isotonic (PAV) monotonisation** so a higher stated confidence
can never map to a lower calibrated probability. Below `minSamples = 30` the curve is the **identity map**
(refuse to fit what we can't support). All pure/deterministic — folds are index-residue, no RNG.

---

## 4. Data-sufficiency verdict (is 40–250 rows enough?)

**The relevant unit is committed answers PER PROVIDER, not total rows.** Aggregate 5-fold OOS ECE as the
per-provider sample cap grows (measured on the current corpus):

| committed answers / provider | OOS aggregate ECE | passes < 0.05 |
|---:|---:|---|
| ≤ 25 | 0.126 | ❌ (below `minSamples`, mostly identity) |
| ≤ 50 | 0.052 | ❌ (just misses) |
| ≤ 75 | 0.036 | ✅ |
| ≤ 100 | 0.021 | ✅ |
| ≤ 150–246 | ~0.02 | ✅ (stable) |

**Verdict:**
- **Aggregate Gate-1: PASSABLE NOW.** We have ~190–246 committed answers per living provider — well above the
  ~75–100/provider where the OOS aggregate stabilises under 0.05. So on **total** rows: ~250 labeled rows is
  *enough for the aggregate gate*, because each row yields ~4 provider verdicts (~1k pairs). The low end of the
  "40–250" range (≤ ~60 rows ≈ ≤ ~50/provider) would **not** be enough.
- **Strict per-provider gate: NOT quite.** The worst provider (deepseek, under-confident + noisy) sits at 0.084
  OOS. A per-provider ECE gate would need either more labeled data for that provider or a coarser (fewer-bin)
  fit. Recommend gating on the **aggregate** OOS ECE at Stage-1, and tracking per-provider ECE as a diagnostic.
- **Option C (self-baseline) needs time, not volume:** it is unmeasurable until we have ≥ 2 temporally-separated
  calibration snapshots per provider. Stage-1.5 item.

---

## 5. Does this unblock RRL Stage-1?

**Gate-1: YES**, on the honest out-of-sample number (0.022 < 0.05), with the incentive preserved. The
recalibration is a real, non-circular fix and the labeled data at current volume is sufficient for the
aggregate gate.

**But Stage-1 is not fully green yet** — two *other*, calibration-independent gates still fail on real data and
are pre-existing (not addressed by this work):
- **Gate-3 / Gate-4** trip on the **infra-dead groq provider** (stale 401 key → 0 committed answers → nuked
  below baseline + trips the M4 coverage-floor detector every round). This is an **infrastructure** failure
  (dead key), not an RRL rule failure; Gate-4b (live providers only) = 0.002 ✅. Fix = restore/remove the groq
  key, not a scoring change.
- **Single-shot corpus** leaves M1 (repair), M6 (red-team), and concealment-surfacing **unexercised** on real
  data — orthogonal to calibration, flagged in the shadow-replay report.

**Bottom line:** this work removes the calibration blocker to RRL Stage-1 and keeps RRL's "reward calibration +
honesty" incentive intact. Remaining Stage-1 work is (a) provider-infra hygiene (groq key) and (b) multi-shot /
temporal labeled data to exercise repair/red-team and to unlock Option C. No merge without human co-sign (A6).

---

## 6. What shipped (branch `feat/rrl-calibration`)
- `src/rrl/calibration.ts` — pure/deterministic reliability-curve fit + apply (binned-shrinkage + isotonic),
  ECE, K-fold OOS ECE, and the relative/self-baseline credentials. Unit-tested (`tests/rrl-calibration.test.ts`,
  18 tests: monotonicity, small-sample shrinkage + identity, known-input correction, OOS, determinism).
- `src/rrl/scoring.ts` — optional `calibrator` constructor arg (default **undefined ⇒ byte-identical** to the
  locked WS2.2 core; the anti-drift invariant vs `honesty-sim.ts` holds). When supplied, only the Brier term
  is scored on recalibrated confidence; M9 + raw stats stay on the raw report.
- `scripts/rrl/shadow-replay.ts` — `--calibrate` flag: fits per-provider curves from the stream, recalibrates
  the Gate-1 diagram, and reports raw / in-sample / 5-fold + 10-fold OOS ECE. Writes
  `RRL_SHADOW_REPLAY_REAL_CALIBRATED.md` (vs `…REAL_RESULTS.md` for the off run).
