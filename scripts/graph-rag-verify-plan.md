# Graph RAG Verification Plan

This is the one-command verification harness for the Graph RAG production rollout. Run it AFTER applying the Sprint 4 migration to confirm the full loop works end-to-end before sending real HAL pipeline traffic.

## Prerequisite

Sean must apply `migrations/2026-05-10-graph-rag-foundation.sql` in Supabase Studio first. The harness gracefully detects the pre-migration state and exits 0 with a clear message; nothing breaks if you accidentally run it too early.

Required env vars (already set on Sean's local + Railway):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY` / `SUPABASE_KEY`)

Optional env: `BASE_SEPOLIA_RPC_URL` — not used by this harness, but consistent with sibling scripts.

## Sequence

### Step 1 — Dry-run check (before migration)

```powershell
npm run verify:graph-rag -- --dry-run
```

**Expected (pre-migration):** A1, A2, A3 all ❌ + `⏸  Migration not yet applied.` + exit 0. This is the documented pre-migration state.

### Step 2 — Apply migration (Sean does this)

Supabase Studio → SQL Editor → paste `migrations/2026-05-10-graph-rag-foundation.sql` → Run.

### Step 3 — Dry-run check (after migration)

```powershell
npm run verify:graph-rag -- --dry-run
```

**Expected (post-migration):** A1 ✅ A2 ✅ A3 ✅ + exit 0. This confirms the schema is in place but skips the live read/write tests.

### Step 4 — Full end-to-end run

```powershell
npm run verify:graph-rag
```

**Expected (best case, all services on main):** A1–A9 all ✅, exit 0. The harness:

1. Probes for the 3 schema pieces (A1–A3)
2. Provisions a test agent — either `GRAPH_RAG_HARNESS_TEST` (created on first run) or falls back to `HalTester6` if create fails (A4)
3. Writes one observation via `GraphRagStore.createNode` (A5)
4. Invokes the production `hal-memory-hook.writeDecisionMemory` fire-and-forget path (A6)
5. Retrieves the planted memory via `RetrievalService.retrieve` with a paraphrased query (A7)
6. Loads `pre-llm-injection.buildMemoryContext` dynamically — if Gemini's Wave 6 branch is also merged, exercises the timeout-respecting path (A8 + A9). If her branch hasn't merged yet, A8 + A9 are **skipped** (not failed) with a clear note.
7. Cleans up its own writes (rows tagged `metadata.harness=true`)

**Expected wall-clock:** ~5–15 seconds. The first run includes the ~25 MB MiniLM model download for `@xenova/transformers`; subsequent runs are ~1–3 s.

### Step 5 — Keep mode for manual inspection

```powershell
npm run verify:graph-rag -- --keep
```

Skips the cleanup step. Use this when something fails and you want to inspect the actual rows in `agent_memory_nodes` for the harness agent. Re-run without `--keep` (or run `cleanup-harness-nodes.sql` from this dir — TODO) to remove the residue.

### Step 6 — Specific test agent

```powershell
npm run verify:graph-rag -- --agent <uuid>
```

Overrides the default `GRAPH_RAG_HARNESS_TEST` / fallback agent. The harness still tags every node it writes with `metadata.harness=true` and cleans up only those rows. Safe to point at any production agent — but **prefer the dedicated harness agent for repeatability.**

## Pass / fail policy (CLAUDE-RULE-4)

If any assertion fails:
- **Do NOT proceed** with HAL pipeline traffic that relies on Graph RAG memory.
- **Do NOT improvise** around the failure (e.g. tweaking thresholds, skipping the broken assertion). File a fix-sprint with the assertion name + actual value + elapsed_ms.
- The harness prints the exact failed assertion to stdout and exits with code 1.

## Known false-positive scenarios

- **A7 may return 0 matches on cold-start.** The first call to the embedding service downloads the 25 MB MiniLM model from the HuggingFace CDN. If the Railway worker has been idle, the download takes 5–15 seconds and the FIRST retrieval can race the model load. Re-run after 30 seconds.
- **A8 may report empty context on cold-start.** Same cause as A7. Re-run.
- **A8/A9 may show as SKIPPED.** This means `src/services/graph-rag/pre-llm-injection.ts` is not on the current branch / merged main. That's not a Graph RAG failure — it's a "Gemini's Wave 6 hasn't merged yet" signal. When her branch lands, A8 + A9 become live assertions automatically without harness code changes.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All assertions passed, OR migration not yet applied (clean state) |
| 1 | At least one assertion failed |
| 2 | Harness itself crashed (env vars missing, supabase unreachable, unhandled exception) |

## Files this harness exercises

| Service | File | Sprint |
|---|---|---|
| `GraphRagStore.createNode` | `src/services/graph-rag/graph-rag-store.ts` | Sprint 4 |
| `RetrievalService.retrieve` | `src/services/graph-rag/retrieval-service.ts` | Sprint 4 |
| `writeDecisionMemory` | `src/services/graph-rag/hal-memory-hook.ts` | Megasprint Wave 5 |
| `buildMemoryContext` | `src/services/graph-rag/pre-llm-injection.ts` | Gemini Wave 6 (dynamic-load) |
| Migration | `migrations/2026-05-10-graph-rag-foundation.sql` | Sprint 4 |

## Cleanup contract

The harness writes ONLY:
- 1 node from `GraphRagStore.createNode` (tagged `metadata.harness=true`)
- 1–3 nodes from `writeDecisionMemory` (re-tagged with `harness=true` post-hoc)

Cleanup deletes nodes matching `agent_id = <harness-agent>` AND `metadata @> {"harness": true}`. FK cascade on `agent_memory_edges` removes any auto-created edges between those nodes. No other rows touched.

If `--keep` is set, the rows survive. Manually clean later with:

```sql
DELETE FROM agent_memory_nodes
 WHERE agent_id = (SELECT id FROM repid_agents WHERE agent_name = 'GRAPH_RAG_HARNESS_TEST' LIMIT 1)
   AND metadata @> '{"harness": true}';
```
