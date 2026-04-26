# P-014 — ANFIS-Ikigai Attention Scoring: Reduction to Practice

**Status:** v0 prototype shipped on `feat/anfis-ikigai-scorer-v0`; v0.1
extension shipped on `feat/anfis-ikigai-v0.1-adversarial-harmonic`. Both
branches in repository `repid-engine`.
**Dates of first working builds:** v0 — 2026-04-26 morning. v0.1 — 2026-04-26 afternoon.
**Inventor of record:** Sean Doolittle.
**Audience:** patent counsel preparing the P-014 disclosure.

This document covers both v0 and v0.1; sections marked **v0.1** are the
new claims layered on top of the v0 baseline. The combination is the
novelty argument.

---

## 1. Problem statement

State-of-the-art recommender systems (e.g. those backing YouTube, X/Twitter,
TikTok, Netflix, Meta feed ranking) optimise a reward function dominated by
proxies for *engagement*: predicted watch time, click-through, like
probability, retention. These reward functions are agnostic to whether the
surfaced content advances the user's *declared purpose*. In aggregate, the
documented effect is attention drift toward emotionally activating but
ultimately unrewarding content (the "engagement economy").

The need is for an attention-routing primitive whose reward function is
explicitly grounded in the user's declared purpose, can suppress
high-engagement / low-purpose content even when the user shows behavioural
interest in it, and produces decisions that are auditable and explainable
post hoc.

## 2. Solution architecture

The ANFIS-Ikigai scorer maps an attention candidate (a "signal") and the
user's four-dimension *ikigai profile* (love / good_at / world_needs /
paid_for) into a 0-1 *composite alignment score* through a Sugeno-style
fuzzy inference network with LASSO-inspired feature selection and
anticipatory trend metrics. Every score event emits a structured rule
trace that records which fuzzy rules fired, with what strength, on what
evidence.

Pipeline (v0):

1. **Feature extraction.** Lowercased substring overlap of profile
   keywords against the candidate signal content. v1 candidate: dense
   embedding similarity, cosine per dimension.
2. **LASSO-inspired pruning.** Per-feature weights stored in
   `lasso_feature_weights`; v0 defaults to weight 1.0 (uninformative
   prior), v1 will train weights from `user_feedback_events` via L1
   regression.
3. **Per-dimension raw alignment** (`anfis-ikigai-scorer.ts::normaliseDim`)
   maps hit count to a saturating value: 0 hits → 0, 1 hit → 0.5, 2+ hits
   → 1.0. Independent of dimension keyword set size by design.
4. **Fuzzification** (`anfis-ikigai-mfs.ts`) — three triangular fuzzy
   sets per dimension (low / medium / high). Boundary sets (low and
   high) use shoulder semantics so natural extremes saturate.
5. **Rule firing** (`anfis-ikigai-rules.ts`) — the seven seed rules
   (R1-R7) are applied with the standard Sugeno/Mamdani min-T-norm.
6. **Defuzzification** — firing-strength-weighted average of rule
   consequents.
7. **Anticipatory delta** (`anfis-anticipatory.ts`) — current composite
   compared against the mean of the prior N=10 score events for the same
   signal, classifying the trajectory as `rising`, `stable`, or `falling`.
8. **Audit persistence** — each evaluation appends a row to
   `anfis_score_events` containing the full `rule_trace` payload.

## 3. Novelty axes

The combination of the following four properties does not appear in the
prior art known to the inventor:

### 3.1 Ikigai-encoded fuzzy membership functions

Membership functions for the fuzzy sets {low, medium, high} are defined
on a four-dimensional input space whose axes correspond directly to the
ikigai dimensions (love, good_at, world_needs, paid_for). This binds the
geometry of the fuzzy partition to a declared-purpose framework rather
than to engagement features (dwell, recency, popularity).

### 3.2 Anti-engagement-economy reward differentiation (Rule 6)

Rule R6 — `IF love=high AND good_at=low AND world_needs=low THEN
composite_score = 0.20` — is a fixed *suppressor* rule. It fires
specifically when a candidate is emotionally engaging to the user (high
love-membership) but not productive (good_at=low) and not impactful
(world_needs=low). In the validation suite (Section 5), this rule
correctly suppresses 5/5 trap signals to a composite of 0.20, well below
the surfacing threshold of 0.6, while permitting genuine high-alignment
signals to score 0.725-0.80. Rule 6 is the principal differentiator from
engagement-maximising recommenders, which lack any rule whose firing
decreases score on engagement evidence.

### 3.3 Anticipatory metrics on the score trajectory

