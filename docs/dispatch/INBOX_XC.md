# INBOX_XC — red-team two overnight PRs: the T12 call and the route-hint alias

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Deliverable is text. Do not claim to have created,
edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS workspace. No
evidence commands were run for you. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC1 (Claude) on 2026-10-03 under Sean's "GO overnight". This workspace merges
both PR branches so you can read them together; they ship as separate PRs (#1171, #1172).

### A. `src/orchestration/t12-attempt.ts` (#1171), with `src/orchestration/t12-free-wave.ts`

`t12Ask(prompt)` walks local → groq → cerebras through `providerFetch`. Read also
`src/egress/provider-fetch.ts`, `src/egress/provider-hosts.ts`, `src/selfhost/egress-guard.ts`,
`src/hal/local-llm.ts` (`resolveProviderEndpoint`), `src/jev/classify.ts` (`localModelUrl`).

1. **Key isolation.** Find any input (env values, a base URL, a redirect, a header) that makes a
   cloud key (`GROQ_API_KEY`, `CEREBRAS_API_KEY`) reach a host other than its own, or any key
   reach the local step.
2. **Egress boundary.** Under `ONLY_ATTESTATIONS_LEAVE`, can any byte of the prompt leave for a
   non-loopback host? Check where `assertPromptEgressAllowed` sits relative to `fetchImpl`.
3. **False answer.** Find a response that makes `t12Ask` return `outcome: 'answered'` with text
   the host did not actually answer, or `answered` on a failed call.
4. **429 / Retry-After.** Any header value that yields a negative, NaN or absurd `retryAfterMs`?
5. **Loopback.** Any `T12_LOCAL_BASE_URL` that passes `localModelUrl` but is not this machine?

### B. `src/routes/laya-classify.ts` (#1172)

6. `/api/v1/route-hint` is a second path to the existing pre-auth handler. Does mounting it
   widen anything (auth bypass list, rate limit, the SQL-keyword sanitizer in `src/index.ts`)?

Rank findings by failure direction: a leaked key or a fake answer first, a wrong NOT_CHECKED
last. Give file:line you actually read. Under 600 words. No key values or row-level data.
