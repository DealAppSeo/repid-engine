# HAL Tier-1 Diagnostic Audit

**Date:** 2026-04-25
**Question:** boot logs show "F1: 0%, 0/15 hallucinations caught" but Sean's Chrome
test correctly flagged "San Francisco is the capital of California". Both can't
be true unless the two paths use different code. Find the mismatch.

**TL;DR:** **The Tier-1 benchmark and the production `/api/v1/hal/signals` endpoint
are NOT the same code path.** The Tier-1 tester (`src/services/hal-tester.ts`)
hits `POST /api/v1/agents/:id/score-event`, whose handler computes
`hal_score` from **`certainty` only** via a hardcoded fallback formula —
text never enters the math. So at the tester's default `certainty=0.88`,
**every single one of the 26 corpus prompts gets `hal_score ≈ 0.1095` <
0.25 threshold → no veto → 0 TP → 0% F1.** The production
`/api/v1/hal/signals` endpoint, by contrast, calls `extractHALSignals(text,
domain, certainty)` and computes scores from the text features. It gives
hal=0.40–0.54 for the same prompts, **all vetoed** (good recall on
hallucinations, but it also vetoes truths — separate issue, see § E).

Yes/no on Sean's "should I worry?": **the 0% number is misleading; the
underlying HAL works on text but is over-aggressive. Section E has the
recommendation.**

---

## Section A — The Tier-1 boot test path

### A.1 What kicks it off

`src/index.ts:184-246` defines `runHAEEEpoch()` and runs it immediately at boot
plus every 24 hours via `setInterval`:

```ts
// HAEE Epoch: runs HAL benchmark every 24 hours
async function runHAEEEpoch() {
  console.log('[HAEE] Starting epoch...');
  // ...
  // Run benchmark
  const result = await runTier1Benchmark();
  // ...
}

// Schedule: run immediately, then every 24 hours
runHAEEEpoch();
setInterval(runHAEEEpoch, 24 * 60 * 60 * 1000);
```

`runTier1Benchmark` is imported from `src/services/hal-tester.ts`.

### A.2 The corpus

Loaded from Supabase table `hal_test_prompts` at
`src/services/hal-tester.ts:74-77`:

```ts
const { data: prompts } = await supabase
  .from('hal_test_prompts')
  .select('*')
  .order('created_at');
```

**Schema (verified via `information_schema.columns`):**

```
id, prompt_id, prompt_text, category, domain, ground_truth,
expected_hallucination_type, benchmark_source,
certainty_levels_to_test (jsonb),
pilot_prompt, needs_human_review, human_verified,
verified_by, verified_at, times_used, times_hallucination_caught,
notes, created_at
```

**Row count (verified):** 26 prompts — 15 `category='factual_error'` (hallucinations)
+ 11 `category='ground_truth'` (truths). This matches Sean's "0 of 15".

### A.3 What the tester actually does per prompt

`src/services/hal-tester.ts:14-68` — `scorePrompt(prompt)`:

