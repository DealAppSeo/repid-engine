# HAL Canonical Spec

**Source:** extracted from repid-engine source tree at commit `36226dc`
(branch `docs/hal-canonical-v1`).

This document describes what HAL (the Hallucination Auditor layer) actually
does in the deployed repid-engine code. It is not a design document and it
is not synthesized from prior chat transcripts. Every number, formula, and
threshold is cited to `file:line`. Anything without a citation is not in
the code.

Two coexisting HAL paths exist in the repository. Both are documented.

---

## The 5 signals

HAL nominally consumes 5 signals:

| Signal | Range | Definition |
|---|---|---|
| `harm_probability` | `[0, 1]` | Likelihood the claim causes downstream harm |
| `epistemic_uncertainty` | `[0, 1]` | Mismatch between stated confidence and hedging |
| `evidence_quality` | `[0, 1]` | Specificity / verifiability of the claim (higher = better) |
| `scope_appropriateness` | `[0, 1]` | Claim's lexical overlap with the declared domain ontology |
| `certainty_at_claim` | `[0, 1]` | Self-reported confidence supplied with the claim |

Two independent signal extractors exist in code:

### A. Text-derived extractor — `extractHALSignals`

File: `src/services/hal-signals.ts:67-135`.

Inputs: `claimText`, `domain`, `certainty`.

- `harm_probability` — `src/services/hal-signals.ts:78-87`
  Counts tokens from `OVERCONFIDENCE_MARKERS` (list at `:45-50`) and regex
  matches for specific numbers with units (`\d+\.?\d*\s*(%|percent|basis|bps|billion|million)`).
  Formula: `min(1, overconfidence·0.18 + specificNumbers·0.08 + (certainty>0.92 && overconfidence>0 ? 0.2 : 0))`.

- `epistemic_uncertainty` — `src/services/hal-signals.ts:91-103`
  Counts tokens from `EPISTEMIC_HEDGES` (list at `:52-57`) into `hedgeDensity = hedgeCount / max(wordCount/8, 1)`.
  Adds `0.35` mismatch term when `certainty > 0.88 && hedgeCount === 0`.
  In `mathematics` or `cryptography` domain, the mismatch term is scaled by `0.30` (`:97-99`).
  Formula: `min(1, max(0, 0.45 − hedgeDensity·0.25 + mismatch))`.

- `evidence_quality` — `src/services/hal-signals.ts:107-116`
  Boolean features: has digits, has a year/quarter/month, has proper nouns.
  Plus `lengthScore = min(1, wordCount/40)`.
  Formula: `min(1, 0.25·hasNumbers + 0.20·hasTemporalRef + 0.15·hasProperNouns + 0.40·lengthScore)`.

- `scope_appropriateness` — `src/services/hal-signals.ts:120-126`
  Jaccard-like overlap between the claim text and the domain ontology defined
  in `DOMAIN_ONTOLOGIES` (`:17-43`; supported domains: `cre-underwriting`,
  `compliance`, `finance`, `technical`, `legal`; default fallback is `finance` per `:120-121`).
  Formula: `min(1, matchCount / max(ontology.length·0.25, 1))`.

- `certainty_at_claim` — pass-through of the caller-supplied `certainty` (`:133`).

### B. Certainty-only extractor (inline in `/score-event`)

File: `src/routes/agents-external.ts:186-196`.

Used by the **live production scoring endpoint**. Does **not** call
`extractHALSignals` for the veto decision (it calls it at `:179-181` but only
stores the output in `metadata.hal_signals`; nothing downstream reads it).

Piecewise functions of `certainty`:
- `harmScore = 1 − certainty`                             (`:186`)
- `epistemicScore = certainty<0.5 ? 0.8 : certainty<0.7 ? 0.5 : certainty<0.85 ? 0.3 : 0.1` (`:187-189`)
- `evidenceScore = certainty>0.8 ? 0.1 : certainty>0.6 ? 0.25 : 0.5` (`:190-191`)
- `scopeScore    = certainty>0.8 ? 0.1 : certainty>0.6 ? 0.2  : 0.3` (`:192-193`)

