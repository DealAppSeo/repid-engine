# DRAFT for Sean: what counts as "the Grok vote" in D-161 when a different model family reviews

Status: **draft, not entered in DECISIONS.md, and the merge rule is unchanged.** The wording is Sean's call (CLAUDE_RULES r31, D-161). Nothing in the review lane's code decides it: the loop only posts comment reviews and records which reviewer wrote each one.

## The problem

D-161 closes a LOW or MEDIUM merge only when Claude, Grok and Strix agree on one head SHA with CI green. Grok's usage balance has been empty since at least 2026-11-16 (HTTP 402 "Grok Build usage balance exhausted", four runs, the last at 2026-11-17T13:20Z). While it is empty, the Grok condition can never be met, so every auto-merge waits for Sean.

The review lane now falls back: Grok, then other model families (see REVIEW_CHAIN_MEASUREMENT.md for the order and the measurements). A fallback review is a comment on the PR, pinned to the commit, headed with the reviewer's name and the words "This is not a Grok review". The merge ledger can name the reviewer.

## What was measured, and what was not

- Each non-Grok reviewer was run on 24 planted-defect cases (12 with one planted defect, 12 clean twins), graded by the same six-item checklist and quote check Grok's answers go through. Numbers, corpus hash and the number of families are in REVIEW_CHAIN_MEASUREMENT.md.
- **Grok could not be run on the same cases** (402), so there is no head-to-head. Nothing here says a fallback reviewer is as good as Grok.
- Cells are small (under 30 runs), so no order between reviewers is a finding.
- "False alarm" means flagged where no defect was planted. Whether a flag was a real unplanted weakness was not adjudicated.

## Options

**A. Keep it literal.** "Grok vote" means Grok. A fallback review is advice only. With Grok unfunded, LOW and MEDIUM PRs wait for Sean. Safest; the lane's fallback then only gives Sean a second opinion to read.

**B. Name the substitute (recommended).** Replace "GrokCode's fenced review ACCEPTED" with "the review lane's vote":
- LOW: Grok, or, when Grok returned NOT_CHECKED or failed on that SHA, one fallback reviewer whose answer on the same head SHA is a usable PASS.
- MEDIUM: Grok, or two fallback reviewers from two different families, both PASS on the same head SHA.
- A NOT_CHECKED, a failure, a CHANGES_REQUESTED, or a review on another SHA is no vote. Any CHANGES_REQUESTED from any reviewer blocks, as a Grok one does today.
- Unchanged: Claude's review, Strix, all CI green, the SHA pin, the MAJOR list (money, personal or medical records, on-chain, keys, schema, infra, publish, irreversible), "unsure = one level up".
- The merge-ledger line records the reviewer ids and families (`reviewers`), not "Grok".

**C. Two families always.** Even with Grok funded, require two independent non-Claude families. Strongest; it costs more waiting, and Grok would no longer be special.

## Recommendation

B. The author lanes are Claude, so independence from Claude is what the vote buys, and the chain reviews from three non-Claude families. The check that makes a fallback answer count is the same machine check Grok's answer faces (quotes copied from the files, verdict derived from the items), not the model's say-so. Re-measure before relying on it: the table is small, and the corpus is synthetic.

## Entry to paste if B is chosen (edit freely)

> **D-NNN (date): the "Grok vote" in D-161 may be filled by the review lane's fallback reviewers [Sean].** When Grok cannot answer on a head SHA (402, timeout, unusable reply), LOW needs one fallback reviewer with a usable PASS on that SHA, and MEDIUM needs two different families with a usable PASS on that SHA. NOT_CHECKED and failures are no vote; any CHANGES_REQUESTED blocks. Everything else in D-161 is unchanged. The merge-ledger line names the reviewers. Basis: planted-defect measurement REVIEW_CHAIN_MEASUREMENT.md (corpus hash, n, families); Grok itself was not measurable (402). Rollback: restore "GrokCode ACCEPTED" as written in D-161.
