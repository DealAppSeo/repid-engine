# Free-token circuit breaker

Overnight plan 2026-11-01, item 0. Code: `src/providers/free-token-breaker.ts`.
Tests: `tests/free-token-breaker.test.ts`.

**Status: STUB, NOT WIRED.** No router, dispatcher or loop imports it today, so it changes no
request. It proves the rule. It does not prove any loop obeys it. A loop that runs on free
tokens must call it before it is allowed to run long; wiring it in is a separate change.

## The rule

A loop meant to run on free tokens never spends money and never falls back to a paid model.

| Situation | Verdict |
|---|---|
| `(provider, model)` has an explicit `{in: 0, out: 0}` entry in `billing/pricing.ts` | ALLOW |
| The model is priced above zero | DENY |
| The model has no price entry, or provider/model is missing | NOT_CHECKED (treated as stop) |
| A recorded call billed `cost_usd > 0` (even if the table says free) | DENY |
| `cost_usd` missing, NaN or negative | NOT_CHECKED |
| N quota refusals in a row, any provider (default 3) | DENY: free tier exhausted |
| Call cap reached (default 500) | DENY |

Only `ALLOW` continues. There is no "try another provider" field on any verdict, so a caller
cannot use the breaker to pick a paid fallback.

A provider-level free label (`FREE_PROVIDERS`) does not count as free here. It cannot name
the model, and a model we have no price for may be billing us.

**It latches.** After the first trip every later `admit`/`record` returns the same verdict
and reason until a new breaker is built, which means a person restarts the loop.

## Use

```ts
const breaker = new FreeTokenBreaker({ maxCalls: 200 });
for (const task of tasks) {
  const gate = breaker.admit(provider, model);
  if (gate.decision !== 'ALLOW') { log(gate); break; }
  const r = await call(provider, model, task);
  const after = breaker.record({ provider, model, status: r.status, cost_usd: r.cost_usd });
  if (after.decision !== 'ALLOW') { log(after); break; }
}
```

`cost_usd` should come from the call's own ledger row (`llm_call_log.cost_usd`), not be
computed again from the price table. If it were, the receipt check would only repeat the
price check.

## Not the same as trustshell's `CircuitBreaker`

`trustshell/src/lib/circuit-breaker.ts` halts after N identical failures. It stops a loop
that is stuck. This one stops a loop that would spend money. A long loop should use both.
