# Monitoring Queries — Substrate Wake-Up

**Date:** 2026-05-12
**Branch:** `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12`
**Status:** Sprint 9 scaffolding. Run any of these in the Supabase SQL editor against project `qnnpjhlxljtqyigedwkb` during/after wake-up.

10 canonical queries. Each one answers a specific operator question. Each one is **read-only**.

---

## Query 1 — Recent score events (last hour)

> "What's actually moving on the substrate right now?"

```sql
SELECT
  e.created_at,
  a.agent_name,
  e.event_type,
  e.delta,
  e.repid_before,
  e.repid_after,
  e.metadata->>'source' AS source
FROM repid_score_events e
JOIN repid_agents a ON a.id = e.agent_id
WHERE e.created_at > now() - interval '1 hour'
ORDER BY e.created_at DESC
LIMIT 50;
```

Empty result → no scoring activity. RED on `probe-repid-scoring`.

---

## Query 2 — Spokesperson RepID + tier snapshot

> "Are the 4 real spokespersons still in their canonical states?"

```sql
SELECT id, agent_name, current_repid, tier, erc8004_address
FROM repid_agents
WHERE id IN (
  'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271',  -- SOPHIA
  'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067',  -- VERITAS
  '32e0e809-c1c4-4405-913f-135c8a2d6626',  -- SHOFET
  '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6'   -- CHESED
)
ORDER BY agent_name;
```

SOPHIA should be at 10,000 AUTONOMOUS (capped). Drift here = investigate.

---

## Query 3 — ZKP proof queue health

> "Is the ZKP pipeline draining?"

```sql
SELECT status, count(*) AS rows, max(created_at) AS most_recent
FROM repid_proof_queue
GROUP BY status
ORDER BY status;
```

`pending` row count growing without `completed` row count growing → pipeline stalled. Check `cb_disable_zkp_proofs`.

---

## Query 4 — HAL pipeline activity (24h)

> "Did HAL classify anything in the last day?"

```sql
SELECT
  date_trunc('hour', created_at) AS hour,
  count(*) AS runs,
  count(*) FILTER (WHERE hal_vetoed) AS vetoed,
  avg(hal_score)::numeric(5,3) AS avg_hal_score
FROM hal_runner_results
WHERE created_at > now() - interval '24 hours'
GROUP BY 1
ORDER BY 1 DESC;
```

Empty rows beyond synthetic ts → no real HAL traffic. Wake-up not complete.

---

## Query 5 — Memory graph state

> "Are agents accumulating memory and forming edges?"

```sql
SELECT
  (SELECT count(*) FROM agent_memory_nodes) AS total_nodes,
  (SELECT count(*) FROM agent_memory_edges) AS total_edges,
  (SELECT count(DISTINCT agent_id) FROM agent_memory_nodes) AS agents_with_memory,
  (SELECT edge_type FROM agent_memory_edges
   GROUP BY edge_type ORDER BY count(*) DESC LIMIT 1) AS most_common_edge_type;
```

Edges should grow during Protocol 1 (one `response_to` per Q&A). Baseline = 0.

---

## Query 6 — Circuit breaker state

> "What's blocked right now?"

```sql
SELECT key, value, last_updated, updated_by, description
FROM repid_config
WHERE key LIKE 'cb_%'
ORDER BY key;
```

All 6 rows visible = scaffolding intact. Audit `updated_by` for "cli:sprint-9" vs human edits.

---

## Query 7 — On-chain reputation events (24h)

> "Did anything anchor to Base Sepolia?"

```sql
SELECT
  agent_id,
  event_type,
  tx_hash,
  block_number,
  created_at
FROM erc8004_reputation_events
WHERE created_at > now() - interval '24 hours'
ORDER BY created_at DESC
LIMIT 20;
```

Empty = `cb_disable_onchain_writes` still tripped, or wake-up hasn't reached Phase E.

---

## Query 8 — Tier distribution drift

> "Did any agent move tiers?"

```sql
SELECT tier, count(*) AS agents,
       avg(current_repid)::int AS avg_repid,
       min(current_repid) AS min_repid,
       max(current_repid) AS max_repid
FROM repid_agents
GROUP BY tier
ORDER BY min_repid;
```

Compare against baseline. Movement into/out of AUTONOMOUS or VETERAN deserves review.

---

## Query 9 — Recent trade execution (24h)

> "Is production trading on?"

```sql
SELECT
  created_at,
  agent_name,
  decision,
  pair,
  amount_usd,
  pnl_realized,
  execution_mode,
  reason
FROM trade_execution_log
WHERE created_at > now() - interval '24 hours'
  AND agent_name NOT LIKE 'mock-%'
ORDER BY created_at DESC
LIMIT 30;
```

NOTE: filters out mock harness rows. Real production rows should be 0 until Phase E.

---

## Query 10 — Sprint 9 liveness probe history

> "How has substrate health evolved during the wake-up?"

```sql
SELECT
  run_id,
  date_trunc('minute', created_at) AS minute,
  jsonb_object_agg(probe_name, status) AS by_probe
FROM liveness_probe_history
GROUP BY run_id, minute
ORDER BY minute DESC
LIMIT 20;
```

This table is populated by `npm run probe:all`. Each invocation gets a unique `run_id`; you can replay the substrate's evolution by reading this in chronological order.

---

## How to use during wake-up

- Run Query 6 first — confirms breaker state matches the runbook's Gate 4 expectation.
- Run Query 2 — confirms spokespersons are intact.
- Run Queries 1, 4 every few minutes during Phase D — they show real activity.
- Run Queries 3, 5, 7 once after Phase D completes — confirms downstream substrate caught up.
- Run Query 10 retrospectively — single-pane-of-glass for the whole wake-up.

Each query is intentionally narrow. If you find yourself wanting a wider join, capture that question in IDEAS_LOG for a future query helper, but **do not improvise wider queries during wake-up** — narrow questions get fast, unambiguous answers.