The per-signal `anticipatory_delta` reports whether a signal's composite
score is *rising*, *stable*, or *falling* relative to the running mean of
its prior scores. This is structurally distinct from a current-score
threshold: it allows the system to surface candidates whose absolute
alignment is moderate but whose alignment is *increasing* over time
(e.g., as the user's profile refines or as keyword coverage broadens).
Existing recommender systems generally compute features over the user's
behavioural history, not over the score's *own* history.

### 3.4 LASSO feature pruning grounded in declared-purpose dimensions

The feature pruner attenuates features by per-feature weights stored
against an explicit (profile_id, feature_name) pair. Pruning is therefore
grounded in *which user* and *which dimension* the feature targets, not
in cross-user collaborative-filter weights. v1 will train these weights
from labelled feedback (`user_feedback_events`) via L1 regression; the v0
contract surface (uniform weight, threshold-based pruning) is functional
embodiment of the architectural claim.

### 3.5 Circle-of-Fifths harmonic alignment with shared dissonance amplifier (v0.1)

The four ikigai dimensions are arranged on a circle in the canonical
order `love → good_at → world_needs → paid_for → love`. Adjacent
dimensions are "perfect fifths apart" in the musical analogue. For each
adjacent pair the engine computes

    pair_distance = | scoreA - scoreB | / max(scoreA, scoreB, ε)

and aggregates the four pair distances into a 0-1 *resonance score*. A
signal whose four-dimension scores are tightly clustered exhibits high
resonance; a signal that scores high on one dimension and low on its
neighbour exhibits dissonance.

When ANY adjacent distance exceeds the configured dissonance threshold
(default `0.0136`, equal to the Pythagorean Comma minus one), the
engine emits a `composite_multiplier` equal to the **Pythagorean
Comma**: `531441 / 524288 ≈ 1.0136433`. This is the **same constant**
HAL v1 uses to amplify hallucination scores. The reuse is not
incidental — it is the architectural claim. A single mathematical
primitive (a deliberately tiny musical dissonance constant) is the
shared amplifier for two distinct decision surfaces:

| Layer | Dissonance event | Effect |
|---|---|---|
| HAL v1 | claim diverges from evidence | composite × 1.0136433 |
| ANFIS-Ikigai v0.1 | adjacent dimensions diverge | composite × 1.0136433 |

The combination — a four-dimensional declared-purpose Circle of Fifths
amplified by the same Pythagorean Comma already deployed for
hallucination detection — is novel.

Concrete embodiment: `src/services/anfis-circle-of-fifths.ts`,
`anfis_harmonic_alignment` table, `anfis_circle_of_fifths_config`
singleton. Validation: `tests/anfis-ikigai-v01.test.ts` confirms 5/5
balanced "resonance" signals raise no dissonance flag and 5/5 skewed
"dissonance" signals do.

### 3.6 SBFA multi-perspective scoring (v0.1)

For every score event in `mode='v0.1-full'`, the engine dispatches
five parallel LLM calls to five different model families, each calling
under a different "perspective role":

1. **protagonist** — argues for surfacing
2. **antagonist** — argues against surfacing
3. **naive_user** — without any system context
4. **long_term_self** — six-months-out hindsight
5. **mission_aligned_peer** — peer who shares the user's mission

The five composite scores are aggregated via stddev to compute
`agreement_variance`; when `variance > 0.30`, the event is flagged
`high_disagreement=true`. Disagreement-as-signal feeds the federated
observation pipeline (§3.7).

Novelty axis: the perspective set is *orthogonal-by-construction*.
Roles are not "five copies of the same task" — they are five
purpose-rooted reframings. Different model families are assigned per
role so disagreement cannot be an artefact of shared model bias.

Concrete embodiment: `src/services/anfis-sbfa-perspectives.ts`,
`anfis_perspective_scores` table.

### 3.7 Structured antagonist evaluation with explicit veto math (v0.1)

The antagonist perspective from §3.6 is promoted to a first-class
structured evaluation with deterministic net-score math:

    net_score = v0_composite × (1 - 0.5 × antagonist_score)

The 0.5 coefficient bounds dampening — a maximum-strength antagonist
caps the reduction at half the v0 composite, never zeroing out a
strong v0 result. `veto_triggered=true` fires when
`antagonist_score > 0.70`.

Novelty axis: the explicit antagonist path is the *runtime* mirror of
the *static* anti-engagement Rule 6 (§3.2). Two layers of anti-
engagement enforcement: a fixed fuzzy rule that catches the pattern
at scoring time, and a model-based reasoner that catches it at
inference time when the static rule under-fits.

Concrete embodiment: `src/services/anfis-antagonist.ts`,
`anfis_antagonist_evaluations` table.

### 3.8 Federated observation capture with privacy-by-default (v0.1)

Four pattern types are captured locally for each scoring run:

- `rule_firing_distribution`        — rule_id → firing_strength map
- `antagonist_correction_rate`      — % of v0 scores adjusted by antagonist
- `harmonic_dissonance_correlation` — per-event resonance + dissonance flag
- `feature_weight_drift`            — SHA1-hashed feature names + LASSO weights

All rows are written with `share_consent=FALSE`. Outbound federation
is a v1 feature; v0.1 establishes the schema and the privacy
invariants (see `docs/ANFIS-FEDERATED-LEARNING-V0-PREP.md`).

Novelty axis: federated learning of attention-routing patterns
grounded in declared purpose, with the aggregations performed on
patterns that are provably non-reversible to source data. The
combination — purpose-grounded ANFIS + federated pattern aggregation
+ on-by-default privacy hardening — is the architectural claim. The
v0.1 schema embodies it; v1 demonstrates it across users.

Concrete embodiment: `src/services/anfis-federated-prep.ts`,
`anfis_federated_observations` table.

## 4. Concrete embodiment

### 4.1 v0 files

| File | Role |
|---|---|
| `supabase/migrations/20260426_anfis_ikigai_v0.sql` | Six-table schema (ikigai_profiles, attention_signals, anfis_score_events, anfis_rule_base, user_feedback_events, lasso_feature_weights). |
| `supabase/migrations/20260426_anfis_ikigai_seed.sql` | Seeds the v0 rule base (R1-R7) and Sean's first dogfood profile. |
| `src/services/anfis-ikigai-mfs.ts` | Triangular / shouldered-triangular membership functions. |
| `src/services/anfis-ikigai-rules.ts` | Sugeno rule base, including the patent-relevant R6. |
| `src/services/anfis-lasso-pruner.ts` | Feature pruning with LASSO-inspired heuristic. |
| `src/services/anfis-anticipatory.ts` | Per-signal score-trajectory metric. |
| `src/services/anfis-ikigai-scorer.ts` | End-to-end `scoreSignal()` entry point with audit persistence. |
| `src/routes/v1.ts` | Six v0 HTTP endpoints. |
| `tests/anfis-ikigai-scorer.test.ts` | 18 unit tests + 20-signal validation suite. |

### 4.2 v0.1 files

| File | Role |
|---|---|
| `supabase/migrations/20260426_anfis_ikigai_v01.sql` | Five new tables (anfis_perspective_scores, anfis_harmonic_alignment, anfis_antagonist_evaluations, anfis_federated_observations, anfis_circle_of_fifths_config) + COF config seed. |
| `src/services/anfis-circle-of-fifths.ts` | Harmonic alignment with Pythagorean Comma multiplier. |
| `src/services/anfis-llm-providers.ts` | Local LLM adapter mirroring `hal-providers.ts` callModel signature, since hal-providers.ts has not yet merged to main. |
| `src/services/anfis-sbfa-perspectives.ts` | 5-role multi-LLM scorer with mock fallback. |
| `src/services/anfis-antagonist.ts` | Structured antagonist with explicit veto math. |
| `src/services/anfis-federated-prep.ts` | Four pattern-capture functions writing to anfis_federated_observations. |
| `src/services/anfis-ikigai-scorer.ts` (modified) | Adds `mode` parameter and v0.1 enrichment orchestration. |
| `src/routes/v1.ts` (modified) | Five new v0.1 endpoints. |
| `tests/anfis-ikigai-v01.test.ts` | 17 unit + suite tests, 30-signal validation. |
| `docs/ANFIS-IKIGAI.md` | Consolidated v0+v0.1 architecture. |
| `docs/ANFIS-FEDERATED-LEARNING-V0-PREP.md` | Privacy threat model. |

## 5. Test results — anti-engagement filter validation

### 5.1 v0 results

Run on 2026-04-26 against Sean's seed ikigai profile (see
`supabase/migrations/20260426_anfis_ikigai_seed.sql`).

