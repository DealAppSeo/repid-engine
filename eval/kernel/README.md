# Policy-kernel known-answer table

`known-answers.jsonl` is the **seed, the canary and the holdout** for the policy
kernel's verification leg, in one hash-only file. Sean's spec, verbatim:

> "Table is hash, label, checker pair, date. Trick questions and pinned
> benchmarks only. No sentence. It is the seed, the canary, and the holdout."

**No sentence is a hard rule.** The plaintext question/claim text NEVER appears in
this repo. Each row carries a *keyed* digest of a question, never the question. The
digest is an HMAC under an off-repo pepper (see "The hash is KEYED" below), so — and
**only** so — the table can be read by anyone in this PUBLIC repo and still reveal
nothing that lets a checker (or a model trained on this repo) memorise or game the
answers. A plain unkeyed SHA-256 of these low-entropy claims would NOT give that
guarantee: it is dictionary-reversible. The guarantee is the pepper, not the hashing.

Authored by XC1, `2026-10-12`, for the policy-kernel sprint (branch
`claude/bold-turing-icz50x-kernel`). It is the red-team / known-answer lane's
artifact; it does not import or depend on the kernel code, and its integrity test
(`tests/kernel/known-answers-table.test.ts`) runs standalone.

## Row schema

One JSON object per line. EXACTLY these five fields, no more, no fewer:

| field | type | meaning |
|---|---|---|
| `hash` | string, 64 lowercase hex | **keyed** HMAC-SHA256 of the *canonicalized* plaintext question/claim, under an off-repo pepper (see below). The only representation of the question that lives in the repo, and irreversible without the pepper. |
| `label` | enum (below) | the ground-truth verdict the verification leg should reach for this claim. |
| `checker_pair` | 2-element array of distinct family ids | the two checker FAMILIES that must agree on this row ("two families on the claim"). |
| `date` | `YYYY-MM-DD` | the date this row was authored / last re-pinned. All rows here: `2026-10-12`. |
| `role` | enum `seed` / `canary` / `holdout` | how the row is used (below). |

No field holds anything sentence-like: every string value is free of whitespace and
at most 64 characters. That is a mechanical invariant the integrity test proves (it
is how "no sentence" is enforced, not merely promised).

## The hash is KEYED (HMAC) — and why plain SHA-256 would not do