Note: in path B, `evidenceScore` and `scopeScore` already encode "how bad",
so the downstream combination does **not** invert them (see dissonance below).
In path A (`/api/v1/hal/signals` and `runValidation`), `evidence_quality` and
`scope_appropriateness` encode "how good" and are inverted as `(1−evidence)`,
`(1−scope)` before weighting.

---

## The dissonance calculation

The Pythagorean Comma constant is `PYTHAGOREAN_COMMA = 531441 / 524288`
(≈ 1.013643). Declared three times in the codebase:
- `src/routes/agents-external.ts:9`
- `src/routes/v1.ts:25` (inline literal)
- `src/services/anfis-comma.ts:15` (as `COMMA_RATIO`)

### Formula as used by `/api/v1/agents/:id/score-event` (production scoring)

`src/routes/agents-external.ts:194-196`:

```
dissonance =
  (0.4·harmScore + 0.3·epistemicScore + 0.2·evidenceScore + 0.1·scopeScore)
  × (531441/524288)
```

Where the four components are the certainty-only piecewise values from
extractor B above.

### Formula as used by `POST /api/v1/hal/signals`

`src/routes/v1.ts:20-25`:

```
hal_score =
  (0.4·harm_probability
 + 0.3·epistemic_uncertainty
 + 0.2·(1 − evidence_quality)
 + 0.1·(1 − scope_appropriateness))
  × (531441/524288)
```

Where the four components come from `extractHALSignals` (extractor A).

This is the same formula shape; the `(1 − x)` inversions on evidence/scope
are because extractor A returns "quality" (high is good), while extractor B
returns "risk" (high is bad).

### `commaANFIS` (not wired to production)

`src/services/anfis-comma.ts` implements a 5-input / 5-rule Gaussian
ANFIS forward pass with golden-ratio-scaled centers and spreads
(`PHI = (1+√5)/2` at `:14`, `goldenCenters` `:19-25`, `goldenSpreads`
`:27-31`) and a "detune in cents" dissonance term at `:69-74`. It
exports `commaANFIS` (`:80-113`) but is **not imported anywhere** —
grepped on `2026-04-23` with no call sites in `src/routes/`,
`src/engine/`, `src/middleware/`, or `src/layers/`. ~~It is dead code
awaiting Sprint 3 wiring.~~

> **CORRECTED 2026-08-17.** "Dead code" is **false at the module level** and was already
> false when written as a claim about the file. Only the `commaANFIS` *entry point* is
> uncalled. The rest of `src/services/anfis-comma.ts` — `anfisForward`, `goldenCenters`,
> `goldenSpreads`, `gaussianMF` — has **three live consumers**:
> `src/services/proof-tier-policy.ts:31`, `src/services/anfis-router.ts:16`, and
> `src/resilience/anfis-failover.ts:18`.
>
> The original grep was scoped to four directories (`src/routes/`, `src/engine/`,
> `src/middleware/`, `src/layers/`) and every consumer lives outside all four, so the
> sentence generalised a narrow, correct observation into a wrong claim about a file. That
> matters practically: read as written, it invites deleting a module three production paths
> import from.
>
> Standing state for the uncalled entry point is recorded in
> `src/orchestration/promotion-register.ts` (`comma-anfis-entry-point`, PARKED), where it is
> checked by tests rather than by a reader.

### Usage of φ

- `PHI_FALLBACK = 1.618033988749895` — `src/routes/agents-external.ts:12`, consumed by the reward formula via `getConfigNumber('phi', PHI_FALLBACK)` at `:217`. Not used by the HAL dissonance calculation.
- `PHI` in `src/services/anfis-comma.ts:14` — scales rule centers/spreads inside the unused `commaANFIS`.
- `φ^-1` (0.618) — **does not appear** in any HAL code path. `CLAUDE.md` references `BFT_THRESHOLD = 0.618` as a project-wide constitutional value, but the in-repo `src/` tree has no such threshold hard-coded.

---

## Verdict thresholds

### Path 1 — `POST /api/v1/agents/:id/score-event` (live)

Source: `src/routes/agents-external.ts:185-206`.

