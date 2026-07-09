# HAL Rigorous Evaluation — answering "why N=47?" and testing the quorum-independence thesis

**Date:** 2026-07-09 · **Branch:** `feat/cc-2026-07-09-hal-rigorous-eval` (branch-only, no merge)
**Author:** CC (Opus) · **Discipline:** real providers only; provenance-required corpus (RULE-19); no tuning-to-pass; real numbers reported even where they refute the thesis (RULE-4).

---

## TL;DR (verified this run)

- **Corpus scaled 47 → 337 fully-provenanced claims** (FEVER + HaluEval + TruthfulQA + the in-repo canary), balanced 173 TRUE / 164 FALSE. Every scored row carries `{source, source_id, url, label}`. No synthetic rows in the headline set.
- **Real cross-LLM quorum, N=337, 7 live hosts / 5 families** — headline (flag/veto = "caught"):
  **F1 = 0.795 [0.747, 0.837]**, precision **0.683 [0.622, 0.742]**, **RECALL = 0.951 [0.915, 0.981]**, **AUC = 0.899 [0.864, 0.932]** (bootstrap 95% CIs, B=10k). Calibration **ECE = 0.056** (well-calibrated).
- **The 0.34-vs-0.95 gap is explained:** the record's F1≈0.34 / recall≈22% measured the *deterministic-extractor* / degraded path, **not** the real multi-family cross-LLM quorum. The real quorum recalls **95%** of FALSE claims (it errs toward over-flagging, precision 0.68). The canary 0.95 was F1 on an easy 47-item set; on this harder, adversarial-inclusive 337-set the real F1 is ~0.80.
- **Quorum-vs-best-single: the "quorum wins" claim is UNDER-SUPPORTED.** On the same 319 claims, **DeepSeek alone F1 0.862** (P .912 / R .817) vs **family-quorum F1 0.847** (P .810 / R .889). The quorum buys **recall + vendor-independence**, not a clear accuracy gain over the single best model.
- **THESIS VERDICT — shared blind spots are real; "independence" is partly an illusion.** The two hosts serving *identical* Llama-3.1-8B weights (**Groq + DeepInfra**) have **error-correlation 0.881, Cohen κ 0.917** — the highest of all 21 pairs. Counting them as two independent votes is fake diversity. Even *genuinely distinct* families are **not** independent: mean inter-family error-correlation **0.348**, mean κ **0.62**. Distinct families are *more* independent than identical weights (0.35 < 0.88), so a **weight-deduplicated** quorum buys *some* real diversity — but far less than "6 providers" implies.

---

## 1. What was measured

- **System under test:** the production HAL cross-LLM fact-check quorum — `factCheck()` in `src/hal/fact-check.ts`, invoked locally with live keys (`HAL_DECISION_MODE=verdict`, family-aware, `HAL_QUORUM_COST_ORDERED=false` so **every** provider votes on **every** claim). This is the REAL decision path, not the deterministic extractor and not the Railway endpoint.
- **Positive class:** "catch a FALSE claim" (label FALSE). Two scorings reported:
  - **flag/veto = positive** (headline; matches the canary harness convention, comparable to the on-record numbers).
  - **veto-only = positive** (production-relevant — only a `vetoed` decision penalizes RepID): **F1 0.869 [0.828, 0.905]**, precision 0.802, recall 0.947.
- **Providers actually live on the free tier (2026-07-09 key audit):** groq (`llama-3.1-8b-instant`), deepinfra (`Meta-Llama-3.1-8B-Instruct`), cerebras (`zai-glm-4.7`), openrouter (`qwen-2.5-72b`), siliconflow (`Qwen2.5-7B`), mistral (`mistral-small-latest`), deepseek (`deepseek-chat`).
  - **Finding (independence is thinner than marketed even before analysis):** SambaNova (HTTP 402, no balance), Together (402, credit limit), Fireworks (suspended), and **both** Gemini keys (429, credits depleted) were **dead**. Of the "6 marketed families," several are paywalled off the free tier at any given moment — the live quorum is whatever survives, not a fixed 6.
- **Runtime:** 337 claims × up to 7 providers = 2,359 provider calls in 1,702 s; provider error rate **13.2%** (rate-limit/timeouts recorded as ERROR, never fabricated).

