# P-014 — ANFIS-Ikigai Attention Scoring: Reduction to Practice

**Status:** v0 prototype, single-user dogfood. Code merged on branch
`feat/anfis-ikigai-scorer-v0` (repository `repid-engine`).
**Date of first working build:** 2026-04-26.
**Inventor of record:** Sean Doolittle.
**Audience:** patent counsel preparing the P-014 disclosure.

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

## 4. Concrete embodiment

| File | Role |
|---|---|
| `supabase/migrations/20260426_anfis_ikigai_v0.sql` | Six-table schema (ikigai_profiles, attention_signals, anfis_score_events, anfis_rule_base, user_feedback_events, lasso_feature_weights). |
| `supabase/migrations/20260426_anfis_ikigai_seed.sql` | Seeds the v0 rule base (R1-R7) and Sean's first dogfood profile. |
| `src/services/anfis-ikigai-mfs.ts` | Triangular / shouldered-triangular membership functions. |
| `src/services/anfis-ikigai-rules.ts` | Sugeno rule base, including the patent-relevant R6. |
| `src/services/anfis-lasso-pruner.ts` | Feature pruning with LASSO-inspired heuristic. |
| `src/services/anfis-anticipatory.ts` | Per-signal score-trajectory metric. |
| `src/services/anfis-ikigai-scorer.ts` | End-to-end `scoreSignal()` entry point with audit persistence. |
| `src/routes/v1.ts` | Six HTTP endpoints (`/api/v1/anfis/score`, `/score-batch`, `/profile`, `/feedback`, `/digest/:user_id`, `/rule-trace/:id`). |
| `tests/anfis-ikigai-scorer.test.ts` | 18 unit tests + 20-signal validation suite. |

## 5. Test results — anti-engagement filter validation

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