- `halApproveThreshold` — read from `repid_config.hal_veto_threshold` via `getConfigNumber('hal_veto_threshold', 0.25)` (fallback **0.25**).
- `HAL_CONSTITUTIONAL_BLOCK` — hard-coded `0.48` at `:11`.

Decision logic:
- `dissonance > 0.48` → HTTP 403, body `{ error: 'Constitutional block', hal_score, reason: 'dissonance exceeds constitutional block threshold (0.48)' }`. No score event is written.
- `dissonance ≤ halApproveThreshold` → `halApproved = true`, reward is the positive output of `calculateFullReward` (`:231-255`).
- `halApproveThreshold < dissonance ≤ 0.48` → `halApproved = false`, `rawDelta = -|baseDelta|` (`:257`). Still writes a `repid_score_events` row.

No string verdict is assigned on this path; the outcome is communicated via the `hal_approved` boolean and the signed `delta`.

### Path 2 — `POST /challenge` (adversarial, the primary demo endpoint)

Source: `src/routes/challenge.ts:81-120`.

This path does **not** compute PCV dissonance. It derives verdict from:
- `audit.complianceScore` — returned by `auditConstitutionalCompliance`, which currently calls `anfis_scoreCompliance` — a stub that always returns `1.0` (`src/layers/constitutional-audit.ts:44-46`).
- `audit.passed` — `complianceScore > 0.48` (`src/layers/constitutional-audit.ts:79`).
- `certainty` — from `req.body.certaintyAtClaim`, default `0.75` (`src/routes/challenge.ts:87`).
- `hasEvidence` — `typeof evidenceText === 'string' && evidenceText.length > 20` (`:88`).

Verdict ladder (`src/routes/challenge.ts:94-120`), evaluated top-down:

1. `!audit.passed` → `EPISTEMIC_VIOLATION`, halMode=4.
2. `certainty > 0.9 && audit.complianceScore < 0.95` → `EPISTEMIC_VIOLATION`, halMode=4.
3. `audit.complianceScore >= 0.85`:
   - `hasEvidence && certainty >= 0.65` → `CLAIM_UPHELD`, halMode=1.
   - `!hasEvidence && certainty < 0.5` → `DRAW`, halMode=3.
   - else → `CLAIM_REJECTED`, halMode=2.
4. fallthrough → `GRAY_AREA`, halMode=3.

Because `anfis_scoreCompliance` is stubbed to return `1.0`, branch 1 can
only fire if `rulesChecked` or other gates fail (they don't — all stubs
pass), branch 2 never fires (`1.0 < 0.95` is false), and branch 4 is
unreachable. In the current stubbed state every request lands in branch 3.

### HAL mode → constitutional mapping

From `src/layers/constitutional-audit.ts:87-93`:
- `complianceScore > 0.85` → halMode 1 (VERIFY)
- `complianceScore > 0.70` → halMode 2
- `complianceScore > 0.48` → halMode 5 (MEDIATE)
- `complianceScore ≤ 0.48` → halMode 6 (PROTECT — constitutional veto)
- `!mirrorTestPassed` → halMode 7 (overrides any of the above)

Note: `/challenge` assigns halMode directly from its verdict ladder, not
from this mapping. The two systems are decoupled in code today.

---

## What actually triggered the 3 production `CLAIM_REJECTED` events

All three `CLAIM_REJECTED` rows in `hal_production_events` were written by
the `/challenge` route. Evidence:

- `CLAIM_REJECTED` is assigned at exactly one place in the codebase: `src/routes/challenge.ts:112`.
- That route calls `logHalProductionEvent` (`:224-246`) without passing `pcvDissonance`, so the DB column is `null` — matches the observed state.
- The same call passes `pcvVetoed: verdict === 'EPISTEMIC_VIOLATION'`, which is `false` for `CLAIM_REJECTED` — matches the observed state.

