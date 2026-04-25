# HAL Calibration Fix — Verification

**Date:** 2026-04-25
**Branch:** `feat/hal-calibration-fix` (from `origin/main`)
**Companion:** `docs/HAL-TIER1-AUDIT.md` (the diagnostic that motivated this fix)
**Status:** Read-the-honest-results-please. The fix works as designed on the
 `+0.35 epistemic penalty`. It does NOT bring truths under the 0.25 veto
 threshold on the 6-prompt micro-test, because the threshold + the rest of
 the signal formula still over-veto. Full numbers below — Sean to decide
 whether to land the fix as-is or pair it with a threshold/formula tweak.

---

## What changed (one file, one block)

`src/services/hal-signals.ts:94-95` — the `+0.35` epistemic-mismatch boost
is now **gated on an additional independent overreach signal**:

```ts
// BEFORE
let certaintyHedgeMismatch =
  certainty > 0.88 && hedgeCount === 0 ? 0.35 : 0;

// AFTER (Option B)
const overreachStyleSignal = overconfidenceCount > 0 || specificNumbers > 0;
let certaintyHedgeMismatch =
  certainty > 0.88 && hedgeCount === 0 && overreachStyleSignal ? 0.35 : 0;
```

`overconfidenceCount` and `specificNumbers` are already computed for the
`harm_probability` signal (lines 78-82). The fix piggybacks on them — no
new regex, no new constant.

### Why Option B over A/C

I considered three options described in the sprint brief:

- **A — lower the magnitude** (`+0.35` → `+0.10`): cheap, but still applies
  to confident-correct statements. Wrong direction, just smaller.
- **B — require additional signal alignment** (chosen): semantically
  correct. The intuition the original rule encoded — "confident-and-unhedged
  is suspicious" — is only true when *combined with* overconfident wording
  or specific quantitative claims. Plain confident factual assertions
  ("Paris is the capital of France") shouldn't trip the same penalty as
  ("LA cap rates definitely compressed 4.8% in 2024").
- **C — smooth function instead of cliff edge**: addresses the threshold
  cliff but not the conceptual bug. Confident truths would still get a
  (smaller) penalty.

Option B is the only one that aligns the rule with what it's meant to
detect.

---

## Live verification

Compiled the patched `src/services/hal-signals.ts` to a temp directory and
applied the same `src/routes/v1.ts:13-32` dissonance formula to the 6
prompts from the diagnostic doc, plus 2 controls to confirm the fix doesn't
regress on the cases the original rule was actually designed for.

### Method
- Source compiled with `tsc hal-signals.ts --target ES2019 --module
  commonjs --esModuleInterop --skipLibCheck` to
  `%TEMP%/halfix/hal-signals.js`.
- Test harness at `%TEMP%/halfix/test.js` — applies
  `(0.4·harm + 0.3·epis + 0.2·(1−evid) + 0.1·(1−scop)) × (531441/524288)`
  with veto threshold 0.25 (matches `src/routes/v1.ts:29`).
- Production `/api/v1/hal/signals` was NOT hit live because that endpoint
  requires a `REPID_API_KEYS` Bearer header that I don't have. The temp
  module *is* the same compiled function the route would call, so the
  output is byte-identical to what the live endpoint would return after
  this branch is deployed.

### Raw transcript

```
HALLUC: SF capital                 | cert=0.9  | hal=0.3963 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.220 | scop=0.000
HALLUC: Eiffel London              | cert=0.9  | hal=0.3984 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.210 | scop=0.000
HALLUC: water 50C                  | cert=0.9  | hal=0.3781 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.310 | scop=0.000
HALLUC: Einstein phone             | cert=0.9  | hal=0.4004 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.200 | scop=0.000
TRUTH:  Paris capital              | cert=0.9  | hal=0.4288 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.060 | scop=0.000
TRUTH:  Sun east                   | cert=0.9  | hal=0.4288 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.060 | scop=0.000
OVERCONF HALLUC: definitely        | cert=0.95 | hal=0.6791 | vetoed=TRUE  | harm=0.380 | epis=0.800 | evid=0.110 | scop=0.000
NUMERIC HALLUC: 50% rate           | cert=0.95 | hal=0.4744 | vetoed=TRUE  | harm=0.080 | epis=0.800 | evid=0.520 | scop=0.000
```

### Side-by-side with the pre-fix numbers from `HAL-TIER1-AUDIT.md` § D.3

| prompt | epis BEFORE | epis AFTER | hal BEFORE | hal AFTER | Δ hal |
|---|---|---|---|---|---|
| HALLUC: SF capital              | 0.800 | 0.450 | 0.5028 | 0.3963 | **−0.107** |
| HALLUC: Eiffel London           | 0.800 | 0.450 | 0.5048 | 0.3984 | −0.106 |
| HALLUC: water 50C               | 0.800 | 0.450 | 0.4845 | 0.3781 | −0.106 |
| HALLUC: Einstein phone          | 0.800 | 0.450 | 0.5068 | 0.4004 | −0.106 |
| TRUTH: Paris capital            | 0.800 | 0.450 | 0.5352 | 0.4288 | −0.106 |
| TRUTH: Sun east                 | 0.800 | 0.450 | 0.5352 | 0.4288 | −0.106 |
| OVERCONF: definitely guaranteed | 0.800 | 0.800 | (n/a)  | 0.6791 | preserved |
| NUMERIC: 50% rate               | 0.800 | 0.800 | (n/a)  | 0.4744 | preserved |

