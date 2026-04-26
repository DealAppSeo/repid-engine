# ANFIS-Ikigai — Federated Learning Preparation (v0.1)

This document describes what `anfis-federated-prep.ts` captures, why it
captures it, what would be shared if outbound federation were enabled,
and what would never be shared. It exists so that when v1 wires up the
outbound channel, no one has to reconstruct the privacy decisions the
v0.1 schema bakes in.

**Sprint context:** v0.1 *prepares* federated learning. It does not
implement it. There is no network code in this codebase that exports
observations to other instances. `share_consent` is hard-coded to
`FALSE` on every row written.

---

## 1. The shape of federated learning we're aiming at

The PurposeHub vision is that many users run their own ANFIS-Ikigai
instances against their own ikigai profile and their own attention
signals. None of those users want to share their raw signal text, their
declared keywords, or their profile IDs — that is private. But the
*patterns* that emerge across users are useful collectively:

- Which fuzzy rules consistently fire vs. consistently sit silent.
- Whether the antagonist tends to correct v0 scores in particular
  directions.
- Whether harmonic dissonance correlates with later dismissal.
- How LASSO feature weights drift over time across users in similar
  profile clusters.

Federated learning, as the medical-AI literature uses the term, lets
those patterns aggregate without any raw row leaving the local
database. The local site computes a pattern and sends only the
pattern.

## 2. What `anfis_federated_observations` captures

| `pattern_type` | Captured by | Payload shape | Privacy property |
|---|---|---|---|
| `rule_firing_distribution`        | `captureRuleFiringDistribution()`      | `{ fired_with_strength: { rule_id: number }, silent_rules: [...] }` | Rule IDs are public; strengths are aggregate. |
| `antagonist_correction_rate`      | `captureAntagonistCorrectionRate()`    | `{ lookback_count, corrections, vetoes, correction_rate, dateRangeDays }` | Single percentage; can't be reversed to row contents. |
| `harmonic_dissonance_correlation` | `captureHarmonicDissonanceCorrelation()` | `{ resonance_score, dissonance_flag, pair_distances }` | Numeric four-tuple per event; no signal text. |
| `feature_weight_drift`            | `captureFeatureWeightDrift()`           | `{ weights_hashed: [{ feature_hash, weight }] }` | Feature names hashed (SHA1, truncated to 12 chars); one-way. |

`hash_of_inputs` on every row uses SHA-256 over the inputs that
generated the observation. Collisions are vanishingly rare and the
hash is **not** reversible to the source data — it exists for
deduplication, not for reconstruction.

## 3. What WOULD be shared once federation is enabled

Only the columns in the table above. Specifically:

- `pattern_type` (the bucket)
- `observation_payload` (already privacy-screened; see table)
- `created_at` (for time-bucketed aggregation)
- `hash_of_inputs` (only when needed for downstream dedup)

`profile_id` would be **stripped** at export time. Federated
aggregation runs on anonymous patterns only.

## 4. What we will NEVER share

- `attention_signals.content` — raw signal text.
- `ikigai_profiles.{love,good_at,world_needs,paid_for}_dimension` —
  the user's declared keywords.
- `user_id` or any direct identifier.
- `lasso_feature_weights.feature_name` — only the hash, never the
  cleartext keyword/feature string.
- Per-event rule traces — only aggregated firing distributions.

If a future contributor wants to extend federated capture to a new
pattern, the implementation review must verify that the payload
satisfies these "never share" rules.

## 5. Threat model

The threat model for v0.1 is *internal*:

1. **A future contributor adds a new federated observation that leaks
   raw text.** Mitigation: this document, plus the `pattern_type` enum
   that constrains downstream consumers to the four sanctioned
   buckets. New buckets require code review.
2. **A misconfigured share_consent flag exports private data.**
   Mitigation: `share_consent` defaults to `FALSE` at the schema level
   and is never set to `TRUE` by any code on this branch. Setting it
   requires explicit user action in v1.
3. **An attacker with read-only DB access reconstructs profile content
   from federated observations.** Mitigation: feature names are SHA1
   hashed; rule firing distributions only emit rule IDs; correction
   rates emit only percentages. Reconstruction would require breaking
   SHA1 preimage resistance, which is computationally infeasible.

The threat model that v0.1 does **not** cover, and that v1 must:

- Outbound network leaks once `share_consent=true` is allowed.
- Cross-user de-anonymisation if patterns cluster too tightly.
- Server-side adversarial poisoning of federated aggregates.

These are explicitly out of scope for v0.1.

## 6. How to inspect captured observations

```sql
SELECT pattern_type, count(*), max(created_at)
FROM anfis_federated_observations
WHERE profile_id = '<the user's profile id>'
GROUP BY pattern_type;
```

Or via the route:

```
GET /api/v1/anfis/federated-stats/:user_id
```

Both surfaces respect the `share_consent=FALSE` invariant — they
**read** the observations but never **export** them.

## 7. Patent-relevance

P-014 §3.7 captures the architectural claim: federated learning of
attention-routing patterns grounded in declared purpose, with the
aggregations performed on patterns that are provably non-reversible to
source data. v0.1 demonstrates the schema embodiment; v1 will
demonstrate the cross-user training. The combination — purpose-
grounded ANFIS plus federated pattern aggregation plus on-by-default
privacy hardening — is the novelty axis.
