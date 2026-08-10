# HAL + RepID → TrustShell ship sprint — 2026-08-09

**Goal (Sean):** improve HAL and RepID until they are genuinely cutting-edge, measure honestly, ship
tomorrow as an improved TrustShell — the portable zk trust harness with earned reputation.

**Surface:** local Claude Code (full access). **Mode:** BUILD, branch-only, claim-gate honored.
Every number carries its ruler (CLAUDE_RULES r24). No overfitting to the holdout.

---

## The honest starting picture (verified by reading the code, 2026-08-09)

Both systems are far more built than "improve" implies. The work is measure → tune the levers that
already exist → validate → wire the one real gap → ship the validated config. Not net-new invention.

### HAL — what exists
- `halService.evaluate({text, strictness})` → cross-family fact-check quorum. Free→cheap→escalation
  cost-ordered assembly, stops at ≥2 distinct **families** (not hosts). `src/hal/fact-check.ts`.
- Precision levers ALL BUILT, most OFF by default:
  - `HAL_PLURALITY_GUARD` (default **ON**) — a FALSE minority cannot veto a TRUE plurality.
  - `HAL_DECISION_MODE=verdict` (default score) — family-aware verdict counting (more explainable).
  - `HAL_VERDICT_DRIVEN_VETO` (default off) — no-FALSE-quorum veto → flag.
  - `HAL_ESCALATE_GROK` (default off) — Grok tiebreak on even split + weak-veto override.
  - `HAL_RETRIEVAL_ENABLED` (default off) — CRAG web-retrieval slow path for uncertain/high-stakes.
  - `HAL_SBFA_SHADOW` (default on, non-enforcing) — DST belief/ignorance glass box.
- Measurement discipline is already best-practice: ruler-as-refusal (`measurement-ruler.ts`), corpus
  hash gate + ≥80% coverage gate (`run-frozen-corpus-local.ts`).

### RepID — what exists
- Asymmetric deception penalty (the Satoshi property): defended deception **−60/−40** vs honest error
  **−8**; gated on a CONFIRMED grounded detection; SHADOW-first (`TRUST_DECEPTION_MODE`).