## 2. Corpus expansion — the answer to "why such a small corpus?"

`eval/rigorous/rigorous-corpus-v1.jsonl` — **337 rows, every one provenanced.** Built deterministically (seed 42) by `scripts/eval/build-rigorous-corpus.py`:

| source | rows | how a claim is formed | provenance |
|---|---|---|---|
| **FEVER** (dev) | 100 | claim verbatim; SUPPORTS→TRUE, REFUTES→FALSE | `fever-<id>` + fever.ai |
| **HaluEval** (QA) | 100 | `Q: … A: …`; right→TRUE, hallucinated→FALSE | `halueval-qa-<idx>-<right/hallu>` + GitHub |
| **TruthfulQA** | 90 | `Q: … A: …`; Best Answer→TRUE, Best Incorrect→FALSE | `truthfulqa-<idx>-<t/f>` + row Source URL |
| **canary v1.1** (in-repo) | 47 | claim verbatim | `canary-v1.1-<idx>` + Wikipedia URLs |

Balance: **173 TRUE / 164 FALSE.** De-duplicated by claim text. **SimpleQA was deliberately excluded from the scored set** — it ships only correct answers with no gold distractors, so a balanced FALSE side can't be built from it without fabrication; it is available-but-unscored to stay honest. **No SYNTHETIC bucket** was needed — all headline rows are from established public benchmarks + the provenanced canary.

> Raw benchmark files (~13 MB) are **not committed**; the builder re-downloads them (URLs + a `--data-dir` flag documented in the script header) and reproduces the exact 337-row sample from the fixed seed.

## 3. Headline metrics (N=337, bootstrap 95% CI, B=10,000)

**Scoring = flag/veto positive:**

| metric | value | 95% CI |
|---|---|---|
| F1 | **0.795** | [0.747, 0.837] |
| precision | 0.683 | [0.622, 0.742] |
| **recall** | **0.951** | [0.915, 0.981] |
| accuracy | 0.760 | — |
| **AUC** | **0.899** | [0.864, 0.932] |

Confusion: TP=155 FP=72 TN=99 FN=8 abstain=3. The signature is **high recall, moderate precision** — the quorum rarely misses a FALSE claim (8 FN) but over-flags TRUE ones (72 FP). **Veto-only** (only full vetoes penalize) tightens this to P 0.80 / R 0.95 / **F1 0.869**.

**Calibration is good:** ECE = **0.056**. Reliability bins track truth (score-bin 0.9 → observed FALSE-rate 0.92; score-bin 0.0 → 0.07). The derived `hal_score` is a usable probability, not just a threshold flag.

**By source / difficulty** (recall held ~0.90–1.00 throughout; precision is where it varies):

| slice | F1 | precision | recall |
|---|---|---|---|
| canary (easy, in-repo) | 0.905 | 0.826 | 1.000 |
| FEVER | 0.867 | 0.778 | 0.980 |
| TruthfulQA (adversarial) | 0.782 | 0.662 | 0.956 |
| HaluEval (hardest — most FPs) | 0.704 | 0.579 | 0.898 |

## 4. Explaining the 0.34 (record) vs 0.95 (canary) gap — with a real measurement

Both prior numbers were real but measured **different things**:

- **F1 ≈ 0.34 / recall ≈ 22% (on record)** came from the **deterministic-extractor** / degraded path (the live prod HAL running with 0 real LLM calls, per STATE_OF_THE_SYSTEM). That path genuinely cannot discriminate truth — it is not the quorum.
- **0.95 (canary)** was F1 on **47 easy, curated** known-answer claims.
- **This run (0.795 F1 / 0.951 recall / N=337)** is the honest middle: the **real** cross-LLM quorum, on a **7×-larger, adversarial-inclusive, provenanced** corpus. The quorum's true strength is **recall** (95%); its weakness is **precision** (0.68 — it over-flags). The record's "0.34" is a property of the *broken deterministic path*, not of the multi-family quorum.

## 5. Ablations — does the quorum actually beat the best single model?

