# ANFIS LASSO Signal Selection — canary corpus (measurement, not cutover)

Generated: 2026-07-08T16:34:32.901Z
Source raw results: `reports\2026-07-07\canary-f1-raw-2026-07-08T02-17-06-804Z.json` (generated_at 2026-07-08T02:17:06.804Z)

## What this is
L1-penalized logistic regression (hand-rolled coordinate descent, no ML deps) over per-(claim,provider)
verdicts from the labeled canary corpus. Target = did the provider get the claim RIGHT. The sparse
coefficients tell us **which signals actually predict a correct verdict** — i.e. which ANFIS inputs
deserve weight. This is a **directional prior**, not a trained model, and it is **not wired into live
routing**. `ROUTER_STRICT_COST_ORDER` stays true (static cost-order in control).

## Dataset
- Claims: 50 · verdict rows (training examples): **300**
- Positive class (correct verdicts): 150 (50.0%)
- Corpus F1 (context, from raw): 0.9302 · accuracy 0.94
- Verdicts per provider: groq=50, cerebras=50, deepseek=50, gemini=50, mistral=50, openrouter=50

## Ranked signals (reported lambda = 0.02)
Coefficients are on **standardized** features, so |coef| is comparable across signals.
A positive coefficient = the signal makes a correct verdict MORE likely; negative = less likely.

| rank | signal | coef (std) | selected | direction |
|---|---|---|---|---|
| 1 | `confidence` | 2.8833 | YES | positive |
| 2 | `prov_deepseek` | 0.1923 | YES | positive |
| 3 | `latency_ms` | -0.1391 | YES | negative |
| 4 | `difficulty` | -0.0957 | YES | negative |
| 5 | `is_error` | -0.0578 | YES | negative |
| 6 | `category` | 0.0000 | no (→0) | positive |
| 7 | `prov_groq` | 0.0000 | no (→0) | positive |
| 8 | `prov_cerebras` | 0.0000 | no (→0) | positive |
| 9 | `prov_gemini` | 0.0000 | no (→0) | positive |
| 10 | `prov_mistral` | 0.0000 | no (→0) | positive |
| 11 | `prov_openrouter` | 0.0000 | no (→0) | positive |

## Suggested ANFIS input-weight prior (selected signals, |coef| normalized to sum 1)
These are a **prior** for the ANFIS input importances — a starting point to measure against, not
final weights. Sign tells you the direction the signal pushes provider-correctness.

| signal | suggested weight | direction |
|---|---|---|
| `confidence` | 0.856 | + |
| `prov_deepseek` | 0.057 | + |
| `latency_ms` | 0.041 | - |
| `difficulty` | 0.028 | - |
| `is_error` | 0.017 | - |

## Lambda path (sparsity vs lambda)
| lambda | # non-zero signals |
|---|---|
| 0.2 | 1 |
| 0.1 | 1 |
| 0.05 | 1 |
| 0.02 | 5 |
| 0.01 | 6 |
| 0.005 | 6 |

## Coefficient path (entry order = importance order)
Standardized coefficient of each signal at each lambda (strong→weak penalty). The lambda at which
a signal first becomes non-zero tells you how strongly the data supports it — earlier = stronger.

| signal | λ=0.2 | λ=0.1 | λ=0.05 | λ=0.02 | λ=0.01 | λ=0.005 |
|---|---|---|---|---|---|---|
| `confidence` | 1.160 | 1.876 | 2.499 | 2.883 | 2.943 | 3.022 |
| `is_error` | · | · | · | -0.058 | -0.500 | -0.782 |
| `latency_ms` | · | · | · | -0.139 | -0.079 | -0.027 |
| `difficulty` | · | · | · | -0.096 | -0.300 | -0.426 |
| `category` | · | · | · | · | · | · |
| `prov_groq` | · | · | · | · | · | · |
| `prov_cerebras` | · | · | · | · | -0.129 | -0.237 |
| `prov_deepseek` | · | · | · | 0.192 | 0.337 | 0.455 |
| `prov_gemini` | · | · | · | · | · | · |
| `prov_mistral` | · | · | · | · | · | · |
| `prov_openrouter` | · | · | · | · | · | · |

## Honesty note on trusting these weights
- **Small N (300 verdict rows over 50 claims).** This is enough to see *directional*
  signal (which inputs matter, and their sign) but NOT enough to trust exact magnitudes or to justify a
  routing cutover. Treat as a weight PRIOR for the ANFIS inputs.
- Confidence is provider **self-reported** (calibration, not ground truth) — high weight on it should be
  read with that caveat.
- The canary corpus skews easy/factual; hard-domain behavior is under-sampled. Re-run as the corpus and
  the shadow log (`anfis_routing_logs`, now persisted per PR step 1) grow, then re-measure before any cutover.