- Self-report evidence gate = **enforce** (unproven self-awards earn 0). STAKE gated to 0.
- zk proof: real Plonky3 leaf, locally WASM-verifiable; statement now binds agent_id + erc8004_token_id
  (#395, merged today) — trustless proof→token linkage.

### HAL↔RepID wiring — VERIFIED, not a gap (corrected 2026-08-09)
First read of `repid-update.ts:579-580` (`hal_score: 0.0` hardcoded) looked like a missing link. It
isn't: that path scores event-type deltas (challenges / contributions / deception) which carry no
factual claim to fact-check. **The real HAL→RepID wiring lives in `scoring/pipeline.ts::runScoreEvent`**
and is sophisticated — runs `halService.evaluate`, records real `hal_score`/`hal_decision`/
`hallucination_caught` + quorum evidence, and gates the RepID delta on quorum + hallucination-caught +
a task-purpose gate. Nothing to wire.

**CORRECTION [V sql 2026-08-09] — strictness-2 is ALREADY LIVE.** I first claimed `runScoreEvent`
defaults to `HAL_STRICTNESS=1` (blind extractor) and the strong path was a pending Sean-gated flip.
That was wrong — I read the ENV default (1) + a stale code comment and never checked `repid_config`,
whose value **wins** over env. Verified against the live DB:
- `repid_config.HAL_STRICTNESS = '2'` (+ decision/penalty-requires-quorum both `true`).
- Every recent production `HAL_SCORE_EVENT` (2026-08-02 → 08-09) ran `hal_mode=fact-check`,
  `decision_source=fact-check-quorum`, `quorum_met=true`, **3–5 families** (llama/glm/gemini/mistral/qwen),
  with grounded vetoes (`hallucination_caught=true`). The cross-LLM quorum IS gating live RepID today.
- Volume is tiny (**11 HAL_SCORE_EVENTs in 7d**, ~1/day) → the flip's cost/latency concern is moot.

So the ~0.91 instrument I measured on the holdout is the SAME path already gating production. The
"strictness-2 flip" is not pending — it's operational and now independently verified. My verify-first
miss (CLAUDE_RULES r1): a claim about live state from reading code, not the DB.

---

## Experiment protocol (no overfitting)

Ruler: `rigorous-v1@596f10de18d0` (99 holdout / 232 train, HaluEval+FEVER+TruthfulQA+canary),
strictness 2, family-aware quorum. Positive class = hallucination (label FALSE). Veto = predicted
hallucination.

1. **Baseline** (default config) on holdout — the honest current number. [running]
2. Capture per-row provider verdicts on **train**; analyze failure modes (FP vs FN, family pattern).
3. Sweep the built-in levers on **train only**; pick the config maximizing train F1.
4. Report ONE validated number on **holdout** for the chosen config. Never tune on holdout.
5. Wire HAL→RepID (shadow-first) once the HAL config is chosen.

## Results

### Baseline (default config) — holdout [V 2026-08-09]
`F1 = 0.9200 on rigorous-v1@596f10de18d0 [holdout], strictness 2, family-aware quorum, 100% coverage (99/99)`
- precision 0.8846 · recall 0.9583 · accuracy 0.9192 · TP 46 / FP 6 / FN 2 / TN 45
- This is a strong, defensible number on an adversarial corpus. Precision is the weaker axis.

### Failure analysis
- **6 false-positives — ALL weak vetoes** (halScore 0.500–0.667, just over the 0.5 threshold). TRUE
  claims the free 8B panel wrongly called FALSE, no TRUE-plurality to protect them. → the exact target
  of the cycle-3 Grok weak-veto override (`HAL_ESCALATE_GROK`).
- **2 false-negatives:** fever-5032895b (0.444, borderline under threshold) + halueval-1141e47f
  (0.019 — whole panel fooled; only retrieval/a stronger model catches this).
- **Chosen lever:** `HAL_ESCALATE_GROK=true`. Fail-safe: only downgrades *weak* vetoes; strong-consensus
  (≥75% FALSE families + score comfortably over threshold) is NEVER escalated → recall protected.

### ⚠ MEASUREMENT NOISE — the eval is non-deterministic [V 2026-08-09]
Two runs of the *same* config (grok flag on, but key was misnamed → grok never fired, so identical to
baseline) gave **F1 0.9200** and **F1 0.9072**. Free-tier models vary run-to-run even at temperature 0,
and which providers answer shifts with rate-limiting. **Single-run F1 noise ≈ ±0.013.** So:
- The honest baseline is a RANGE: **~0.91–0.92** (not a point).
- A lever's effect must clear the noise floor, or be shown at the MECHANISM level (did the specific
  known-failure rows get corrected?), not by one-run-vs-one-run F1.
- This retroactively explains the "four rulers" spread (0.886/0.890/…): several were within noise.

### Real bug found + fixed: Grok lever was a silent no-op
`grokTiebreak`/both escalation gates read `GROK_API_KEY`, but the key inventory stores it as
`XAI_API_KEY` → `HAL_ESCALATE_GROK=true` did NOTHING (0 escalations, confirmed). Fixed:
`grokApiKey()` now reads `GROK_API_KEY || XAI_API_KEY`. Zero change where GROK_API_KEY is set.

### Candidate: + Grok weak-veto override (lever now live) — holdout, 3×3 paired [V 2026-08-09]
| config | F1 mean | F1 range | precision | recall |
|--------|---------|----------|-----------|--------|
| baseline | 0.9078 | 0.896–0.918 | 0.8927 | 0.9236 |
| + grok override | 0.9136 | 0.909–0.917 | **0.9113** | 0.9167 |

