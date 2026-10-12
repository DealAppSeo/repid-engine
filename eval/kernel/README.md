# Policy-kernel known-answer table

`known-answers.jsonl` is the **seed, the canary and the holdout** for the policy
kernel's verification leg, in one hash-only file. Sean's spec, verbatim:

> "Table is hash, label, checker pair, date. Trick questions and pinned
> benchmarks only. No sentence. It is the seed, the canary, and the holdout."

**No sentence is a hard rule.** The plaintext question/claim text NEVER appears in
this repo. Each row carries the *hash* of a question, never the question. The table
can therefore be read by anyone — it is in a PUBLIC repo — and still reveal nothing
that lets a checker (or a model trained on this repo) memorise or game the answers.

Authored by XC1, `2026-10-12`, for the policy-kernel sprint (branch
`claude/bold-turing-icz50x-kernel`). It is the red-team / known-answer lane's
artifact; it does not import or depend on the kernel code, and its integrity test
(`tests/kernel/known-answers-table.test.ts`) runs standalone.

## Row schema

One JSON object per line. EXACTLY these five fields, no more, no fewer:

| field | type | meaning |
|---|---|---|
| `hash` | string, 64 lowercase hex | sha256 of the *canonicalized* plaintext question/claim. The only representation of the question that lives in the repo. |
| `label` | enum (below) | the ground-truth verdict the verification leg should reach for this claim. |
| `checker_pair` | 2-element array of distinct family ids | the two checker FAMILIES that must agree on this row ("two families on the claim"). |
| `date` | `YYYY-MM-DD` | the date this row was authored / last re-pinned. All rows here: `2026-10-12`. |
| `role` | enum `seed` / `canary` / `holdout` | how the row is used (below). |

No field holds anything sentence-like: every string value is free of whitespace and
at most 64 characters. That is a mechanical invariant the integrity test proves (it
is how "no sentence" is enforced, not merely promised).

## Canonicalization used for `hash`

The plaintext question is reduced to a canonical form before hashing, so that
trivial formatting differences (trailing space, double spaces, case, Unicode
composition) do not change the hash:

```
canonical = plaintext
  .normalize('NFC')       // Unicode canonical composition
  .trim()                 // strip leading/trailing whitespace
  .replace(/\s+/g, ' ')   // collapse internal whitespace runs to one ASCII space
  .toLowerCase()          // case-fold
hash = sha256_hex(utf8(canonical))   // lowercase hex
```

An eval harness that is given the off-repo plaintext (below) must apply this exact
canonicalization before looking a row up, or the hash will not match.

## `label` enum — and how it maps to the kernel's own vocabulary

`label` is the ground truth about the CLAIM, from a three-value enum:

| `label` | meaning | kernel mapping |
|---|---|---|
| `TRUE` | the claim is true; a correct quorum converges TRUE | fact-check agreement verdict `TRUE` → HAL `PASS` → receipt `verification.status: VERIFIED` |
| `FALSE` | the claim is false; a correct quorum converges FALSE | fact-check agreement verdict `FALSE` → HAL `VETO` → receipt `verification.status: FAILED` |
| `UNVERIFIABLE` | the claim has no settleable ground truth (future / unknowable / unstable) | no family quorum should form → HAL `ABSTAIN` → receipt `verification.status: NOT_CHECKED` |

**`UNVERIFIABLE` is `NOT_CHECKED`, which BLOCKS — it is never a pass.** This is the
"three outcomes, never two" rule made concrete: a claim with no settleable answer
must not be waved through as if it were TRUE. A checker that returns a confident
TRUE/FALSE on an `UNVERIFIABLE` row has failed the row, not passed it.

### Why this enum and not the per-vote vocabulary

The kernel has two nearby vocabularies, read directly from CC1's branch:

- per-vote: `votes[].verdict` is `PASS | FAIL | ABSTAIN`
  (`src/kernel/types.ts`, `src/kernel/schema/kernel-receipt.v1.json`);
- claim-level fact-check: agreement verdicts are `TRUE | FALSE`
  (`isAgreementVerdict` in `src/hal/fact-check.ts`).

