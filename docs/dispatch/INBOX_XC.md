# INBOX_XC: review the free-token circuit breaker (overnight 2026-11-01, item 0)

## Task

**Lane:** REVIEW. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, on this repository at
branch `overnight/2026-11-01-item0-free-token-breaker`. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC (Claude) on 2026-11-01, overnight run 1. This is the Grok review the overnight
merge rule requires; Claude may not stand in for it.

### What this branch adds (verify it, do not trust it)

1. `src/providers/free-token-breaker.ts`: `FreeTokenBreaker` with `admit(provider, model)` before
   a call and `record({provider, model, status, cost_usd})` after. Only an explicit zero price for
   that exact model in `src/billing/pricing.ts` (via `costClass` in `src/providers/cost-class.ts`)
   is ALLOW. Paid → DENY. Unpriced or missing input → NOT_CHECKED. `cost_usd > 0` → DENY.
   N consecutive quota refusals → DENY with no paid fallback. It latches.
2. `tests/free-token-breaker.test.ts`: 14 tests.
3. `docs/FREE_TOKEN_BREAKER.md`.
4. Nothing imports the module. It is a stub and is described as one.

### Your job

Read the three files. Answer each, with `file:line`:

1. Is there any input for which `admit` or `record` returns ALLOW for a call that is paid,
   unpriced, or whose cost is unknown? (Think: case of provider name, whitespace, a model name
   that matches a free entry under a different provider, `cost_usd` as a string, `-0`, Infinity.)
2. Can a caller get a paid fallback from any verdict? Does anything reset the latch?
3. Is any test unable to fail (vacuous)? Name it.
4. Does the doc or a comment claim more than the code does (for example, that a loop uses it)?

### Deliverable

Start with one line: `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES` or `VERDICT: NOT_CHECKED`.
Then findings, worst first, each with `file:line`, the input that breaks it, and the test that
would catch it. If you find nothing in a question, say NOT FOUND and say what you read, so a
reader can tell "none" from "not looked".