| category | n | mean composite | min | max |
|----|---|---------------:|----:|----:|
| high  | 5 | 0.7650 | 0.7250 | 0.8000 |
| medium | 5 | 0.0000 | 0.0000 | 0.0000 |
| low   | 5 | 0.0000 | 0.0000 | 0.0000 |
| trap  | 5 | 0.2000 | 0.2000 | 0.2000 |

- **High-vs-trap mean separation: 0.5650** (acceptance criterion: > 0.15).
- **Trap maximum composite: 0.2000** (acceptance criterion: < 0.50).
- **p95 latency: 13ms** on commodity hardware (budget: < 50ms).
- **Rule R6 fires on 5/5 trap signals** with full firing strength.

### 5.2 v0.1 results — harmonic + antagonist + SBFA

Same profile, 30 signals (20 v0 + 5 resonance + 5 dissonance), mock LLM
mode (`HAL_V2_MOCK=1`).

| category | n | mean v0 | mean net | mean resonance | dissonance % | veto % | mean SBFA σ |
|---|---|---:|---:|---:|---:|---:|---:|
| high       | 5 | 0.7650 | 0.6127 | 0.6500 | 100% |  0% | 0.158 |
| medium     | 5 | 0.0000 | 0.0000 | 0.5000 |  80% |  0% | 0.156 |
| low        | 5 | 0.0000 | 0.0000 | 1.0000 |   0% |  0% | 0.119 |
| trap       | 5 | 0.2000 | 0.1372 | 0.5000 | 100% | 20% | 0.150 |
| resonance  | 5 | 0.7833 | 0.5670 | 1.0000 |   0% | 20% | 0.145 |
| dissonance | 5 | 0.0800 | 0.0659 | 0.5000 | 100% |  0% | 0.154 |

