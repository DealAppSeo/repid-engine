# Beat 35 — L2 breaker 2.2: lineage + depth budget (fork-bomb prevention)

**Branch:** `feat/cc-2026-07-27-lineage-depth-budget` · **Base:** `origin/main` @ `a1b6e7f`
**Backlog item:** 2.2 — "Lineage + depth budget: `lineage_id` + `depth`; enqueue validates depth<5; spawners pass lineage_id=self." Acceptance: *"5-deep succeeds; depth 6 → 400; MAX(depth)≤5."*

---

## 1. The headline: this needed NO DDL, and the check-first sweep is why

The backlog asks for two new columns on `trinity_tasks`. **They already exist**, under different names, and are already populated by upstream producers. Verified live before writing any code [V sql:2026-07-27, project `qnnpjhlxljtqyigedwkb`]:

| column | type | default | populated |
|---|---|---|---|
| `parent_task_id` | bigint | NULL | **50,123 rows** |
| `generation` | integer | 0 | **max observed: 1**; 0 NULLs |
| `spawned_count` | integer | 0 | 77 rows > 0 |

out of **362,974** total rows.

`generation` *is* depth; `parent_task_id` *is* the lineage edge. Adding a parallel `lineage_id`/`depth` pair to a table with **26 inbound FKs** would have created two competing lineage conventions and a backfill nobody would ever finish. So 2.2 ships as a pure application layer over the columns that exist — zero migrations, zero risk to a hub table.

This was found by running the CLAUDE-RULE-1 "show what exists first" sweep **before** writing the module, which is the step Beat 34 recorded doing in the wrong order.

## 2. What shipped

**`src/services/task-lineage.ts`** — the primitive:
- `deriveLineage(parent)` → `{ parent_task_id, generation }` to spread into an insert
- `checkDepthBudget(depth)` → `{ exceeded, halted, mode, malformed, reason }`
- `guardedLineage(parent)` → both at once, for a chokepoint
- `rootLineage()` — explicit root, so a row states its lineage instead of leaving it to a default
- `LINEAGE_DEPTH_MODE` = `off | shadow | enforce` (**default enforce**), `LINEAGE_MAX_DEPTH` (default 5, floored at 1)

**Wired at every `trinity_tasks` enqueue chokepoint in the engine** (all six enumerated by grep, rule 14):
- `routes/v1/controller.ts` `POST /sprint` — accepts an optional `parent_task_id`, reads the parent's depth **from the DB**, refuses at the budget with **400 `lineage_depth_exceeded`**
- `routes/v1/controller.ts` `POST /wake` — explicit root
- `services/receipt-indexer.ts` — explicit root (trigger is a chain event, not a task)
- `services/peer-verification-reader.ts` — both spawn paths (panel + legacy), root, **with the measured reason recorded at the call site** (see §4)
- `observability/cron-runners.ts`, `services/zkp-card-generator.ts` — read-only on `trinity_tasks`, no insert; nothing to wire

## 3. Four decisions that cut against this repo's defaults, each with a reason

1. **`enforce` is the DEFAULT mode**, not `shadow` like breaker 2.0. The default is **provably inert**: the budget is 5 and the deepest task that has ever existed is generation 1 [V]. "Calibrate in shadow first" would mean calibrating against a signal that does not exist, while leaving the guard off for the one event it exists for — which arrives without warning.
2. **Fail CLOSED on a malformed depth**, the inverse of breaker 2.0. 2.0's input is a live count query that can be flaky, so wedging producers on it would be worse than the backlog it misses. This breaker's input is a value read off a row: a negative/NaN/garbage depth is corruption or a crafted parent, and both are exactly how a fork bomb gets its first free level. A **null** depth is *not* malformed — it means root, which is what the column default says.
3. **An unknown parent ID does NOT reset the depth.** If it did, any spawner could drop the id and launder its lineage to 0. Depth survives an unknown parent.
4. **The parent's depth is read from the DB, never from the request body.** A caller-supplied `generation` is ignored — pinned by a test that sends `generation: 0` alongside a deep parent and still gets a 400.

**Off-by-one, stated rather than implied:** `generation` is 0-based. The budget is a ceiling on the stored value — with `LINEAGE_MAX_DEPTH=5`, generation 5 is allowed and generation 6 is refused, so `MAX(generation) ≤ 5`. That matches the written acceptance criterion literally.

## 4. A gap this breaker does NOT close, measured rather than glossed

The one recursion the system actually has — a peer-verify task whose output is itself enqueued for peer verification — **cannot be depth-bounded from the engine today.** The lineage chain is broken at the queue hop:

- `peer_verification_queue` has **no task reference of any kind**. All 12 columns enumerated [V]: `id, source_response_id, source_agent_id, certainty_at_claim, verification_status, verifier_agent_id, verifier_response_id, verifier_signature, created_at, completed_at, threshold_used, claim_text`.
- `source_response_id` carries **no foreign key** [V — queried `information_schema` constraint usage; empty result].

So a peer_verify spawn genuinely does not know which task produced the claim. The module records it as a **root** and says so at the call site, rather than inventing a parent. **Adding a column here would be worse than the gap**, because the engine has nothing to populate it with: the only in-repo enqueuer (`chronic-flag-accumulator.ts`) has an agent id and a claim string, no task. Closing it requires the **upstream** producer (`trinity-symphony-shared`, where the response is written) to carry the originating task id into the queue row. Until then breaker **2.3** (self-referential work ban) is what bounds that specific loop.

## 5. A real defect this beat's own tests found before merge

The fail-closed parser was **fail-open on arrays**. `String([])` is `''` and `Number('')` is `0`, so a `generation` of `[]` coerced cleanly through to **root** — a laundering hole in the middle of the guard built to stop laundering. `[3]` would have resolved to depth 3.

Fixed with a type gate before coercion (only `number` and `string` are depths; booleans, arrays, objects, functions are malformed), and pinned by a named regression test separate from the general loop, so a future edit that reintroduces blind coercion fails with a name that says what broke.

## 6. Verification

- **[V] `tsc --noEmit` clean.**
- **[V] `tests/task-lineage.test.ts` — 42 tests**, covering each asymmetry by name.
- **[V] `tests/controller.test.ts` — 15 tests** (9 new), pinning the HTTP wiring: root written on a parentless sprint · gen 0 → child 1 · **gen 4 → child 5 succeeds** · **gen 5 → child 6 returns 400 `lineage_depth_exceeded` with nothing inserted** · a body-supplied `generation` ignored · non-existent parent 400 · malformed `parent_task_id` rejected before any DB read · a corrupt parent depth refused with `depth: null` (the sentinel never leaks to a client) · `/wake` writes explicit root.
- **[V] 69/69 across the 5 suites the diff touches** (`task-lineage`, `controller`, `peer-verification`, `peer-verification-respond`, `receipt-indexer-service`).
- **Local runs need `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` dummies** — the repo ships no usable `.env` (repid-engine PR #214 documents this; it is not a defect of this diff).

## 7. Known overlap

Both this branch and PR #216 (emergency-halt kill switch) add an import + a guard near the top of `services/peer-verification-reader.ts`. Neither has merged; whichever lands second takes a small textual conflict in the import block. Flagged rather than avoided, because wiring the chokepoint is the point of the change.