### Success criteria checklist

| Criterion | Result |
|---|---|
| All 4 hallucinations: vetoed=true (preserved) | **YES** — all four still veto. |
| Both truths: vetoed=false (fixed) | **NO** — both still veto. Dissonance dropped 20% but stayed above the 0.25 threshold. |
| Overconfident-hallucination control: still flagged | **YES** — `definitely guaranteed`-style claims still get the +0.35 boost (epistemic stays 0.800). |
| Numeric-hallucination control: still flagged | **YES** — `50%`-style claims still get the +0.35 boost. |

The first criterion holds. The second does not.

---

## Honest analysis — why the truth-veto criterion isn't met

The +0.35 boost was **one** of three signal contributions pushing the
truths above 0.25. Removing it brings dissonance down by ~0.106, but two
other contributions remain:

1. **Low evidence_quality on short factual sentences.** "Paris is the
   capital of France" has 0 numbers, 0 temporal references, no consecutive
   capitalized-word pairs (`\b[A-Z][a-z]{2,}(\s[A-Z][a-z]{2,})+/` requires
   *two* in a row — single-word proper nouns like "Paris" don't count), and
   length 6 → lengthScore = 0.15 → evidence ≈ 0.06 → `(1−evidence) = 0.94`
   → contributes **+0.188** to dissonance.

2. **Zero scope match for `domain='general'`.** The `DOMAIN_ONTOLOGIES`
   table at `hal-signals.ts:17-43` has no `general` entry. The fallback at
   line 120-121 uses the `finance` ontology. None of the test prompts
   contain finance terms → scope = 0 → `(1−scope) = 1` → contributes
   **+0.10** to dissonance.

So even after the +0.35 fix, the floor for an unhedged confident
general-domain factual sentence is roughly:

```
hal_min = (0 + 0.3·0.45 + 0.2·0.94 + 0.1·1.0) × 1.013643
       ≈ (0.135 + 0.188 + 0.100) × 1.014
       ≈ 0.428
```

Which is **above** the 0.25 veto threshold. The threshold and the formula
together are simply set up so that any short, low-evidence, no-scope-match
claim vetoes by default. The +0.35 boost was an *additional* aggravator
on top of an already-aggressive baseline.

### What would actually fix the truth false-positives on this micro-test

Three independent levers, none of which is in the scope of this sprint
(per CLAUDE-RULE-3 — "fix only the named issue"):

A. **Raise the veto threshold** from 0.25 to ≈ 0.45–0.50. Surgical, but
   makes the existing system less sensitive overall. Would let some
   borderline hallucinations (current ~0.40) through.
B. **Default `scope_appropriateness` to 0.5 (not 0) when domain is
   unknown.** Would shave 0.05 off the dissonance floor. Defensible: a
   missing domain map shouldn't be punitive.
C. **Restructure `evidence_quality`** so short factual sentences aren't
   penalized for being short. Probably the deepest fix — needs careful
   tuning + a real validation set.

Recommend Sean treat this micro-test as motivation for a follow-up
calibration sprint that pairs the Option B change here with one of A/B/C
above. **Do not raise the veto threshold in this branch** — would change
behavior of every other caller of `/hal/signals`, including production
trustchat traffic.

---

## What the TruthfulQA benchmark will likely show (predicted, not measured)

At scale (300 prompts × 4 models = ~1200 evaluations), the calibration fix
should:

- **Reduce false-positive rate.** Truth-correlated answers that previously
  got the +0.35 epistemic boost now don't (unless the LLM responded with
  "definitely / certainly / guaranteed / 100% / specific %-numbers"). Many
  truthful responses are written in plain assertive prose without
  overconfident markers. These should now pass.
- **Preserve veto on overconfident hallucinations.** The two control
  prompts in the verification confirm this. Fabrications that use
  overconfident language ("absolutely", "guaranteed", numeric specifics)
  still trip the boost.
- **Not affect** the absolute floor of dissonance for short low-evidence
  prose. Plain-style truthful short answers may still false-positive in
  proportion to how short and feature-poor they are.

Net F1 should rise. By how much depends on the LLM responses' style
distribution, which we won't know until the run completes. This document
makes no F1 prediction without data.

---

## What I did NOT change

- `src/routes/v1.ts` veto threshold (0.25) — out of scope.
- `DOMAIN_ONTOLOGIES` table — out of scope.
- `evidence_quality` formula — out of scope.
- `src/routes/agents-external.ts` `/score-event` certainty-only formula —
  separate bug, separate fix (see `HAL-TIER1-AUDIT.md` § E.5).
- `hal-benchmark/run.ts` — already correctly targets `/api/v1/hal/signals`
  (line 97). No edit needed. Health-check probe at `/api/health` (line 32)
  may 404 because the engine exposes `/health` and `/api/v1/health`, not
  `/api/health` — flagged for Sean, NOT fixed in this branch (out of named
  scope).

## Files touched on this branch

```
M  src/services/hal-signals.ts          (+8/-1, the calibration fix)
A  docs/HAL-CALIBRATION-FIX-VERIFICATION.md   (this file)
```

## How to roll back

```
git revert <commit-sha-of-this-branch's-fix>
```

The fix is one block; the revert is clean.
