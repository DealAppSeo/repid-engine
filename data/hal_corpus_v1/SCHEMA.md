# HAL Corpus Schema Specification (v1)

This specification defines the JSONL row structure for the hallucination-detection ground-truth corpus. All labels, their meanings, and the definition of truth are strictly Sean's decision; this schema does not define or enforce any labeling policies.

## Row Format Fields

Every line in the JSONL corpus must represent a single JSON object containing the following fields:

- `id`: A unique string identifier to track and reference individual corpus items across splits and evaluations.
- `prompt`: The input instruction or query supplied to the model being evaluated for hallucinations.
- `candidate_answer`: The model's generated response being evaluated for truthfulness or compliance.
- `label`: A string restricted to `TRUE`, `FALSE`, or `ABSTAIN` representing the ground-truth verdict.
- `category`: A string indicating the domain or task category of the prompt for stratified analysis.
- `source_url`: A reference URL pointing to the authoritative documentation or context used to verify the candidate answer.
- `source_retrieved_at`: An ISO-8601 timestamp representing when the verification source was last accessed.
- `notes`: Descriptive notes or human auditor rationale clarifying specific decisions or context for the entry.
- `split`: A string restricted to `train` or `holdout` designating the partition of the dataset for validation.

## Enforced gates

The validator rejects a corpus outright — it does not warn — when any of these fail.
They are the reason the hash is worth anything.

### 1. Provenance
`source_url` must be an absolute `http`/`https` URL. A row nobody can trace is not
evidence; it is an assertion wearing evidence's clothes. This has bitten before: an
agent once produced 162 "independent" examples that were all self-generated under one
label. The placeholder used by `example.jsonl` is rejected **by name**, so the format
example can never become a real corpus by renaming the file.

### 2. No holdout leak
The same `prompt` + `candidate_answer` pair may not appear in both `train` and
`holdout`. Distinct `id`s are not distinct content, and a holdout that overlaps train
measures recall of the training set while reporting itself as accuracy.

The same `prompt` with a *different* `candidate_answer` is explicitly allowed — one
correct and one hallucinated answer to the same question is a useful contrast pair.

### 3. Determinism
Rows are canonicalised (keys sorted recursively) and sorted by `id` before hashing, so
the hash depends on content alone — not on row order, key order, or whitespace. Change
one label and the hash changes.

## Why this exists

HAL's F1 has been quoted at 0.34, 0.74, 0.886 and 0.890. Those are four different
rulers reported as one scale, which is why none of them settles anything. Every future
measurement should be stated as **"F1 = x on corpus v1 @ `<hash>` at N families"** —
a number without that qualifier is not comparable to any other number.

The gates are covered by `tests/corpus-rack.test.ts`, which runs this validator as a
subprocess the same way CI does.
