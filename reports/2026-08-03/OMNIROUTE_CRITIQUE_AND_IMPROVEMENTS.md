# OmniRoute plan — what I'd change, measured against the live system

**Date:** 2026-08-03 · **Author:** CC
**Reviewing:** the Grok integration plan (execution fabric under the trust layer) + its three artifacts.

The core architecture is right and I wouldn't change it: **compose, don't compete**; OmniRoute owns
"which model right now", HyperDAG owns "should this call happen and did the answer hold up." The
"what to avoid" list is also correct, particularly not making OmniRoute a source of truth for
reputation.

Six things I'd change. Every one is grounded in a number I pulled from prod today, and two of them
would have produced wrong behaviour silently.

---

## 1. The headline benefit is already won — so the plan optimises the wrong axis

Grok leads with free-tier stacking and 15–95 % token savings.

**Measured, last 30 days:**

| | |
|---|---|
| LLM calls | **164,522** |
| total spend | **$2.44** |
| distinct providers already live | **12** |
| free-tier calls | 63 % |

A 50 % token saving on $2.44/month is **$1.22**. Cost is not the problem and hasn't been for a while.

Worse, the plan's framing hides where the money actually goes:

| provider | calls | 30-day cost |
|---|---|---|
| groq | 40,570 | $0.31 |
| mistral | 29,523 | **$0.00** |
| **cerebras** | 26,572 | **$1.45 ← 59 % of all spend** |
| openrouter | 25,169 | **$0.00** |
| gemini | 25,037 | $0.36 |
| deepseek | 10,588 | $0.28 |

**One provider is 59 % of total spend at a fifth of the volume.** Routing away from cerebras for
non-critical work is a one-line policy change worth more than the entire gateway integration, and it
needs no new infrastructure.

**Change:** stop selling this on cost. Sell it on **resilience** — the real incident was
`HUGGINGFACE_API_TOKEN` being present-but-dead and taking the broker down. Quota-aware fallback fixes
that class of failure. Measure fallback-saves, not dollars.

---

## 2. "290 providers / 500 models" is the wrong metric for our use case

This is the most important correction.

HAL's veto quality depends on **independent error surfaces** — distinct model *families*, not distinct
API endpoints. 290 providers reselling the same dozen open-weight checkpoints gives one family
counted 290 times, and a quorum of 5 rehosted Llamas is a quorum of one.

We already know this and already built the tool that proves it:

- `#302` explicitly reports **"quorum WIDTH not key count."**
- `src/decisioning/family-registry.ts` **excluded a seed entry for matching >1 known family**
  (`hf/deepseek-r1-qwen-32b [deepseek/qwen]`) rather than counting it twice.

There are roughly 8–10 genuinely independent families in existence. We have 12 providers spanning
most of them already.

**Change:** before integrating, run OmniRoute's catalogue through `family-registry` and report
**families gained, not models gained.** My expectation is a small single-digit number. If it's 0–1,
the HAL case for this evaporates and only the resilience case survives — which is still worth doing,
but it's a different-sized project.

---

## 3. The ANFIS feature vector would have silently produced wrong inference

`AnfisFeatureVector` declares:

```ts
agent_repid_competence: number;   // 0–1 dual-band
agent_repid_integrity: number;    // 0–1 dual-band
```

The columns exist and are fully populated (104/104 active agents). **They are not 0–1:**

```
competence_score : 100 .. 1000
integrity_score  :  10 .. 2049
```

They aren't even on the *same* scale as each other. Feeding raw values into Gaussian membership
functions tuned for 0–1 doesn't throw — it saturates every rule and returns confident nonsense. This
is the failure mode that looks like a working router.

**Change:** the feature builder must normalise explicitly and the normaliser must be tested against
the live ranges, not assumed. Also `agent_repid_uncertainty` has **no source column at all** — it
needs to be derived (event count / recency), and until it is, it should be absent rather than
defaulted to a number that means nothing.

---

## 4. LASSO on this data is premature, and the implementation has a bug

**Premature:** `anfis_routing_logs` holds **294 rows** total. LASSO over 15 numeric features on
n≈294 — where the features are correlated and the outcome is imbalanced — will select noise. Grok's
"add the features even if weights start at zero" is right in spirit but the selector shouldn't run
yet; it should *collect* until there's a real sample.

**The bug:** the coefficients are de-standardised (`beta[j] / stds[j]`) but **the intercept is not
adjusted for the feature means.** Any prediction using the returned coefficients plus the returned
intercept is off by `Σ(beta_j · mean_j / std_j)`. It fits fine internally and is wrong the moment
anyone uses the output — which is the worst kind of numeric bug.