Given the stubbed `anfis_scoreCompliance === 1.0`, the only way the ladder
reaches the `else → CLAIM_REJECTED` branch is when **both** of these are
true:
- NOT (`hasEvidence && certainty >= 0.65`), i.e. either the challenge had no evidence (or <20 chars) or the declared `certaintyAtClaim` was `< 0.65`.
- NOT (`!hasEvidence && certainty < 0.5`), i.e. either evidence **was** provided, or the declared certainty was `>= 0.5`.

Concretely, the 3 rejections fall into one of these two cases:
1. Challenger submitted no (or <20-char) `evidenceText` and `certaintyAtClaim ∈ [0.5, 0.9]`.
2. Challenger submitted ≥20-char `evidenceText` but `certaintyAtClaim ∈ [0, 0.65)`.

There is no PCV dissonance, BFT, or ANFIS computation behind those 3
rejections — they are purely rule-based, gated on a hard-coded 1.0
compliance stub.

---

## Known gaps / TODOs (stubs in current code)

Every item below is explicitly marked as "stub" or "Sprint 3" in the source.
Do not treat any of them as live logic.

- `src/layers/constitutional-audit.ts`
  - `lasso_selectRelevantRules` — returns `Object.keys(agent.constitution.rules)` instead of a LASSO-selected subset (`:30-39`).
  - `anfis_scoreCompliance` — returns `1.0` unconditionally (`:44-46`).
  - `runMirrorTest` — returns `true` unconditionally (`:48-51`).
  - `generateEASAttestationStub` — returns `eas-stub-<ms>-<first8>` (`:58-60`). No on-chain write.
  - `fileConstitutionalChallenge` — returns `PENDING_HAL_MEDIATION` with no real mediation (`:109-125`).

- `src/services/anfis-comma.ts` — the `commaANFIS` ANFIS + Gaussian membership + detune-cents dissonance is implemented but **not wired**. Grepping `src/` on 2026-04-23 shows no import outside the file itself.

- `src/routes/challenge.ts:224-246` — `logHalProductionEvent` is called with `pcvDissonance`, `sbfaScore`, `bftConsensusPct`, `sltUncertainty`, `repidWeight`, `wsceCoherence`, `gnnsrContradictions`, `anfisAdjustment`, and all corresponding `*LatencyMs` fields left undefined. The `layers_active` JSON flags all layers as `true` even though no corresponding computation ran.

- `src/routes/agents-external.ts:179-181` — `extractHALSignals` is invoked, but its output is only stored in `metadata.hal_signals`. The veto decision uses the certainty-only extractor B instead.

- Benchmark / antifragility pipeline (`src/services/hal-tester.ts`, `src/index.ts:184-245`) assumes an `hal_test_prompts` table exists in Supabase. Schema is not managed from this repo (see `CLAUDE.md` — migrations live externally).

- Rate limiting at `src/index.ts:40-44` (scoreLimiter) uses `ipKeyGenerator(req.ip ?? '')` as an IPv6-safe fallback — added in commit `36226dc` to fix the Railway `ERR_ERL_KEY_GEN_IPV6` crash.

---

## Wave 5 update (2026-05-04) — strictness scale

The library at `src/hal/lib/` now exposes a 5-level strictness scale (default 4). Layer behavior is gated by level:

- **L1 Fast** — extractor only.
- **L2 Light** — adds cross-LLM with semantic (cosine on embeddings) similarity.
- **L3 Balanced** — adds Pythagorean Comma BFT critical-veto. **Byte-identical to pre-Wave-5 production behavior.**
- **L4 Strict (DEFAULT)** — adds three-zone band classification (`COMMA_BAND_TIGHT_THRESHOLD=0.99`, `COMMA_BAND_LOOSE_THRESHOLD=0.95`) and consensus-vs-claim comparison (catches HAL-T1-003 class fabrications).
- **L5 Maximum** — adds tampering signal when zone is `too-tight`.

The Pythagorean Comma constant (`531441/524288`) remains fixed and patent-load-bearing. Zone boundaries and the claim-contradiction threshold are calibratable around it. See [HAL_LIBRARY_API.md](./HAL_LIBRARY_API.md) for the full spec and [HAL_TAMPERING_DETECTION.md](./HAL_TAMPERING_DETECTION.md) for the level-5 tampering signal.
