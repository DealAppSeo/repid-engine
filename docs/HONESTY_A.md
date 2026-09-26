# Honesty A

Last 7 days, counts of TRUE / FALSE / NOT_CHECKED by model family and host.

Host is the provider name on `hal_quorum_validator_votes`. That is the row fact-check's quorum writer stores (`family`, `provider`, `verdict`). The writer is default off (`HAL_QUORUM_RECEIPT_ENABLED`).

`llm_call_log` has no verdict column. It has provider, model, latency, status, and task hint. Those are not TRUE / FALSE / NOT_CHECKED. This count does not use that table and does not turn latency into a verdict.

The payload field `writer_enabled` is true only when `HAL_QUORUM_RECEIPT_ENABLED` is the exact string `true`. Unset is false. This report does not turn the writer on.

`GET /api/v1/hal/honesty-a` reads `family`, `provider`, `host`, `verdict`, `first_pass_verdict`, and `post_hal_verdict`. The payload has no prompt and no user id. A failed read, or a page that hits the 1000-row cap, is `status: NOT_CHECKED` with `rows: null`. An empty successful read is a counted empty list, which is a different fact.

Each vote row also stores `first_pass_at` and `post_hal_at`. The first pass and the post-HAL verdict are counted apart: a TRUE first pass does not increment the post-HAL TRUE count. A missing first pass is NOT_CHECKED. It is not 0. A post-HAL value is not written unless the first pass is already TRUE or FALSE and has a timestamp.

The insert path runs only when `HAL_QUORUM_RECEIPT_ENABLED` is the exact string `true`. This page does not set that variable. The staged columns are in `migrations/2026-09-26-hal-vote-first-pass.sql` and are not applied by the change that added them. Until that DDL is applied, a live read that names the new columns comes back NOT_CHECKED rather than a partial count.
