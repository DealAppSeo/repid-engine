# Query profile — hot-path inventory and consolidation results

Snapshot date: 2026-04-28. Profiled against `feat/query-perf-2026-04-28`
branch of `repid-engine`. **No schema changes, no new endpoints.** All
work consolidates existing queries via `src/db/query-helpers.ts`.

## Hot paths inspected

| Service | File | Endpoints exercising it |
|---|---|---|
| Anonymous round runner | `src/services/anonymous-round-runner.ts` | `POST /api/v1/demo/run-round-anonymous` |
| Two-agent trader | `src/services/agent-trader.ts` | indirect (called by runner + cron) |
| Builder dashboard | `src/services/builder-dashboard.ts` | `GET /api/v1/builder/dashboard/:id` |
| Canonical writer | `src/services/erc8004-canonical-writer.ts` | indirect (called by round runner) |

## Findings — N+1 and serial-fetch patterns

### Finding 1 — `builder-dashboard.ts:99-106` agent trade count loop (FIXED)

**Before**

```ts
const tradeCountByAgent = new Map<string, number>();
for (const a of agents ?? []) {
  const { count } = await db
    .from('paper_trade_orders')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', a.id);
  tradeCountByAgent.set(a.id, Number(count ?? 0));
}
```

Cost shape: **N round-trips for N agents**. Every dashboard render
issues 1 + N queries against `paper_trade_orders`. A builder with 12
fleet agents pays 12 round-trips just for trade counts.

**After** — `tradeCountByAgent(db, agentIds)` from `src/db/query-helpers.ts`:

```ts
const agentIds = (agents ?? []).map(a => a.id);
const tradeCounts = await tradeCountByAgent(db, agentIds);
// ...
recent_trades_count: tradeCounts.get(a.id) ?? 0,
```

Cost shape: **1 round-trip total** (single `IN ()` filter + JS-side
grouping). Reduction: N → 1.

| Builder fleet size | Before | After | Reduction |
|---|---|---|---|
| 1 agent | 1 query | 1 query | — |
| 4 agents | 4 queries | 1 query | 75% |
| 12 agents (Trinity Symphony) | 12 queries | 1 query | 92% |

### Finding 2 — APM/VERITAS double-fetch (NOT touched — Gemini-adjacent)

`anonymous-round-runner.ts` calls `fetchAgent('APM')` + `fetchAgent('VERITAS')`
twice each (before + after the round) → **4 single-row queries** that
could collapse to 2 batched queries via `IN ('APM','VERITAS')`.

`agent-trader.ts:135-136, 257-258` does the same APM+VERITAS pattern
twice.

**Why not fixed in this sprint:** these files sit in the round-numbers
backend territory that the parallel Gemini sprint owns. Touching them
risks merge conflicts. The helper exists (`batchFetchBuilders` shows
the pattern) and the call-site swap is a one-line change a future PR
can pick up cleanly once round-numbers land.

### Finding 3 — `agent-trader.ts:227-238` resolveOpenRounds bet lookup (NOT touched — Gemini-adjacent)

```ts
for (const round of open ?? []) {
  const { data: bet } = await db.from('linked_bets')
    .select('prediction_payload')
    .eq('id', round.apm_bet_id)
    .maybeSingle();
  ...
}
```

Cost shape: **N round-trips for N open rounds** to load bet payloads.
A `latestRoundsForBuilder`-style consolidation against `linked_bets`
with `IN (...)` would cut this to 1.

**Why not fixed in this sprint:** same Gemini-adjacency reason. Helper
exists.

### Finding 4 — `erc8004-canonical-writer.ts:54-58` per-call agent lookup

Each `writeRepIDCanonical(name, repid)` call queries `repid_agents` for
`canonical_agent_id`. The round runner calls it twice (APM + VERITAS),
so two reads per round just to look up an immutable column.

**Mitigation strategy (deferred):** add a per-process LRU cache keyed
by `agent_name` since `canonical_agent_id` doesn't change. Outside this
sprint's scope (would need to coordinate with Gemini's round-numbers
work).

## Helpers shipped

`src/db/query-helpers.ts`:

- `batchFetchBuilders(db, ids)` — collapse N builder lookups to 1.
  Preserves request order; deduplicates input; drops missing IDs.
- `latestRoundsForBuilder(db, builderId, limit)` — 3 queries
  (agents → bets → rounds joined with `or()` filter) instead of an
  ad-hoc multi-step lookup chain.
- `canonicalWriteStatus(db, builderId)` — single combined fetch of
  `last_canonical_tx`, `last_canonical_status`, `agent_count`.
- `tradeCountByAgent(db, agentIds)` — bonus helper that fixed
  Finding 1; mirrors the spec's batch pattern.

## Timing

`src/utils/perf-timing.ts` exposes `timed({ service, op, builderId, extra }, fn)`.
Wraps a hot-path async function and emits one stdout line on completion:

```
[perf] service=builder-dashboard op=getBuilderDashboard duration_ms=128 builder_id=abcd-1234
```

Wired into:
- `getBuilderDashboard` (the only call-site changed in this sprint).

Future call-sites Sean can add the wrapper to: `runRoundAnonymous`,
`startTradingRound`, `resolveOpenRounds`, `writeRepIDCanonical`.

Greppable on Railway via `[perf]` prefix; field=value layout is
parseable with `awk` / `cut`.

## Tests

`tests/query-perf/query-helpers.test.ts` — 14 tests, all pass.
- Each helper's query count is asserted via a mock-db harness.
- Empty / missing inputs short-circuit without DB calls.
- Deduplication, ordering preservation, and multi-step short-circuits
  verified.

## Out of scope

- No schema changes, migrations, or new indexes.
- No EXPLAIN runs against live Supabase (deferred — would need a
  diagnostic.ts extension and credentials).
- No call-site swaps in services that overlap with the parallel
  Gemini round-numbers sprint (anonymous-round-runner, agent-trader).