**Best single model is a coverage mirage:** `cerebras` shows F1 0.976 / recall 1.000 — but it **abstained/errored on 291 of 337 claims** (decided only 46). A 97.6% on the easy 14% it chose to answer is not comparable. Honest single-model ranking must show coverage:

| provider | family | F1 | precision | recall | **decided / abstain** |
|---|---|---|---|---|---|
| cerebras | glm | 0.976 | 0.952 | 1.000 | **46 / 291** ⚠ self-selected |
| deepseek | deepseek | **0.862** | 0.912 | 0.817 | **319 / 18** ← best full-coverage |
| openrouter | qwen | 0.857 | 0.907 | 0.812 | 216 / 121 ⚠ |
| mistral | mistral | 0.802 | 0.770 | 0.838 | 330 / 7 |
| deepinfra | llama | 0.780 | 0.765 | 0.795 | 317 / 20 |
| groq | llama | 0.758 | 0.779 | 0.739 | 313 / 24 |
| siliconflow | qwen | 0.701 | 0.562 | 0.932 | 96 / 241 ⚠ |

**Fair head-to-head on the same 319 claims** (where DeepSeek committed):
- **DeepSeek alone:** P 0.912 · R 0.817 · **F1 0.862**
- **Family quorum (≥2 FALSE families):** P 0.810 · R 0.889 · **F1 0.847**

**The single best full-coverage model edges the quorum on F1.** The quorum trades precision for **higher recall** and, crucially, **does not depend on any one vendor's uptime or honesty** — that resilience is its real value proposition, **not** a headline accuracy gain. On this corpus the "quorum beats the best model" claim is **not supported by the numbers.**

**k-family ablation (mean F1 over random family subsets):** k=1 → 0.843, **k=2 → 0.525**, k=3 → 0.769, k=4 → 0.822, k=5 → 0.835. Adding families is **non-monotonic**: a fixed "≥2 FALSE families" rule with only 2 families demands unanimity → recall collapses (0.42). More families ≠ automatically better; the **decision threshold must scale with the family count**, or the quorum underperforms a single model.

## 6. THE THESIS EXPERIMENT — are the "independent families" actually independent?

Method: per provider, a prediction vector (FALSE-verdict = "caught") over the claims it committed; **error vector** = disagreement with ground truth. Pairwise **error-correlation (φ)** and **Cohen's κ** on shared claims; **Fleiss' κ** overall.

**The smoking gun — identical weights, two "providers":**

| pair | families | φ (error-corr) | Cohen κ |
|---|---|---|---|
| **groq \| deepinfra** (both Llama-3.1-8B-Instruct) | llama \| llama | **0.881** | **0.917** |
| openrouter \| deepseek | qwen \| deepseek | 0.577 | 0.814 |
| cerebras \| mistral | glm \| mistral | 0.564 | 0.912 |
| … (18 distinct-family pairs, range) | — | −0.04 … 0.58 | 0.22 … 0.95 |
| openrouter \| siliconflow (Qwen **72B vs 7B**) | qwen \| qwen | **−0.004** | 0.216 |

| contrast | mean error-corr | mean Cohen κ | n pairs |
|---|---|---|---|
| **intra-family** (same lineage) | 0.438 | 0.566 | 2 |
| **inter-family** (distinct) | 0.348 | 0.622 | 18 |

**Verdict (plainly):**

1. **Two hosts of the same weights are NOT two votes.** Groq and DeepInfra both serve Llama-3.1-8B-Instruct; their errors correlate **0.881** and they agree **κ=0.917**. Counting them as independent quorum members is **fake diversity** — if one hallucinates on a claim, the other almost certainly does too. Any quorum that lists Groq + Together + SambaNova + DeepInfra as "4 providers" is really **~1 Llama vote**.

2. **"Same family" ≠ "same weights."** The other same-lineage pair — Qwen-72B (OpenRouter) vs Qwen-7B (SiliconFlow) — is essentially **uncorrelated** (φ ≈ 0). Error correlation tracks **shared weights**, not shared brand. The right deduplication key is the *model checkpoint*, not the vendor and not even the family name.

3. **Even genuinely distinct families share blind spots.** Distinct-family error-correlation averages **0.348** (well above 0) and κ **0.62** (substantial agreement) — they are trained on overlapping web data and fail together on the same hard/adversarial claims. The independence the "6 families" story implies is **partial, not clean orthogonality.**