A known-answer table pins the ground truth of the CLAIM, not one checker's vote, so
the claim-level `TRUE | FALSE` vocabulary is the right one, extended with
`UNVERIFIABLE` for claims that have no settleable truth (where a per-vote `ABSTAIN`
is the correct checker behaviour). Using `PASS/FAIL/ABSTAIN` would conflate "this
checker abstained" with "this claim is unanswerable", which are different facts. The
existing `eval/canary/*.jsonl` corpus already labels claims `TRUE`/`FALSE`, so this
enum is consistent with the repo's prior art as well.

## `checker_pair` — the two families

Each row names two distinct checker **families** that must agree on it. The family
ids are the real §7 disjointness families from
`src/decisioning/family-registry.ts` (`KNOWN_FAMILIES`), plus `grok`, the
independent tiebreak family HAL folds into its quorum (`src/hal/fact-check.ts`):

```
deepseek  llama  glm  kimi  gemini  mistral  qwen  openai  anthropic  grok
```

"Two families agree" is exactly the kernel/HAL quorum property: a claim is only
settled when at least two INDEPENDENT families (not two providers of one family)
converge. A row therefore names which two families the harness should require
agreement from for that claim; family-disjointness is a hard rule, so the pair is
always two distinct families.

## Roles — seed / canary / holdout

| role | count | how it is used |
|---|---|---|
| `seed` | 8 | **Calibrate.** Used to tune / sanity-check the verification leg: thresholds, the two-family agreement rule, prompt wiring. A seed row MAY be looked at while tuning. |
| `canary` | 8 | **Detect drift, continuously.** Re-run on every build / on a schedule. A canary that flips its verdict (or a checker that starts disagreeing with a settled benchmark) is an alarm that a model, a provider, or a prompt changed under us. Canaries are stable benchmarks whose answer should never move. |
| `holdout` | 6 | **Final eval only. NEVER used for tuning.** The holdout is the honest score: it is never consulted while calibrating, so a good holdout number cannot have been fitted. It carries the hardest trick questions and the `UNVERIFIABLE` rows. If a holdout row is ever used to tune, it is burned and must be replaced. |

The split follows Sean's "seed, canary, holdout" naming and the standard discipline:
seed may be fit, canary watches for drift, holdout is the untouched final measure.

## Content: trick questions and pinned benchmarks only

Per spec, the table holds only two kinds of row:

- **Trick questions** — claims engineered to fool a single checker: true-sounding
  falsehoods, false-sounding truths, adversarial paraphrases, and unit/number traps.
  These are where a lone checker is most likely to be wrong, which is why the
  two-family agreement rule has to carry them.
- **Pinned benchmarks** — claims with a settled, stable ground truth that should
  never change (used mostly as canaries).

## WHERE THE PLAINTEXT LIVES — and what running the full eval requires

The plaintext questions behind these hashes are **OFF-REPO**. They are held by XC1
/ the operator and are supplied to the eval harness at eval time; they are never
committed anywhere in this repository or any sibling repo.

- This repo stores only `hash + label + checker_pair + date + role`.
- The generator that holds the plaintext and emits this file is kept off-repo (XC1's
  session scratchpad at authoring time, then by the operator).
- **Running the full known-answer eval requires that off-repo plaintext.** Without
  it, a harness can verify the table's integrity (shape, uniqueness, enums, "no
  sentence") but cannot score a checker against it, because it has no questions to
  ask. That is by design: the table is the seed, the canary and the holdout, and a
  holdout you can read is not a holdout.

If the plaintext is lost, the hashes cannot be reversed; the table is then only a
record of labels/roles and must be re-pinned from a fresh plaintext set (new `date`).

## Integrity test

`tests/kernel/known-answers-table.test.ts` runs under the repo's normal jest config
(`npm test`), does NOT import the kernel, and asserts the schema, 64-hex hashes,
uniqueness, enum membership, two distinct families per pair, and — mechanically —
that no field contains a sentence. It also runs the same validator over deliberately
broken fixture rows and asserts each is REJECTED, so a green run is evidence the test
can fail, not just that it ran.