**Change:** either return the standardisation parameters alongside the model so callers can transform
inputs consistently, or adjust the intercept on de-standardisation. And gate the selector behind a
minimum-sample check that refuses rather than returning a confident sparse set from 294 rows.

---

## 5. Compression must be OFF on any HAL-scored or corpus path

Grok recommends defaulting continuous loops to the compression path. On a HAL path this is a
measurement-integrity failure:

- If the prompt is compressed, HAL scores an answer to a **different prompt than the one recorded**.
- The corpus/golden work depends on stable inputs. Variable compression silently changes the ruler —
  the exact sin behind "F1 = 0.34 / 0.74 / 0.886 / 0.890 are four rulers, not progress."

**Change:** compression allowed on non-scored work (drafting, summarising, internal loops). **Hard
off** for HAL evaluation, corpus runs, and anything whose output lands in a receipt. Enforce it in
code, not in a convention.

---

## 6. The dogfood plan would manufacture the reputation data we just cleaned up

This is the part I'd refuse as written.

> "Spin up dozens of synthetic agents that post jobs, bid, fulfill, and rate each other."

Measured today: of **104 "active" agents, 92 are ours** — 47 `trinity-mock-*`, 15 CC smoke tests,
18 April demo personas (including **five agents literally named `HUMAN`**), 4 smoke. **Zero external
registrations, ever.** `/stats` reporting "104 agents" is already misleading because of exactly this.

Synthetic agents rating each other into the same RepID ledger is not a stress test, it is
**reputation fabrication** — and `TRUSTMARKET_UX_MERGED_SPEC_v1 §13` lists sybil/collusion farming as
the **existential** open risk, noting none of the three prior design passes defended it.

**Change:** synthetic load is legitimate, but it must be **quarantined**:
- a `simulated` flag on every synthetic exchange, enforced at write time;
- synthetic events land in a shadow column or separate table, never the live RepID ledger;
- no synthetic agent appears in `/stats`, the manifest, the leaderboard, or a badge;
- the eventual public claim is "N real exchanges," and synthetic ones can never be counted in it.

We already have the machinery: `x402_settlements.is_simulated`, the shadow-mode pattern used for
decay and RRL, and `lifecycle_status='test_only'`. Use them.

---

## 7. The provenance problem nobody named

If OmniRoute chooses the model, then a receipt claiming *"verified across N independent families"*
depends on a **third party's self-reported provider identity**, routed by logic we don't control and
can't reproduce.

Everything shipped in the last two days — the service manifest, `/llms.txt`, the TrustBadge — rests
on "every claim links to its evidence." A receipt whose diversity claim traces to an opaque router's
response header is a weaker claim than the one we make today.

**Change:** treat the routing decision as **provenance, not telemetry**. Capture `chosenModel`,
provider, fallback reason, and compression ratio; run the provider through `family-registry` on *our*
side; and if the family can't be resolved, the receipt says **"family unverified"** rather than
counting it toward quorum width. Grok says capture the metadata — I'm saying the metadata is
load-bearing for a public claim, which raises the bar from "log it" to "verify it or don't claim it."

---

## What I'd actually do, in order

1. **Route away from cerebras for non-critical work.** One policy change, 59 % of spend, zero new
   infrastructure. Do this whether or not OmniRoute happens.
2. **Run OmniRoute's catalogue through `family-registry`** and report families gained. This decides
   how big the project is, and it's an afternoon.
3. **Stand up OmniRoute as a sidecar behind the existing broker** (`/api/v1/llm/complete`), not
   beside it. We already have one choke point that every agent can be pointed at — `ENGINE_LLM_PROXY`
   is on trinity-mel today. Putting OmniRoute *behind* the broker means the ANFIS instrumentation,
   the cost log, and the family resolution stay ours, and the fleet flip is a flag we already own.
4. **Fix the normaliser + the intercept bug**, then add the OmniRoute features to the vector with
   **collection only** — no LASSO until n is real.
5. **Compression off on scored paths**, enforced in code.
6. **Quarantined synthetic load** with `is_simulated` end to end.

The one thing I'd push back on hardest: **do not point agents at OmniRoute directly.** Grok's step 1
("point TrustShell agents and T12 agents at localhost:20128/v1") bypasses the broker we just spent
weeks making the single instrumented choke point. It would get free-tier stacking and lose the
ANFIS signal, the cost ledger, and the family provenance in the same move.

---

*Provider table, spend, dual-band ranges, `anfis_routing_logs` count and the agent-cohort breakdown
all read from prod 2026-08-03.*
