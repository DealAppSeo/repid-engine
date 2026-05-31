# CC — S-STABLE2: trinity-symphony-shared Audit → Real Root Cause of "Idle Agents"

> NOTE: written into the repo because the usual `E:\dev\reports\` mirror was unmounted at report time (transient). Copy to `E:\dev\reports\2026-05-30\CC_S-STABLE2_REPORT.md` when E: returns.

- **Date:** 2026-05-31 (UTC) · **Owner:** CC
- **Fix branch:** `feat/cc-2026-05-30-s-stable2` on **repid-engine** (pushed) — the fix is in repid-engine, **not** trinity-symphony-shared (see why below).
- **Headline:** The agent repo is **not** the problem. All 12 agents are alive and the claim loop is correct + atomic. The backlog is **100% assigned to only 3 of 12 agents by a hardcoded `VERIFIER_POOL` in repid-engine's peer-verification producer** — the other 9 agents have nothing assigned to claim and starve.

## TASK 1 — State of main + repo identity (important correction)
- **`C:\temp_symphony\trinity-symphony-shared` is the WRONG repo.** Its `package.json` name is **`my-v0-project`** (a v0.dev Next.js dashboard); git `main` = `6a7c7c52` dated **2026-04-09** (stale), only `main`, agent code only in an **untracked nested `OneDrive/Desktop/…` snapshot**. Same GitHub remote, wrong checkout. **Do not audit deploy state from it.**
- **The real agent repo is `C:\Users\Cash4\repos\trinity-symphony-shared`** (main `8b21ba8f`, 2026-05-27; deploy entry `node server.js` → `lib/ConstitutionalAgentV4.js`).
- **Fix repo (repid-engine) baseline:** `tsc --noEmit` **0 errors**; `tests/peer-verification.test.ts` **7/7 pass** with the fix applied.

## TASK 2 — GA's concurrency fix: where it is + what it actually is
- **Not in temp_symphony** (that's the dashboard). In the real repo it's commit **`fd0c37e6 "implement T12 concurrency enhancements"`** (+ `a5b94eb1` routing fallback) on branch **`feat/ga-2026-05-30-t12-concurrency`** — **confirmed NOT an ancestor of `origin/main` → unmerged/undeployed** (the repo is currently checked out on `feat/ga-2026-05-30-s-cost2`).
- **What it changes:** mostly **exponential-backoff retries** (`sleep(baseDelay·2^attempts)`, provider retry backoff) + a `getNextTask` test — **not** a parallelism cap. `MAX_CONCURRENCY` exists in no checkout. **GA's T12 is NOT the fix for the idle agents** (it doesn't touch verifier distribution). It's a separate, mergeable retry-resilience improvement.

## TASK 3 — Task-claiming code (it's correct — not the bug)
Deployed loop = `lib/ConstitutionalAgentV4.js` (hardened — `withTimeout` Sprint-14 R-1, heartbeat circuit breaker, direct-pg). Logic:
- **Poll:** `runLoop` `while(true)` → `getNextTask(assigned)` then `getNextTask(global)` → `sleep(5s if it handled a task / 15s idle / 60s on error)`.
- **Query:** `SELECT * FROM trinity_tasks WHERE (assigned_to = <self> OR assigned_to IS NULL) AND status='pending' ORDER BY priority DESC, created_at ASC LIMIT 1`.
- **Claim (ATOMIC, race-safe):** `claimTask` → `UPDATE … SET status='doing', claimed_by=<self> WHERE id=? AND status='pending' AND claimed_by IS NULL` (returns true only if it won the row). ✅ Correct.
- **Empirically proven** (S-DIAG1 inject probe): tasks claimed in 5–10s.

## Root-cause evidence (live)
| signal | value |
|---|---|
| agents heartbeat-alive | **12 / 12** (hb age 7–117s — none infra-down) |
| agents actually claiming | **3** (shofet/gcm/mel: 17–19 claims/15m) vs **9 starving** (sophia 0 claims, last claim **28 min** ago; rest 1–3/15m) |
| pending tasks by `assigned_to` | **gcm 1563 · mel 1545 · shofet 1544 · everyone else 0 · unassigned 0** |

The claim query is `assigned_to = self OR assigned_to IS NULL`. With **every** pending task assigned to gcm/mel/shofet and **zero** unassigned, the other 9 agents match nothing → poll, get nothing, sleep 15s, repeat. **Alive but starved.**

## TASK 4 — The minimal fix (root cause, one constant)
Producer: `repid-engine/src/services/peer-verification-reader.ts` round-robins `peer_verify` tasks across `VERIFIER_POOL`, which was:
```ts
const VERIFIER_POOL = ['trinity-mel', 'trinity-shofet', 'trinity-gcm'];   // only 3 of 12
```
**Fix (`feat/cc-2026-05-30-s-stable2`):** default the pool to **all 12 live swarm agents** (apm, chesed, gcm, hdm, mel, nexus, orch, shofet, sophia, torch, veritas, w3c), env-overridable (`VERIFIER_POOL=comma,list`). New `peer_verify` tasks now distribute ~1/12 each → the 9 idle agents get work → ~4× throughput. **tsc 0 errors; peer-verification test 7/7 green.** All 12 are `peer_verify`-capable + alive, so this is safe (the existing source-exclusion still applies).

### Existing 4,650 backlog (separate, Sean co-sign — the code fix only routes NEW tasks)
The already-assigned backlog stays on the 3 agents unless redistributed. Recommended (design-only):
```sql
-- Redistribute pending peer_verify across all 12 (round-robin by id). Reversible.
-- CAVEAT: does NOT re-apply source-agent exclusion; acceptable for a stopgap (a claimant
-- self-verifying its own old backlog claim is rare). Prefer re-dispatch via the fixed producer
-- if exactness matters.
WITH pool AS (
  SELECT agent_name, (row_number() OVER (ORDER BY agent_name)) - 1 AS idx, count(*) OVER () AS n
  FROM (VALUES ('trinity-apm'),('trinity-chesed'),('trinity-gcm'),('trinity-hdm'),('trinity-mel'),
               ('trinity-nexus'),('trinity-orch'),('trinity-shofet'),('trinity-sophia'),
               ('trinity-torch'),('trinity-veritas'),('trinity-w3c')) v(agent_name)),
numbered AS (
  SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn
  FROM trinity_tasks WHERE status='pending' AND task_type='peer_verify')
UPDATE trinity_tasks t SET assigned_to = p.agent_name, agent_assigned = p.agent_name
FROM numbered nu JOIN pool p ON p.idx = (nu.rn % p.n)
WHERE t.id = nu.id;
```

## Conclusion + handoff
- **There is no claim defect and no idle defect in the agent code.** The "idle agents" are a **work-distribution bug in the repid-engine peer-verification producer** (`VERIFIER_POOL` = 3 of 12). Fixed minimally.
- **Sean / Cowork:** co-sign + deploy `feat/cc-2026-05-30-s-stable2` (repid-engine) to fix forward routing; run the redistribution SQL (with the noted caveat) to drain the existing 4,650 backlog across all 12. Separately, GA's `feat/ga-2026-05-30-t12-concurrency` (retry backoff) is mergeable but unrelated to this RCA.
- **GA to verify** the fix + the RCA.