4. **But diversity is not zero.** Distinct families (0.35) are meaningfully *less* correlated than identical weights (0.88). A quorum that **deduplicates by weight/checkpoint** and counts distinct architectures does buy *some* real error-decorrelation — which is exactly why the family-aware quorum (de-duping Groq+DeepInfra to one "llama" vote) is the right design. The current risk: `src/hal/fact-check.ts` **regex-guesses** the family for models missing from the registry (the run logged `hal_family_unmapped` for the Llama/Qwen hosts), so the dedup is only as trustworthy as the family registry — an unmapped compound model could still slip in as a fake extra vote.

## 7. Threats to validity / honest limitations

- **Fleiss' κ = 0.459 is on only 8 claims** where all 7 providers committed (rate-limiting meant full 7-way coverage was rare). Treat it as directional; the **pairwise** κ/φ (hundreds of shared claims per pair) are the load-bearing thesis evidence.
- **Provider error rate 13.2%** (cerebras/siliconflow throttled heavily). This *reduces* per-pair overlap and, if anything, **understates** correlation (fewer shared hard claims). It also makes single-model coverage wildly uneven (cerebras decided 46, mistral 330).
- **Only 2 identical-weight pairs** were testable live (the Llama pair is the clean one; the Qwen pair was different sizes). SambaNova/Together being paywalled cost the cleanest additional same-weight Llama replicates — the 0.881 rests on one pair, strong but n=1 of its kind.
- **QA→statement construction** (HaluEval/TruthfulQA) folds the question as context; a different phrasing could shift precision. FEVER + canary (verbatim claims) are unaffected and agree with the trend.
- **Not a Monte-Carlo over sampling temperature** end-to-end: providers ran at temperature 0 (deterministic), so the CIs are **bootstrap over claims** (the dominant uncertainty at this N), plus the k-family subset spread. Re-running at temperature > 0 for output-variance distributions is the documented next step.

## 8. How to reproduce / scale

```bash
# 1. corpus (re-downloads FEVER/HaluEval/TruthfulQA; deterministic seed):
python scripts/eval/build-rigorous-corpus.py --data-dir <raw-benchmark-dir> \
       --out eval/rigorous/rigorous-corpus-v1.jsonl
# 2. run the REAL quorum (keys from ../.env.master); RIG_LIMIT to sample:
RIG_OUT=reports/2026-07-09/rigorous-raw.json npx ts-node scripts/eval/rigorous-hal-eval.ts
# 3. all statistics (bootstrap CI, ablations, correlation, kappa, ECE):
python scripts/eval/rigorous-analysis.py --raw reports/2026-07-09/rigorous-raw.json \
       --out reports/2026-07-09/rigorous-analysis.json
```
**To scale past 337:** raise the per-source caps in the builder (FEVER alone has 6,666 REFUTES + 6,666 SUPPORTS; HaluEval ~10k) and fund/rotate providers so ≥4 families stay live under burst (the current ceiling is free-tier rate limits, not corpus supply). Add temperature>0 repeats for output-variance Monte-Carlo.

## 9. Artifacts (this branch)

- `scripts/eval/build-rigorous-corpus.py` — provenanced corpus builder
- `scripts/eval/rigorous-hal-eval.ts` — real-quorum runner (reuses `factCheck()`)
- `scripts/eval/rigorous-analysis.py` — bootstrap CI / ablation / correlation / kappa / ECE
- `eval/rigorous/rigorous-corpus-v1.jsonl` — 337 provenanced claims
- `reports/2026-07-09/rigorous-raw.json` — per-provider, per-claim raw verdicts (full audit)
- `reports/2026-07-09/rigorous-analysis.json` — all computed statistics
- `reports/2026-07-09/HAL_RIGOROUS_EVAL.md` — this report

---
*Real providers, real labels, real numbers. The quorum's honest value is recall + vendor-independence, not a headline accuracy win; and "6 providers" overstates independence — same-weight hosts share blind spots almost completely, and even distinct families are only partially independent. Micah 6:8 — trust, but verify.*
