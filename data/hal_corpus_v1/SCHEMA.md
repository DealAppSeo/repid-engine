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
