# T12 belt

Heartbeat stays a SQL write. This belt does not replace that write and does not call a model host.

`T12_FREE_WAVE` is on only when it is the exact string `true`. The order is then local, then groq,
then cerebras. **Local joins only when `T12_LOCAL_BASE_URL` is a loopback host** (`127.0.0.1`,
`localhost`, `::1`); a remote base is never treated as local. Send a local host no key.
**Not `LOCAL_LLM_BASE_URL`:** that one is process-wide and would also move the HAL quorum and
the contract validator onto the local box. The groq and cerebras steps must call each
provider's real endpoint, not one rewritten by `resolveProviderEndpoint`.

**A 429 stops the wave.** No further host is tried after a rate limit, and the caller must wait
(the host's `Retry-After`, when given, comes back as `retryAfterMs`) before the next wave. Any
other failure tries the next host. Nothing answering is `NOT_CHECKED`, never a pass, and
"answered" means a 2xx, not a checked result: the caller validates the body.

The status check for this belt is:

```
trustshell status
```

Do not call Anthropic from this belt.

## The call (`src/orchestration/t12-attempt.ts`)

`t12Ask(prompt)` runs the wave for real, one host at a time, through `providerFetch`:

| step | URL | key |
|---|---|---|
| local | `<T12_LOCAL_BASE_URL>/chat/completions` (loopback only; model `T12_LOCAL_MODEL`, default `local`) | **none** |
| groq | `PROVIDER_URLS.groqChatCompletions` | `GROQ_API_KEY`, only to groq |
| cerebras | `PROVIDER_URLS.cerebrasChatCompletions` | `CEREBRAS_API_KEY`, only to cerebras |

- The cloud steps use the registry URL directly, never `resolveProviderEndpoint`, so the
  process-wide `LOCAL_LLM_BASE_URL` cannot redirect them (a test pins it).
- `ONLY_ATTESTATIONS_LEAVE` is asserted before each call; under it a cloud step is refused
  before any byte leaves and the wave moves on.
- An answer is a 2xx with non-empty `choices[0].message.content`. An empty or unparseable 2xx
  is treated as a failure, so the wave tries the next host.
- The boundary is on if ANY source says so (the `boundaryOn` option, the env passed in, or the
  process env); a caller can only tighten it, never switch a node's boundary off.
- 20 s timeout per host, so a full wave can take up to ~60 s. `Retry-After` is capped at 1 h.
- It makes no call unless `T12_FREE_WAVE` is exactly `true`. This line used to say nothing calls it; the B21 runner job and the coding lanes below both do.

## Coding lanes (`src/orchestration/t12-lane-*.ts`, off by default)

Claim, make, independently check, integrate, refill, on `trinity_tasks` with no new table.

- **Rows.** `assigned_to = trinity-t12-lanes`, so the fleet's claim skips them. Making is `claimed`; everything after is `pending_validation`, with the real stage in `metadata.t12.stage`. The RepID bridge polls `done`, `verified` and `shadow_reject` with no pool filter, and a lane row never enters those. Once the worker role is applied, its row policy refuses those statuses and it cannot write `result` at all, so this holds against a compromised worker too.
- **Leases.** `expires_at`, renewed by heartbeat, freed by the `trinity_reap_expired_claims` cron. `metadata.t12.epoch` is the fencing token, so a worker that lost its lease cannot write.
- **Path locks.** Exact files, held from claim until the check passes, decided under one advisory lock.
- **Check.** A different lane re-runs the test in a fresh checkout. The test must then fail when the code change is reverted and when each break the task names is applied to the code under test. The verdict is `same_controller_rerun`: controls are only as strong as the breaks a task names, so a human still judges the test. `final_verdict` stays `unverified`, because a re-run by the same controller is not a second voice.
- **Integrate.** A draft PR at most. A human merges. `HIGH` risk is never published. Postgres accepts only this task's own branch and full object ids, and the checker and publisher check them again, so a row cannot name `main`. A publisher that refuses a row ends the task.
- **Receipts.** Each decision appends to a hash chain in `metadata.t12.receipts`, in the same transaction as the state change.
- **Belts.** A lane needs a live belt for this task and this claim before it can submit, and a denied belt never reaches a model. The grant is a `principal_grants` row minted by `t12_belt_checkout`. Postgres enforces it through the worker role's row policy, and that role has no privilege on the grants or on the denial log in `trinity_agent_logs`. Engineering covers `src/`, `tests/`, `test/`, `lib/` and `docs/`. Research covers `reports/` and `docs/`. It does not gate model calls, because the worker holds its free provider keys. Maker and checker share one database role, so a compromised worker could still forge a verdict on work already submitted. The human merge is the gate for that.
- **Cost.** The only model path is `t12Ask` on the free routes in `T12_ROUTES`. Each claim asks at most two hosts, and `DAILY_CLAIM_CAP` limits claims per day. The restricted worker refuses `OPENROUTER_API_KEY`: that account holds paid credit and the price cap is only in the request body, so code calling the host directly could spend. Its route stays in the table but no restricted worker can use it.

Run once with `scripts/t12/lanes.ts`. Nothing schedules it. `T12_LANES_ENABLED`, `T12_LANES_ALLOW_EXEC` and `T12_LANES_PUBLISH` are each off unless exactly `true`.

**`T12_LANES_ALLOW_EXEC` runs model-written code.** The child gets a stripped environment and no install scripts, but that is not a sandbox: set it only on an ephemeral runner holding no secrets.

`tests/t12-lanes.test.ts` needs a real Postgres for its store block and reports that block as skipped without one. The variable it reads is named at the top of that block; point it at a throwaway database.
