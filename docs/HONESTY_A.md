# Honesty A

Last 7 days, counts of TRUE / FALSE / NOT_CHECKED by model family and host.

Host is the provider name on `hal_quorum_validator_votes`. That is the row fact-check's quorum writer stores (`family`, `provider`, `verdict`). The writer is default off (`HAL_QUORUM_RECEIPT_ENABLED`).

`llm_call_log` has no verdict column. It has provider, model, latency, status, and task hint. Those are not TRUE / FALSE / NOT_CHECKED. This count does not use that table and does not turn latency into a verdict.

The payload field `writer_enabled` is true only when `HAL_QUORUM_RECEIPT_ENABLED` is the exact string `true`. Unset is false. This report does not turn the writer on.

`GET /api/v1/hal/honesty-a` reads only `family`, `provider`, and `verdict`. The payload has no prompt and no user id. A failed read, or a page that hits the 1000-row cap, is `status: NOT_CHECKED` with `rows: null`. An empty successful read is a counted empty list, which is a different fact.