**Honest verdict: NOT an F1 win.** ΔF1 = +0.006 is INSIDE the ±0.013 noise (ranges overlap). The
single 0.9375 run earlier was a favorable draw — not claimed. What IS robust is the **precision/recall
shift**: grok cuts false-vetoes (precision +0.019) at a small recall cost (−0.007). For a TRUST product
a false veto on an honest agent is the worst outcome, so **grok-on is a defensible precision-favoring
config** — but it is NOT "HAL got more accurate." The `grokApiKey()` fix is a real bug fix regardless
(the lever was dead). Whether to pay grok's per-weak-veto latency/cost for the precision shift is Sean's
call; default stays OFF.

### What this tells us about the ceiling
HAL at ~0.91 F1 on an adversarial corpus with a **free 8B panel** is already competitive with published
detectors. The residual errors are panel-quality limited (confident-wrong 8B consensus on obscure facts;
one whole-panel miss at score 0.019). The levers with a real shot at moving BOTH precision and recall:
(a) a stronger standing quorum member, (b) retrieval grounding (CRAG).

### Candidate: + retrieval grounding (CRAG slow path) — holdout, 3 runs [V 2026-08-09]
`HAL_RETRIEVAL_ENABLED=true` — on uncertain / family-split / high-stakes cases, retrieve web evidence
(Firecrawl→Tavily→Brave) and CRAG-grade it to refine the decision.

| config | F1 mean | F1 runs | vs baseline |
|--------|---------|---------|-------------|
| baseline | 0.9078 | 0.909 / 0.896 / 0.918 | — |
| + retrieval | 0.9229 | 0.9375 / 0.9375 / **0.8936** | +0.015 |

**Correction — NOT the clean win the first 2 runs implied.** Runs 1–2 landed on an identical 0.9375
matrix and I called it robust; **run 3 came back 0.8936 — inside the baseline range.** Retrieval mean
+0.015 is barely above the ±0.013 noise, and it has its OWN variance (web results + CRAG grading vary).
The bidirectional mechanism is real (upgrades false-positives AND catches misses), but the aggregate
effect on this corpus is marginal, not the +0.03 two runs suggested. **Lesson (2nd time tonight): never
call an improvement on <3 runs.**

### Candidate: + FRONTIER panel (GPT-4o + Claude-Sonnet-4) — holdout, 3 runs [V 2026-08-09]
`HAL_S2_ENABLE_FRONTIER=true HAL_QUORUM_COST_ORDERED=false` — add two strong, independent families
(openai, anthropic, via OpenRouter) as standing quorum voters. Opt-in, default OFF; prod unchanged.

| panel | F1 mean | F1 runs | precision | recall |
|-------|---------|---------|-----------|--------|
| baseline | 0.9078 | .896/.909/.918 | 0.8927 | 0.9236 |
| + frontier | 0.9183 | .907/.918/.929 | 0.9000 | **0.9375** |

**Mild lift, still within noise.** ΔF1 +0.010 (mostly recall +0.014); all 3 frontier runs ≥ baseline
mean (cleaner trend than grok/retrieval) but ranges overlap. Frontier voters were fully reliable (0
failures, ~99 votes each). **The key finding: even frontier models move HAL only ~+0.01, so ~0.91 is
near the CORPUS ceiling, not a weak-panel ceiling** — the residual errors are adversarially-labeled /
genuinely-ambiguous rows (TruthfulQA/HaluEval) where GPT-4o and Claude also disagree. "Better models" =
diminishing returns at real cost. A reliability-WEIGHTED quorum (frontier voters weighted > 8B) is the
only untested idea that might extract more — deeper change, not tonight.