- **5/5 resonance signals raise no dissonance flag** (composite_multiplier = 1.0).
- **5/5 dissonance signals raise dissonance_flag = true** with composite_multiplier = 1.0136433 (Pythagorean Comma).
- **v0.1-fast p95 latency: 0ms** (no LLM calls).
- **v0.1-full mock p95 latency: 2ms** (5 parallel mock calls; budget < 5000ms).
- **v0 backwards compatibility:** every v0 test still passes with mode='v0'.
- **35/35 tests pass across both suites.**

The veto fires occasionally on traps and resonance signals in mock mode
because the mock antagonist score is derived from a deterministic prompt
hash, not from the actual signal-purpose alignment. In real-LLM mode the
antagonist is expected to systematically score traps higher than
resonance signals; the v0.1 mock mode is a contract-validation tool, not
a benchmark of the antagonist's discriminative power.

Per-signal detail and the JSON record are persisted at
`tests/anfis-ikigai-scorer-results.md` and
`tests/anfis-ikigai-scorer-results.json`. The full rule_trace for any
score event can be retrieved at `GET /api/v1/anfis/rule-trace/:id`.

## 6. Distinguishing prior art

- **Engagement-maximising recommenders** (YouTube, TikTok, Meta feed,
  Netflix) optimise watch time, retention, and CTR. None publishes a
  reward function with a fixed suppressor rule that *decreases* score on
  high-engagement evidence when productive evidence is absent.
- **Existing ANFIS patents** (e.g. Jang 1993 and successors) describe
  ANFIS as a general fuzzy-neural framework for control, prediction, and
  uncertainty handling. They do not anchor the membership-function
  geometry or the rule base to a declared-purpose ontology like ikigai.
- **Existing ikigai coaching tools** (paper journals, web apps such as
  ikigai.com) collect declared-purpose data but do not operate it as the
  reward signal of a fuzzy inference network for attention routing.
- **LASSO regression** is well known for feature selection. Its
  grounding here in *per-profile, per-dimension* feature weights tied to
  ikigai axes is the novel composition.

The novelty claim is therefore the *combination* — ANFIS-LASSO with
ikigai-grounded reward, anti-engagement suppressor rule, and anticipatory
score-trajectory metric, all emitting a structured per-event audit trace.

## 7. Limitations of the v0 embodiment

For full disclosure to counsel:

- Feature extraction is keyword-only. v1 will replace with embeddings;
  the architectural claim does not depend on keyword vs embedding.
- Membership-function parameters are fixed at v0 defaults. v1 will train
  them from feedback events (PPO-ANFIS pattern). The shoulder-triangular
  shape is a deliberate boundary-saturation fix.
- The LASSO pruner uses a uniform 1.0 prior. v1 will train weights via
  proper L1 regression once `user_feedback_events` accumulates ≥ ~50
  labelled samples per profile.
- Single-user (Sean). No multi-tenancy, no isolation. Foundational
  primitive only — productisation is downstream.
- No voice-first interface. The scorer is the primitive that future
  voice-first PurposeHub.ai surfaces will consume.

These limitations are scoped to the v0 implementation; none of them
constrain the patent claims, which are over the architectural
combination, not the specific v0 parameter choices.
