# Re-skin invariance on the canary corpus — HAL strictness 1

**Run 2026-08-17.** Phase 2 of `docs/RSI-ADOPTION-PLAN.md` §3.4, the one item needing
neither a live fleet nor provider keys.

    RULER: corpus canary-corpus-v1.1@sha256:839ce3ed8515 (47 cases)
         | strictness 1 (deterministic extractor, NO cross-LLM)
         | certainty held at 0.9
         | transforms reskin-v1

Reproduce: `npm run hal:reskin`. Pure functions, no network, no database, exactly
reproducible.

---

## What was asked

Re-render each claim in ways that **cannot change whether it is true**, re-run HAL, and
see whether the verdict moves. Movement is the instrument reading the typography rather
than the claim.

## Headline

**Strictness 1 is NOT invariant. Three verdict flips under truth-preserving re-renders,
all of them clean → VETO.** Largest score drift on a single claim: **0.0355**, against a
veto threshold of 0.25.

**Strictness 2 — the cross-LLM quorum, which is the production veto path — is
NOT_CHECKED.** It needs live provider keys, which this environment does not have. A
strictness-1 result says nothing about it. Do not extrapolate; the harness prints that
row as NOT_CHECKED rather than guessing.

| transform | N | flips | →veto | mean\|Δ\| | max\|Δ\| |
|---|---:|---:|---:|---:|---:|
| terminal-period | 47 | 0 | 0 | 0.000000 | 0.000000 |
| typographic-punctuation | 3 | 0 | 0 | 0.000000 | 0.000000 |
| percent-to-word | 1 | 0 | 0 | 0.002027 | 0.002027 |
| digit-grouping | 2 | 0 | 0 | 0.000000 | 0.000000 |
| initial-lowercase | 47 | 0 | 0 | 0.004529 | 0.030409 |
| full-lowercase | 47 | **1** | 1 | 0.012940 | 0.030409 |
| contentless-prefix | 47 | **2** | 2 | 0.012996 | 0.035478 |

Negative control (`identity`): **CLEAN** — 0 flips, 0 drift. The harness refuses to
report anything if the no-op moves the score.

**Genuinely invariant, and worth saying:** terminal punctuation, typographic quotes and
dashes, and digit grouping move **nothing**. Those are real robustness properties.

---

## Finding 1 — `hasProperNouns` partly measures sentence position, not proper nouns

The detector is `\b[A-Z][a-z]{2,}(\s[A-Z][a-z]{2,})+` (`src/hal/lib/extract.ts:88`), and it
requires **two or more** consecutive capitalised words. So sentence-initial `"The Earth"`
matches — on the strength of `The` being capitalised because it starts the sentence.

Measured on the corpus: the proper-noun signal fires on **20 of 47** claims, and **7 of
those 20** lose it when *only the first letter* is lowercased. For a third of the cases
where it fires, this signal is reading sentence position.

Verified directly:

| text | fires? | matched |
|---|---|---|
| `The Earth revolves around the Sun.` | yes | `The Earth` |
| `the Earth revolves around the Sun.` | no | — |
| `The quick answer is here.` | no | — |

The consequence is Finding 2's flip: proper-noun presence is weighted into
`evidence_quality`, so losing it raises measured hallucination risk.

## Finding 2 — the same claim, lowercased, becomes a veto

    "The Empire State Building is struck by lightning approximately 20-25 times per year."
      hal_score 0.2399  → clean
    "the empire state building is struck by lightning approximately 20-25 times per year."
      hal_score 0.2703  → VETOED     (threshold 0.25)

`evidence_quality` falls 0.53 → 0.38 — exactly the proper-noun term. Identical claim,
identical truth value, different capitalisation, opposite verdict.

## Finding 3 — padding a claim with words that assert nothing changes its verdict

`contentless-prefix` prepends `"It is the case that "` — five words containing no hedge,
no overconfidence marker, and no factual content (this is machine-checked, see below).

    "The human nose can detect approximately 1 trillion different scents."
      hal_score 0.2483  → clean
    "It is the case that the human nose can detect approximately 1 trillion different scents."
      hal_score 0.2788  → VETOED

**Two opposing surface effects, and this is the methodologically important part:**

- `lengthScore = min(1, wordCount/40)` feeds `evidence_quality`, so **padding raises
  measured evidence quality** — it *lowers* risk. Here evidence went 0.35 → 0.40.
- `hedgeDensity = hedgeCount / max(wordCount/8, 1)` is **normalised by word count**, so
  padding *dilutes* hedge density. A hedged claim ("approximately") reads as **less
  hedged**, which the extractor treats as overconfidence — it *raises* risk.

On this corpus the second effect wins on the flipped cases while the two roughly cancel
in the aggregate: mean **signed** drift is −0.0023, near zero, while individual claims
move by up to ±0.0355 and three verdicts flip.

**A mean would have hidden this entirely.** That is the plan's "profile, not scalar"
argument (§2.4) arriving as a measured fact rather than a principle.

## Isolating the length term

`contentless-prefix` is exactly `initial-lowercase` plus the padding — a composition
pinned by a test, so the subtraction is valid:

| | mean \|Δscore\| | flips |
|---|---:|---:|
| initial-lowercase alone | 0.004529 | 0 |
| + 5 contentless words | 0.012996 | 2 |
| **attributable to length** | **0.008467** | |

---

## Why the probe is trustworthy

The finding only holds if the transforms really cannot change the truth value, so that is
tested rather than asserted (`tests/reskin.test.ts`, 15 tests):

- **Marker neutrality** — no transform adds or removes any overconfidence marker, hedge,
  or injection marker, checked across every transform × every claim, matched the way HAL
  matches them. Without this, movement could be a *correct* measurement of a real style
  change, and the finding would be worthless.
- **Negative control** — `identity` moves nothing.
- **Determinism** — every transform is a pure function, checked twice per claim.
- **Composition** — `contentless-prefix ≡ "It is the case that " + initial-lowercase`,
  which the factorial subtraction above depends on.

**The marker-neutrality test earned its place immediately.** It caught that `'100%'` is a
*literal* entry in `OVERCONFIDENCE_MARKERS` and markers match by substring — so rewriting
`"100%"` to `"100 percent"` would have silently **deleted an overconfidence marker**. The
transform now leaves such text alone. Found by testing the property, not by reading the
list.

## Scope, and what was deliberately not done

- **Not fixed.** `src/hal/lib/extract.ts` states that behaviour tuning there is forbidden
  and that a 369-assertion regression test holds the line. These are findings about a
  production signal path; changing it is a separate decision and needs its own GO
  (CLAUDE-RULE-2, CLAUDE-RULE-3).
- **Transforms are mechanical, never model-generated.** An LLM paraphrase would make a
  changed verdict ambiguous between "HAL is surface-sensitive" (the finding) and "the
  paraphrase changed the meaning" (an artifact), destroying the measurement.
- **Caveat carried from the code:** `src/hal/lib/score.ts` records in its own comments
  that the strictness-1 extractor is **non-discriminative** — it does not separate true
  claims from false ones. So this measures the stability of an instrument already known
  not to discriminate. That makes the result sharper, not weaker: an extractor that
  neither separates true from false nor holds still under re-rendering is substantially
  scoring writing style.

## What this does not license

It does **not** say production HAL flips verdicts on capitalisation. Production veto runs
strictness 2, and that is NOT_CHECKED here. The obvious next measurement — the same
corpus, the same transforms, the real quorum — needs provider keys and is the one that
would describe production behaviour.