### Honest bottom line on HAL accuracy
On rigorous-v1 with the **free-8B cross-family panel**, HAL sits at a **panel-limited ceiling of ~0.91 F1**,
and NONE of the built-in levers (grok override, retrieval) move it robustly above the run-to-run noise.
That ~0.91 is already competitive with published detectors. The real path to a higher ceiling is **panel
quality** — putting a frontier model in the standing quorum (not just as a tiebreak) — which is a cost
decision, not a code gap. What ships tonight is the honest, reproducible measurement + the grok bug fix;
the "make it dramatically more accurate" lever is better models, and that's a spend call for Sean.

---

## RepID audit — the "ungameable" keystone is DORMANT (verified 2026-08-09)

**Finding [V]:** the asymmetric deception penalty (defended deception −60/−40 vs honest error −8 — the
Satoshi "cheating costs more than honesty" property) is fully built, tested, and shadow-gated, BUT the
detector that fires it is **never invoked on live traffic.**
- `updateRepId` is called from exactly two places: `routes/bounties.ts` (bounty payout) and
  `routes/score.ts` (passes `req.body` through). Neither runs deception detection.
- `classifyInteraction` / the 9 detectors in `behavioral-integrity.ts` have **no live caller** (grep-verified,
  defs + tests only).
- The powerful, −60-eligible detectors (denial-of-prior-output, fabricated citation/tool-result/benchmark,
  story-change) require a hash-chained `InteractionRecord` of prior receipts — and **nothing builds that
  record from live traffic.** The heuristic-only detectors (doubt-attack/sycophantic/threshold-dancing) are
  advisory (confidence ≤0.6 → delta 0).

**Consequence for claims:** RepID is NOT "ungameable via deception detection" today — that keystone is
inert. This confirms and sharpens the existing claim-gate hold on the word "ungameable." Do NOT ship it.

**Activation (a real build, not a patch):** persist a per-agent receipt chain from live interactions
(statements/tool-results/citations), run `classifyInteraction` on each new interaction, emit shadow
deception events on confirmed grounded detections. Shadow-first (TRUST_DECEPTION_MODE already defaults
shadow) → measurable, zero live effect until Sean flips enforce. Scoped as the next RepID sprint.

---

## Shippable tonight (honest)
1. **PR #398 — Grok lever bug fix** (`grokApiKey()` reads XAI_API_KEY). Real bug fix (dead lever);
   precision-favoring option, NOT an F1 win. Default OFF. (Note: first push clobbered fact-check.ts with a
   stale copy — caught via CI, force-pushed a clean 13-line delta.)
2. **PR #399 — merge-integration test fix** (proof-statement-live-score: #389's 2-key assertion vs #395's
   4-key bound statement). Unblocks the whole queue (#396/#398 were red on this, not their own code).
3. **The reproducible measurement itself** — F1 ~0.91 on rigorous-v1@596f10de18d0 holdout, with ruler,
   100% coverage, and the run-to-run noise quantified (±0.013). That honesty IS a deliverable.
4. **Strictness-2 is ALREADY live + verified** (repid_config, production events) — NOT a pending flip.
   Live RepID scoring is gated by the real cross-LLM quorum today; the ~0.91 holdout instrument is that path.
5. **RepID:** deception keystone dormant — documented, scoped, NOT faked.

## What "cutting edge" honestly means here (for Sean)
- HAL is **already good** (~0.91 F1 on an adversarial corpus, reproducible, keyless) AND **already gating
  live RepID at strictness-2** (verified) — the work tonight proved the accuracy with a ruler, fixed a dead
  lever, and corrected my own wrong "it's still on the extractor" claim.
- Raising the accuracy ceiling further is **diminishing returns**: even frontier models add only ~+0.01
  (within noise) — ~0.91 is near the CORPUS ceiling, not a model ceiling.
- The remaining real build is **RepID**: the zk-portable earned-reputation + asymmetric-penalty design is
  real, but the deception **detector is not wired to live traffic** — so "ungameable" stays held. Wiring it
  (receipt chain + shadow detection) is the next high-value build.