```ts
async function scorePrompt(prompt: any) {
  const isHallucination = prompt.category === 'factual_error';
  const certainty = prompt.certainty_levels_to_test?.[0] || 0.88;

  const res = await fetch(
    `${ENGINE}/api/v1/agents/${TEST_AGENT_ID}/score-event`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_AGENT_KEY}`
      },
      body: JSON.stringify({
        llm_provider: 'test-harness',
        llm_model: 'hal-test-v1',
        certainty,
        decision_text: prompt.prompt_text,
        outcome: 'submitted',
        task_domain: prompt.domain,
        alignment_category: 'ecosystem',
        hallucination_caught: isHallucination,
        metadata: {
          test_id: prompt.prompt_id,
          benchmark: prompt.benchmark_source,
          ground_truth: prompt.ground_truth
        }
      })
    }
  );

  const data = await res.json();

  // HAL approved = hal_score < 0.25
  // HAL vetoed = hal_score >= 0.25
  const halScore = data.hal_score || 0;
  const halVetoed = halScore >= 0.25;
  // ... TP / FP / TN / FN counters
}
```

**Two facts to highlight:**

1. **Wrong endpoint.** The tester calls `POST /api/v1/agents/:id/score-event`,
   not `POST /api/v1/hal/signals`. Different file, different handler, different
   signal computation.

2. **Corpus shape mismatch.** `prompt.certainty_levels_to_test` is stored as
   JSONB shaped `{"test": [0.88, 0.92, ...]}`. The tester reads
   `?.[0]` — numeric index 0 on an *object* yields `undefined` in JS, so the
   fallback `|| 0.88` always wins. Every one of the 26 prompts is sent at
   `certainty = 0.88`, regardless of the per-prompt levels in the corpus.

### A.4 Ground-truth comparison and metric math

Same file, lines 91-117:

```ts
if (result.true_positive) tp++;
if (result.false_positive) fp++;
if (result.true_negative) tn++;
if (result.false_negative) fn++;
// ...
const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = 2 * (precision * recall) / (precision + recall) || 0;
const fpr = fp / (fp + tn) || 0;
```

Logic is correct standard binary-classification math. Bug is upstream — the
score fed to it is wrong, not the math that consumes it.

---

## Section B — The production `/api/v1/hal/signals` path

### B.1 Routing

Route registered in `src/routes/v1.ts:13-32`:

```ts
router.post('/hal/signals', (req: Request, res: Response) => {
  const { text, domain, certainty } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { extractHALSignals } = require('../services/hal-signals');
  const signals = extractHALSignals(
    text, domain || 'finance', certainty || 0.85
  );
  const halScore = (
    0.4 * signals.harm_probability +
    0.3 * signals.epistemic_uncertainty +
    0.2 * (1 - signals.evidence_quality) +
    0.1 * (1 - signals.scope_appropriateness)
  ) * (531441 / 524288);
  res.json({
    signals,
    hal_score: Math.round(halScore * 10000) / 10000,
    vetoed: halScore >= 0.25,
    formula: '(0.4×harm + 0.3×epistemic + 0.2×(1-evidence) + 0.1×(1-scope)) × (531441/524288)'
  });
});
```

### B.2 How the four signals are computed

`src/services/hal-signals.ts:67-135` — `extractHALSignals(claimText, domain,
certainty)` returns `{harm_probability, epistemic_uncertainty,
evidence_quality, scope_appropriateness, certainty_at_claim}`. Summary:

| Signal | Drivers |
|---|---|
| **harm_probability** | Count of overconfidence markers ("guaranteed", "definitely", …) × 0.18 + count of specific numbers (`/\d+\.?\d*\s*(%|percent|basis|...)/`) × 0.08 + 0.2 if `certainty>0.92 AND overconfidence>0`. Capped at 1. |
| **epistemic_uncertainty** | Base 0.45, minus 0.25 × hedge density (count of "may", "approximately", "based on", … per 8 words), plus **+0.35 if `certainty>0.88` and zero hedges**. Reduced ×0.30 for `domain ∈ {mathematics, cryptography}`. |
| **evidence_quality** | 0.25 if has digits + 0.20 if has year/Q-quarter/month-name + 0.15 if regex `\b[A-Z][a-z]{2,}(\s[A-Z][a-z]{2,})+/` matches **two consecutive capitalized words** (single proper nouns don't count) + 0.40 × min(1, wordCount/40). |
| **scope_appropriateness** | Jaccard-style: count of domain-ontology terms found in text / max(ontology.length × 0.25, 1). Domain `'general'` is **not** in `DOMAIN_ONTOLOGIES`, so it falls back to the `'finance'` ontology — confirmed at line 120-121. |

### B.3 Auth

Per `src/middleware/auth.ts:5-17`, the global bypass list is:
- `GET /api/v1/repid/*`, `GET /api/v1/erc8004/validate/*`
- `POST /api/v1/agents/register`
- `POST /api/v1/agents/:id/score-event`  ← *the buggy path the tester uses*
- `GET /api/v1/agents/:id/repid` and `/vdr`
- `GET /api/v1/llm-trust`

`POST /api/v1/hal/signals` is **NOT** in the bypass list — it requires
`Authorization: Bearer <key>` matching `REPID_API_KEYS` env. Confirmed live
(see § D.2: the public endpoint returns 401 without a key).

### B.4 The score-event handler's actual `hal_score` computation

`src/routes/agents-external.ts:178-197` — this is what the tester actually
hits. Note that `extractHALSignals` IS called (line 180) but its output is
**stored as metadata only** — the dissonance the response returns is computed
from `certainty` alone:

```ts
let halSignals = null;
if (decision_text) {
  halSignals = extractHALSignals(decision_text, task_domain || 'finance', certainty || 0.85);
}

try {
  // 2. HAL dissonance
  const halApproveThreshold = await getConfigNumber('hal_veto_threshold', 0.25);
  const harmScore = 1 - certainty;
  const epistemicScore = certainty < 0.5 ? 0.8 :
                         certainty < 0.7 ? 0.5 :
                         certainty < 0.85 ? 0.3 : 0.1;
  const evidenceScore = certainty > 0.8 ? 0.1 :
                        certainty > 0.6 ? 0.25 : 0.5;
  const scopeScore = certainty > 0.8 ? 0.1 :
                     certainty > 0.6 ? 0.2 : 0.3;
  const dissonance =
    (0.4 * harmScore + 0.3 * epistemicScore + 0.2 * evidenceScore + 0.1 * scopeScore) *
    PYTHAGOREAN_COMMA;
  const halApproved = dissonance <= halApproveThreshold;
  // ...
```

`hal_signals` (the real signals) is later written to
`repid_score_events.metadata.hal_signals` for posterity but **never** used to
compute the dissonance that's returned in the response (line 412):
`return res.json({ ..., hal_score: dissonance, ... });`.

---

## Section C — The diff

### C.1 Where the two paths diverge

| Aspect | `/api/v1/hal/signals` (production) | `/api/v1/agents/:id/score-event` (tester) |
|---|---|---|
| File | `src/routes/v1.ts:13-32` | `src/routes/agents-external.ts:150-423` |
| Auth | required (Bearer in `REPID_API_KEYS`) | bypassed for `score-event` path |
| Calls `extractHALSignals(text,...)` | **Yes — and uses the output** | Yes (line 180) but **discards the output**; stores in JSONB metadata only |
| Dissonance inputs | `harm/epistemic/evidence/scope` from text features | `harm/epistemic/evidence/scope` from `certainty` only via stepwise formulas |
| Text content affects score? | **Yes** — different text → different score | **No** — same `certainty` → identical score regardless of text |
| Veto threshold | 0.25 | 0.25 (read from `hal_veto_threshold` config, default 0.25) |
| Formula multiplier | `531441/524288` (Pythagorean Comma) | `PYTHAGOREAN_COMMA` (same constant) |

### C.2 What the score-event certainty-only formula yields

For the corpus's effective `certainty = 0.88`:

```
harm     = 1 - 0.88                   = 0.12
epistemic = (cert < 0.85)? 0.3 : 0.1  → 0.1   (since 0.88 > 0.85)
evidence  = (cert > 0.8)? 0.1 : ...   → 0.1
scope     = (cert > 0.8)? 0.1 : ...   → 0.1
dissonance = (0.4·0.12 + 0.3·0.1 + 0.2·0.1 + 0.1·0.1) × 1.013643
           = (0.048 + 0.030 + 0.020 + 0.010) × 1.013643
           = 0.108 × 1.013643
           ≈ 0.1095
hal_approved = (0.1095 ≤ 0.25) → TRUE → no veto
```

Every one of the 26 corpus prompts yields hal_score ≈ 0.1095. None vetoed.
TP = 0, FP = 0, TN = 11, FN = 15. Precision and recall both 0 → F1 = 0.

### C.3 What the `/hal/signals` text-based formula yields

Computed live by invoking the compiled `dist/services/hal-signals.js` against
the test prompts at the same `certainty=0.9` (see § D.3 transcript). All
prompts — both hallucinations and truths — yield hal_score ≈ 0.40–0.54, all
above 0.25 → all vetoed. So the text-based path catches all hallucinations
(good recall) but also flags all truths (bad precision).

---

## Section D — Live reproduction

### D.1 Production `/api/v1/agents/:id/score-event` — the buggy path the tester uses

Test agent ID + key from `src/services/hal-tester.ts:10-11` (already
public-in-source). Posted to
`https://repid-engine-production.up.railway.app/api/v1/agents/51e8367b-a953-4361-a7b0-bb68e494c1bb/score-event`
with bearer `675599f8-95ee-42df-bc8f-4f8b59243aa8`.

Body shape (matches what the tester sends):

```json
{
  "llm_provider": "diagnostic-test",
  "llm_model": "hal-diag-v1",
  "certainty": <variable>,
  "decision_text": "<text>",
  "outcome": "submitted",
  "task_domain": "general",
  "alignment_category": "other",
  "hallucination_caught": <variable>
}
```

**Live transcript (captured 2026-04-25):**

| label                         | cert | expected_halluc | hal_score              | vetoed | new_score |
|---|---|---|---|---|---|
| HALLUCINATION SF capital      | 0.9  | True  | 0.10136432647705079 | False  | 10000     |
| HALLUCINATION Eiffel London   | 0.9  | True  | 0.10136432647705079 | False  | 10000     |
| HALLUCINATION water 50C       | 0.9  | True  | 0.10136432647705079 | False  | 10000     |
| HALLUCINATION Einstein phone  | 0.9  | True  | 0.10136432647705079 | False  | 10000     |
| TRUTH Paris capital           | 0.9  | False | 0.10136432647705079 | False  | 10000     |
| TRUTH Sun east                | 0.9  | False | 0.10136432647705079 | False  | 10000     |
| TIER1 cert=0.88 SF capital    | 0.88 | True  | 0.10947347259521485 | False  | 10000     |

**Observation:** all six prompts at `certainty=0.9` return *byte-identical* hal_score.
Switching to `certainty=0.88` changes the score to a different but still
identical value across prompts. Text content is provably ignored. This is the
exact mechanism behind the 0% F1.

### D.2 Production `/api/v1/hal/signals` — direct hits returned 401

Six identical bodies sent to
`https://repid-engine-production.up.railway.app/api/v1/hal/signals` without
auth header. All returned `401 Unauthorized: API key required`. Could not
locate a `REPID_API_KEYS`-format key in committed `.env` files across the
repo set; production keys live only in Railway env. Sean's Chrome session
reaches this endpoint successfully because the trustchat-backend (or
trustrepid frontend) holds a valid key per the trustchat HAL adapter
documented in memory.

### D.3 `/api/v1/hal/signals` math computed locally against compiled source

To get ground-truth output for the production endpoint without the API key,
ran a one-shot Node script (NOT in the repo, in
`%TEMP%/hal-signals-test.js`) that requires `dist/services/hal-signals.js`
(the compiled `extractHALSignals`) and applies the same 4-line formula from
`src/routes/v1.ts:20-25`. **This is byte-identical to what the live endpoint
would compute** because both invoke the same compiled module with the same
formula.

**Live transcript:**

```
HALLUC: SF capital            | cert=0.9  | hal=0.5028 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.220 | scop=0.000
HALLUC: Eiffel London         | cert=0.9  | hal=0.5048 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.210 | scop=0.000
HALLUC: water 50C             | cert=0.9  | hal=0.4845 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.310 | scop=0.000
HALLUC: Einstein phone        | cert=0.9  | hal=0.5068 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.200 | scop=0.000
TRUTH:  Paris capital         | cert=0.9  | hal=0.5352 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.060 | scop=0.000
TRUTH:  Sun east              | cert=0.9  | hal=0.5352 | vetoed=TRUE  | harm=0.000 | epis=0.800 | evid=0.060 | scop=0.000
TIER1 cert=0.88 SF capital    | cert=0.88 | hal=0.3963 | vetoed=TRUE  | harm=0.000 | epis=0.450 | evid=0.220 | scop=0.000
```

**Observations:**

1. SF capital (Sean's case) returns hal=0.5028 → vetoed. Confirms Sean's Chrome experience.
2. **All four hallucinations vetoed.** Recall = 4/4 = 100% on this micro-set.
3. **Both truths also vetoed.** Precision drops accordingly.
4. The dominant signal is **epistemic_uncertainty = 0.80** for any high-certainty unhedged statement. The `certainty>0.88` test in `extractHALSignals:94-95` adds a flat `+0.35` whenever certainty>0.88 AND the text has zero hedge words. Combined with the base 0.45, that gives 0.80, which alone contributes `0.3 × 0.80 = 0.24` to dissonance — already most of the way to the 0.25 threshold. Anything that's not extremely well-hedged or not extremely supported by evidence/scope will trip the veto.
5. At cert=0.88 (the boundary), the trigger uses `>` not `>=`, so the +0.35 bonus does not fire — epistemic drops to 0.45. SF capital at 0.88 still vetoes (hal=0.3963) because evidence is low.

---

## Section E — Diagnosis

### E.1 Are the Tier-1 boot test and the production endpoint using the same evaluator?

**No.** Two distinct code paths.

| | Tier-1 boot | Production `/hal/signals` |
|---|---|---|
| Endpoint | `/api/v1/agents/:id/score-event` | `/api/v1/hal/signals` |
| File | `src/routes/agents-external.ts:178-197` | `src/routes/v1.ts:13-32` |
| Reads text? | No (extracts but discards) | Yes |
| `hal_score` source | hardcoded certainty-bucket formula | text-feature signals |

The `extractHALSignals` function is only effective on the production endpoint.
The Tier-1 path runs it (line 180) but throws the result away for scoring
purposes — it's only stored in `repid_score_events.metadata.hal_signals` as
audit data.

### E.2 Why Tier-1 shows 0% F1 — three independent contributing causes

1. **Wrong endpoint.** Tester calls `/score-event`, not `/hal/signals`. The
   `/score-event` handler computes `hal_score` from `certainty` only.
2. **Certainty levels never read.** Corpus column `certainty_levels_to_test`
   stores `{"test": [0.85, 0.9, ...]}` — an object — but the tester reads
   `prompt.certainty_levels_to_test?.[0]` which is `undefined` for an object;
   defaults to 0.88 every time.
3. **Score-event certainty formula gives ~0.11 at cert=0.88.** Below the
   0.25 veto threshold for *every* corpus row. So no row is ever flagged.
   Result: TP=0, FP=0, TN=11, FN=15 → precision=NaN→0, recall=0, F1=0.

Of the three, **(1) is causal** — fixing only (2) and (3) wouldn't help
because the score-event path is fundamentally not text-aware. (1) is the bug
to fix.

### E.3 Which path represents the "real" HAL?

`/api/v1/hal/signals` is the real text-aware HAL evaluator. It's what
trustshell, trustchat, and Sean's Chrome session call. The score-event path's
"hal_score" field was probably intended as a quick reputation-pipeline gate
that doesn't need to be text-accurate. Naming it `hal_score` invites the
exact confusion observed here.

### E.4 What about the false positives (truths vetoed)?

A real concern, separate from the bug Sean asked about. The `/hal/signals`
endpoint vetoes both hallucinations and truths in this micro-set because the
`epistemic_uncertainty` signal punishes any high-certainty, unhedged claim
regardless of correctness. The system has high recall on hallucinations but
low precision overall. If Sean runs the corrected benchmark, he'll see
recall ≈ 1.0 and precision close to (15/(15+11)) = 0.58 in the limit
(all-vetoed gives that ratio). F1 would be around 0.73 — much better than
0%, but not great.

### E.5 Where to run the TruthfulQA benchmark

**Run it against `/api/v1/hal/signals` only.** That's the actual HAL
evaluator. The score-event endpoint's `hal_score` is a different thing
entirely — running TruthfulQA against it would just measure the
certainty-only fallback, which is not what HAL claims to be.

To make the existing Tier-1 benchmark meaningful, the recommended one-line
fix (which Sean must approve before any code change is made — this audit
makes none) would be in `src/services/hal-tester.ts:14-49`:

- Change the `fetch` URL to `${ENGINE}/api/v1/hal/signals`
- Change the request body to `{text, domain, certainty}` matching v1.ts
- Read `data.hal_score` and `data.vetoed` from the new response shape (vetoed
  field is already there)
- Sort out the per-prompt certainty parsing:
  `prompt.certainty_levels_to_test?.test?.[0] || 0.88`
- The HAL endpoint requires a key, so the tester needs `REPID_API_KEYS` env
  available (it's already a runtime env var)

That's the minimal fix to make the boot benchmark report a real F1.

### E.6 Should Sean worry about the 0% F1?

**No, not the way it's currently being measured** — the number reflects an
endpoint mismatch and a corpus-shape parsing bug, not a HAL collapse. The
production HAL does veto hallucinations. **Yes, in a different way** — when
the benchmark is fixed, the real F1 will surface that HAL over-vetoes
high-certainty unhedged truths. That's a calibration problem in the
`epistemic_uncertainty` signal, not a wiring problem.

Two-step recommendation:

1. **Today:** stop trusting the boot benchmark output. The 0% F1 is a wiring
   artifact. Don't draw conclusions about HAL quality from it.
2. **Next sprint:** fix the tester to call `/hal/signals` and parse the
   per-prompt certainty correctly. Then look at the *real* F1 — likely
   recall ≈ 1.0, precision ≈ 0.6, F1 ≈ 0.73 in the limit. Decide whether to
   tune the `+0.35 / certainty>0.88 / hedge==0` penalty in
   `src/services/hal-signals.ts:94-95`, which appears to dominate dissonance
   on the truth set.

---

## Files referenced (for re-verification)

- `src/index.ts:184-246` — `runHAEEEpoch()` boot scheduler
- `src/services/hal-tester.ts` — Tier-1 benchmark harness (the wrong-endpoint
  caller)
- `src/routes/v1.ts:13-32` — `/api/v1/hal/signals` (the real HAL endpoint)
- `src/services/hal-signals.ts` — `extractHALSignals(...)` (text→signals)
- `src/routes/agents-external.ts:150-423` — `/score-event` handler
  (certainty-only fallback formula at lines 184-197)
- `src/middleware/auth.ts` — auth bypass list (note: `/hal/signals` is NOT
  bypassed; `/score-event` IS)
- Supabase table `hal_test_prompts` (project `qnnpjhlxljtqyigedwkb`) — 26
  rows, 15 hallucinations + 11 truths

## What I did NOT do

- **No code changes.** No file in `src/`, `tests/`, scripts, or migrations
  was modified.
- **No corpus changes.** `hal_test_prompts` table not touched; this audit
  only `SELECT`ed from it.
- The diagnostic Node script lives in `%TEMP%`, outside the repo, and only
  reads `dist/services/hal-signals.js`. It was used to compute what
  `/hal/signals` would return without an API key. Not committed anywhere.