**This matters, and the first version of this file got it wrong.** The plaintext
questions are low-entropy, well-known claims, and the canonicalization below is
public. A plain `sha256(canonical)` over that space is **dictionary-reversible**: an
attacker enumerates likely claims, canonicalizes and hashes each, and matches the
digest — recovering the question and, with it, the row's `label` and `checker_pair`.
That defeats the whole point of a hash-only holdout. (Flagged as CWE-759 — a one-way
hash without a salt — by Strix on PR #1318; the finding was correct.)

So the digest is **keyed** with a high-entropy secret pepper that lives off-repo.
Without the pepper, enumerating candidate plaintexts tells you nothing: you cannot
compute a row's digest, so you cannot match it.

The plaintext question is first reduced to a canonical form, so that trivial
formatting differences (trailing space, double spaces, case, Unicode composition) do
not change the hash:

```
canonical = plaintext
  .normalize('NFC')       // Unicode canonical composition
  .trim()                 // strip leading/trailing whitespace
  .replace(/\s+/g, ' ')   // collapse internal whitespace runs to one ASCII space
  .toLowerCase()          // case-fold
hash = HMAC_SHA256_hex(key = OFF_REPO_PEPPER, message = utf8(canonical))   // lowercase hex
```

`OFF_REPO_PEPPER` is a high-entropy secret (>= 32 bytes) held **off-repo** — in the
generator's environment, with the operator, or as a CI secret — and is **NEVER
committed** to this (public) repository: not in `known-answers.jsonl`, not here, not
in the test, not anywhere. The irreversibility of this table rests entirely on the
pepper staying off-repo. An eval harness must be given BOTH the off-repo plaintext
AND the pepper, apply the exact canonicalization, then HMAC under the pepper, or the
digest will not match.

HMAC-SHA256's hex digest is still 64 lowercase hex, so the row shape and the
integrity test are unchanged by the switch from plain SHA-256 to the keyed hash.

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
| `seed` | 18 | **Calibrate.** Used to tune / sanity-check the verification leg: thresholds, the two-family agreement rule, prompt wiring. A seed row MAY be looked at while tuning. |
| `canary` | 18 | **Detect drift, continuously.** Re-run on every build / on a schedule. A canary that flips its verdict (or a checker that starts disagreeing with a settled benchmark) is an alarm that a model, a provider, or a prompt changed under us. Canaries are stable benchmarks whose answer should never move. |
| `holdout` | 18 | **Final eval only. NEVER used for tuning.** The holdout is the honest score: it is never consulted while calibrating, so a good holdout number cannot have been fitted. It carries the hardest trick questions and the `UNVERIFIABLE` rows. If a holdout row is ever used to tune, it is burned and must be replaced. |

The split follows Sean's "seed, canary, holdout" naming and the standard discipline:
seed may be fit, canary watches for drift, holdout is the untouched final measure.

## Night-sprint extension (2026-10-12): the stranger-path surface

The first 22 rows are general trivia. The extension (+32, now 54) pins the claim shapes a
stranger actually types into `check` and that the kernel's fail-closed invariants depend on.
At the level of categories only, because the claims themselves are never committed:

- **Arithmetic, float and unit traps** — the shapes behind a spend limit: floating-point
  comparison semantics (including NaN), integer-precision limits, token base-unit and chain-id
  facts, percent round-trips, near-miss products.
- **Input-shape traps** — a claim that begins with `-` (a CLI parser can mistake it for a flag);
  a claim that is an instruction rather than a proposition (prompt-injection shaped).
- **`UNVERIFIABLE` (must read `NOT_CHECKED`, which blocks a spend and a post)** — future events,
  facts about a private wallet or a counterparty's future behaviour, and a self-referential
  statement. 9 of the 54 rows (the first 22 hold 3 of them).

**What a row cannot express.** A secret-shaped input is *refused before it is checked*, so it has
no ground-truth label and no row; the `label` enum has no `REFUSE`. That behaviour is exercised by
the red-team probes, not by this table, and adding a fourth label would be a contract change
(the kernel mapping above, and the integrity test's enum, would both move). Recorded here so the
absence is a stated decision rather than a silent gap.

**One pepper for the whole table.** The 32 new digests are keyed with the same off-repo pepper as
the first 22 (checked by regenerating the original 22 and confirming they are byte-identical to
what was merged). Rotating the pepper re-keys every row; there is no per-batch key.

## Content: trick questions and pinned benchmarks only

Per spec, the table holds only two kinds of row:

- **Trick questions** — claims engineered to fool a single checker: true-sounding
  falsehoods, false-sounding truths, adversarial paraphrases, and unit/number traps.
  These are where a lone checker is most likely to be wrong, which is why the
  two-family agreement rule has to carry them.
- **Pinned benchmarks** — claims with a settled, stable ground truth that should
  never change (used mostly as canaries).

## WHERE THE PLAINTEXT AND THE PEPPER LIVE — and what running the full eval requires

TWO off-repo secrets back this table, and **neither is ever committed** anywhere in
this repository or any sibling repo:

1. **The plaintext questions** behind the digests.
2. **The pepper** (`OFF_REPO_PEPPER`), the HMAC key. It is a high-entropy secret and
   is what makes the digests irreversible; committing it to this PUBLIC repo would
   undo the entire fix. It lives in the generator's environment / with the operator /
   as a CI secret, and is supplied to the eval harness at eval time.

- This repo stores only `hash + label + checker_pair + date + role`. No plaintext, no
  pepper.
- The generator that holds the plaintext and reads the pepper is kept off-repo (XC1's
  session scratchpad at authoring time, then the operator / CI).
- **Running the full known-answer eval requires BOTH the off-repo plaintext AND the
  pepper.** Without them, a harness can verify the table's integrity (shape,
  uniqueness, enums, "no sentence") but cannot score a checker against it, because it
  can neither ask the questions nor recompute a digest. That is by design: the table
  is the seed, the canary and the holdout, and a holdout you can read is not a holdout.

If the pepper (or the plaintext) is lost, the digests cannot be reversed or
recomputed; the table is then only a record of labels/roles and must be re-pinned
from a fresh plaintext set under a fresh pepper (new `date`).

## Integrity test

`tests/kernel/known-answers-table.test.ts` runs under the repo's normal jest config
(`npm test`), does NOT import the kernel, and asserts the schema, 64-hex hashes,
uniqueness, enum membership, two distinct families per pair, and — mechanically —
that no field contains a sentence. It also runs the same validator over deliberately
broken fixture rows and asserts each is REJECTED, so a green run is evidence the test
can fail, not just that it ran.
