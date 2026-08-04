# Migrations lane — trigger order, range checks, and the unscoped F1

**Branch:** `feat/migrations-2026-08-03-trigger-order-and-checks`
**Date:** 2026-08-03
**Fence:** `migrations/**`, `tests/migrations-*.test.ts`, `reports/2026-08-03/`
**Database:** `qnnpjhlxljtqyigedwkb` — **read-only throughout. No DDL was applied. No row was written.**

Every claim below is tagged `[V]` verified by a command whose output is quoted, `[inference]` where
it is reasoning from verified facts, or `unknown` where I could not establish it and did not
reconstruct it.

---

## What shipped

| File | Purpose |
|---|---|
| `migrations/2026-08-03-hal-penalty-guard-trigger-order.sql` | Defect 1 — make the trigger firing order explicit |
| `migrations/2026-08-03-repid-penalty-suppression-audit-view.sql` | Defect 1 companion — make the 25,418 bad rows countable |
| `migrations/2026-08-03-repid-score-events-range-check.sql` | Defect 2 — range CHECK + quarantine view |
| `migrations/2026-08-03-hal-accuracy-summary-ruler-scoping.sql` | Defect 3 — refuse the unscoped F1; add a per-ruler view |
| `migrations/rollback/DOWN_*.sql` (×4) | One rollback per forward migration |
| `tests/migrations-2026-08-03-trigger-order-and-checks.test.ts` | 64 static contract tests, no DB required |

All four migrations carry a `PROMOTION-GATED — NOT APPLIED TO PROD` banner, a stated blast radius,
an explicit maintenance-window verdict, and verification queries that prove the defect before and
its absence after.

---

## Test counts — measured, not assumed

Measured in this worktree, pristine `origin/main` @ `08e0656`, after a fresh
`npm install --legacy-peer-deps` (`node_modules` was empty at start).

| | Suites | Tests |
|---|---|---|
| **Baseline** (`origin/main` @ `08e0656`) | 4 failed / 16 skipped / 308 passed of 328 | 12 failed, 74 skipped, 1 todo, **3658 passed — 3745 total** |
| **This branch** | see PR body | +64 passing, all mine |

Delta: **+64 tests, all in `tests/migrations-2026-08-03-trigger-order-and-checks.test.ts`, all
passing.** No pre-existing test changes status.

The 12 baseline failures are **environment failures, not regressions**: suites that gate on
`!!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)` — a *presence* check — and
therefore run against the dummy `http://localhost:54321` with no local Postgres, timing out at
5000 ms. `hal_accuracy_summary` and `trinity_swarm_health` are the two I confirmed by name from
the captured output. My own suite needs no credentials, no network, and no database.

**One caveat, stated plainly:** I piped the baseline run through `tail`, so only the final suite's
detail survived in the log. The totals above are `[V]` from the summary block; the full
failing-suite roster for the baseline is reconstructed only as far as the two names above, and I
have not padded it out.

---

## Defect 1 — the penalty guard fires second, and it was never the thing moving the score

### The ordering, verified

```sql
SELECT t.tgname, CASE t.tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       CASE t.tgtype & 1 WHEN 1 THEN 'ROW' ELSE 'STATEMENT' END AS level, p.proname AS func
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
WHERE c.relname='repid_score_events' AND NOT t.tgisinternal ORDER BY t.tgname;
```

```
repid_score_events_peer_verify_trigger  AFTER   ROW  trg_repid_score_events_peer_verify  (tgenabled=D, disabled)
trg_apply_repid_score_event             BEFORE  ROW  apply_repid_score_event
trg_apply_vertical_accuracy             AFTER   ROW  apply_vertical_accuracy
trg_hal_penalty_guard                   BEFORE  ROW  trg_hal_penalty_guard
```

`[V]` Both relevant triggers are `BEFORE INSERT ... FOR EACH ROW`. PostgreSQL fires same-timing
row triggers in **trigger-name order**, and `trg_apply_repid_score_event` < `trg_hal_penalty_guard`.
The guard runs **second**. Nothing declares that ordering; it is an accident of two names.

### The guard's body, verified

`pg_get_functiondef('public.trg_hal_penalty_guard()'::regprocedure)` — when it suppresses, it
mutates exactly three things on `NEW`:

```
NEW.metadata    += {penalty_suppressed: true, suppressed_reason, original_delta}
NEW.repid_after := NEW.repid_before
NEW.delta       := 0
```

`[V]` It does **not** clear `NEW.repid_delta_applied`, and being a `BEFORE INSERT` trigger it
cannot touch `repid_agents` at all.

### The damage, verified

```sql
SELECT count(*) AS suppressed_rows,
       count(*) FILTER (WHERE coalesce(repid_delta_applied,0) <> 0) AS but_still_applied,
       sum(coalesce(repid_delta_applied,0)) FILTER (WHERE coalesce(repid_delta_applied,0) <> 0) AS total_moved,
       min(created_at), max(created_at)
FROM repid_score_events WHERE metadata->>'penalty_suppressed' = 'true';
```

```
suppressed_rows | but_still_applied | total_moved | first                  | last
53676           | 25418             | -220389     | 2026-05-29 23:48:49Z   | 2026-08-02 09:15:20Z
```

`[V]` **25,418 rows** — matching the briefed figure exactly — say `delta = 0`,
`repid_after = repid_before`, `penalty_suppressed: true`, while `repid_delta_applied` still records
a negative delta. Ledger sum: **−220,389**.

### Where the briefed premise is wrong — and it matters

The brief said the guard "rewrites the row but not the score" because `apply_repid_score_event`
already moved `current_repid`. The ordering half is right. **The mechanism half is refuted.**

`apply_repid_score_event()` opens with `IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW;`.

```sql
SELECT event_type, count(*) AS n, count(*) FILTER (WHERE repid_delta_applied IS NULL) AS trigger_path
FROM repid_score_events GROUP BY 1 HAVING count(*) FILTER (WHERE repid_delta_applied IS NULL) > 0
ORDER BY trigger_path DESC;
```

`[V]` The result lists `PREDICTION_RESOLVE (2880)`, `GENESIS (30)`, `CHALLENGE_WIN (20)`,
`CHALLENGE_LOSS (15)`, `VALIDATOR_REWARD (2)`, and seven others — **`HAL_SCORE_EVENT` does not
appear.** Every HAL row arrives with `repid_delta_applied` already populated.

```sql
SELECT count(*) FROM agent_repid_history WHERE reason = 'HAL_SCORE_EVENT';   -- 0
```

`[V]` `agent_repid_history` is written **only** by `apply_repid_score_event`'s UPDATE path, and it
holds **zero** `HAL_SCORE_EVENT` rows. So that UPDATE has **never executed for a HAL penalty**. On
every row the guard has ever seen, the trigger it races was already a no-op.

`[inference]` The 25,418 penalties were therefore applied by the **application writer**
(`src/engine/repid-update.ts`, which UPDATEs `repid_agents` itself and supplies
`repid_delta_applied`), in a separate statement, from a value computed *before* the INSERT. A
`BEFORE INSERT` trigger can only mutate the row being inserted — so the guard is **structurally
incapable** of retracting that UPDATE. The suppression is row-cosmetic: it edits the audit record,
not the score. This is worse than the briefed defect, and it is one directory outside this fence.

`unknown` — **whether `repid_agents.current_repid` still carries those −220,389 today.** I did not
establish it and did not reconstruct it. The 2026-07-23 epoch-1 reset flattened the 12 core agents
to a baseline, and there is no per-event agents-table audit for the application write path.

### Fix, rollback, verification

- **Forward:** `ALTER TRIGGER trg_hal_penalty_guard ... RENAME TO trg_00_hal_penalty_guard`, guarded
  for idempotency, followed by a `RAISE EXCEPTION` that asserts the guard really is the first
  enabled `BEFORE INSERT ROW` trigger. A digit prefix puts the ordering in the identifier instead
  of leaving the next reader to rediscover that `a` < `h`.
- **Rollback:** rename back. Restores the defect, which is what a rollback is for.
- **Verification:** the one-line verdict query in the migration returns `DEFECT — guard fires after
  apply` before and `OK — guard fires before apply` after.

### Blast radius

**No maintenance window required.** `ALTER TRIGGER ... RENAME` is a catalog-only change: brief
`ACCESS EXCLUSIVE` on `repid_score_events`, no table rewrite, no scan, single-digit milliseconds.
Concurrent INSERTs queue for that instant — a blip, not an outage. Recommend
`SET LOCAL lock_timeout = '3s'` and retry rather than risking a lock-queue pile-up.

**Behaviour change: none on any observed traffic.** `[V]` For the 149,124 of 152,084 rows where the
writer supplies `repid_delta_applied` — including **100%** of `HAL_SCORE_EVENT` rows — apply
short-circuits regardless of order, so both orderings produce an identical row. The rename only
takes effect if a future writer inserts a negative-delta `HAL_SCORE_EVENT` leaving
`repid_delta_applied` NULL. It is a latent-defect fix, safe to apply before the writer is fixed,
and **it does not on its own fix the 25,418-row defect.**

### Why no CHECK constraint on the contradiction

The obvious guard —
`CHECK (metadata->>'penalty_suppressed' IS DISTINCT FROM 'true' OR coalesce(repid_delta_applied,0) = 0) NOT VALID`
— is **deliberately not shipped**. `NOT VALID` constrains new rows only, and new rows are exactly
what the current production writer still emits in that shape. Adding it would turn every suppressed
HAL penalty write into a `23514` and take HAL scoring writes down. It becomes correct the moment
`src/engine/repid-update.ts` stops emitting the shape, and not one commit before. The audit view
ships instead, with a 24-hour regression tripwire so the writer fix has a number to prove itself
against.

---

## Defect 2 — the audit table can hold a score the agents table would reject

### The asymmetry, verified

`[V]` `repid_agents` enforces the range and always has:

```
repid_agents_current_repid_check  CHECK (current_repid >= 10 AND current_repid <= 10000)  convalidated=true
```

`[V]` `repid_score_events` enforces **nothing** about either score column. Its complete
`pg_constraint` inventory is `certainty_at_claim` (0..1), `event_type` (enum), `veto_class` (enum),
the PK, and the `agent_id` FK. No range constraint. The audit table trusts its writer completely.

### The briefed row — and it is provably wrong, not merely out of range

```sql
SELECT id, agent_id, event_type, delta, repid_before, repid_after, repid_delta_applied, created_at
FROM repid_score_events WHERE id = 157308;
```

```
157308 | 51e8367b-a953-4361-a7b0-bb68e494c1bb | VALIDATOR_REWARD | 40 | 10000 | 10040 | 40 | 2026-07-25 03:16:17Z
```

```sql
SELECT current_repid, peak_repid, tier FROM repid_agents WHERE id='51e8367b-a953-4361-a7b0-bb68e494c1bb';
```

```
current_repid | peak_repid | tier
10000         | 10000      | ESTABLISHED
```

`[V]` The ledger records an agent reaching **10040**. The agents table says it **never left the cap**
and its own CHECK would have rejected 10040. The audit trail is wrong by **+40** and nothing caught
it.

`[V]` **How it committed:** 149,124 of 152,084 rows arrive with `repid_delta_applied` populated, so
`apply_repid_score_event` short-circuits and never performs the `repid_agents` UPDATE whose CHECK
would have blocked the value. `repid_before`/`repid_after` on those rows are whatever the
application computed, and nothing re-derives or bounds them.

### The scope is far bigger than one row — and this is the load-bearing finding

```sql
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE repid_after > 10000) AS above_max,
       count(*) FILTER (WHERE repid_after < 10) AS below_min,
       min(repid_after), max(repid_after)
FROM repid_score_events;
```

```
total_rows | above_max | below_min | min_after | max_after
152084     | 1         | 21281     | 0         | 10040
```

`[V]` The briefed defect was the **ceiling** (1 row). The **floor is violated 21,281 times**, with a
minimum of **0**. Plus one `repid_before < 10`. **Total violating rows: 21,282.**

A plain validating `ADD CONSTRAINT ... CHECK (repid_after BETWEEN 10 AND 10000)` would therefore
**abort with a 23514**. This is exactly the assumption a migration must measure rather than inherit,
and it is why both constraints ship `NOT VALID`.

`[V]` **The floor hole is closed; the ceiling is not:**

```sql
SELECT count(*) FILTER (WHERE created_at >= '2026-06-03') AS after_floor_migration,
       count(*) AS total, max(created_at) AS latest
FROM repid_score_events WHERE repid_after < 10;
```

```
after_floor_migration | total | latest
0                     | 21281 | 2026-05-29 23:48:19Z
```

Nothing below 10 since **2026-05-29** (the tier floor trigger `trg_repid_earned_floor` enforces a
lower bound on `repid_agents`; `migrations/2026-06-03-restore-9-floor-pinned.sql` is in this tree).
But `trg_repid_earned_floor()` enforces a **floor only, no ceiling** — verified from its body — and
the one ceiling violation landed **two months later**, on 2026-07-25. So the only hole still open is
the overshoot, and that is precisely what the new constraint blocks.

### Fix, rollback, verification

- **Forward:** two separate `NOT VALID` CHECK constraints (`repid_after`, `repid_before`), each
  NULL-tolerant because both columns are nullable; plus `repid_score_events_out_of_range`, a
  quarantine view documenting the 21,282 rows in the database rather than only in a file. Separate
  constraints so each column can be validated independently instead of being held hostage to
  whichever is dirtier.
- **Rollback:** drop both constraints and the view. No row touched either way.
- **Verification:** V1 shows 0 matching constraints before / 2 with `convalidated=false` after; V2
  shows `repid_after=10040` beside `current_repid=10000`; V3 confirms the 21,282 scope.

### Blast radius

**No maintenance window required.** `ADD CONSTRAINT ... NOT VALID` is a catalog write: brief
`ACCESS EXCLUSIVE`, **no table scan**, independent of the 152,084 rows. That is the whole reason to
use `NOT VALID` rather than a validating ADD, which would seq-scan under the same lock *and then
abort* on row 21,282.

**What breaks if applied live — the honest answer.** Any writer emitting a score outside
`[10, 10000]` starts receiving `23514` and **its transaction fails**. That is a real risk, not a
theoretical one: `[V]` the floor side is dormant (0 rows since 2026-05-29), but the ceiling is not —
one `VALIDATOR_REWARD` overshot on 2026-07-25, proving a live path can still exceed the cap. If that
path is a hot economic write it will now fail loudly instead of silently recording a false score.

**This is a live-behaviour change and needs Sean's GO, not just a co-sign.** The choice is: a failed
reward write, or a wrong audit trail. This lane recommends the former. Mitigation if a failed write
is unacceptable: apply only after the application writer clamps `repid_after` before insert —
`src/engine/repid-update.ts`, outside this fence.

`VALIDATE CONSTRAINT` is documented in the migration as **do not run** (it will abort on the 21,282
pre-existing rows) so nobody tries it blind. This lane recommends those rows are never rewritten —
editing an append-only audit log to look correct is the opposite of an audit log.

---

## Defect 3 — one unscoped F1 over five incompatible rulers, labelled `ROBUST`

Read against the ruler contract merged in **PR #327** (`src/hal/measurement-ruler.ts`,
`corpus-manifest.ts`). #327 listed this view as its own out-of-fence follow-up 3, noting
"**DDL — needs the single-writer**". The vocabulary below is #327's, not a second dialect.

### What the view does, verified

`[V]` `pg_get_viewdef('public.hal_accuracy_summary')` — the only filters are
`gen_failed = false AND hal_vetoed IS NOT NULL`. There is **no grouping by run, mode, threshold,
corpus, date, or provider width anywhere**. `data_quality` is a pure sample-size bucket: `>= 100`
labeled rows ⇒ `'ROBUST'`. The word means "big" and reads as "trustworthy".

`[V]` What it currently returns — one row:

```
tp=178  fp=977  fn=19  tn=221  total_labeled=1395  total_raw=1559
precision=0.1541  recall=0.9036  f1_score=0.2633  false_positive_rate=0.8155
data_quality=ROBUST
```

### The blend, verified

```
hal_mode        manifest_dataset_id             threshold   rows  labeled  families  F1
mock            hal-test-prompts-2026-05-05-v2  1.0136433    633      633  none      0.0000
real            hal-test-prompts-2026-05-04     0.25         420      267  none      0.0000
fact-check-s2   <NULL>                          0.43         395      395  1..3      0.8812
real            hal-test-prompts-2026-05-05-v2  0.25          90       90  none      0.0000
mock            hal-test-prompts-2026-05-04     1.0136433     20       10  none      0.0000
1               <NULL>                          0.7            1        0  none      NULL
```

`[V]` **653 of 1,559 rows are `hal_mode = 'mock'`.** Their `1.0136433` threshold is the Pythagorean
comma used as a placeholder — a value no real veto runs at. Six ruler groups exist; five carry
labeled rows.

### The cost, as a confusion matrix

`[V]` Per-ruler tallies sum exactly to the blended view, so the blend is arithmetic, not sampling:

| ruler | tp | fp | fn | tn |
|---|---|---|---|---|
| **fact-check-s2** (the real one) | **178** | 29 | 19 | 169 |
| mock @ 1.0136433 (633) | 0 | 584 | 0 | 49 |
| real @ 0.25 (267) | 0 | 267 | 0 | 0 |
| real @ 0.25 (90) | 0 | 90 | 0 | 0 |
| mock @ 1.0136433 (10) | 0 | 7 | 0 | 3 |
| **blended `hal_accuracy_summary`** | **178** | **977** | **19** | **221** |

**Every true positive HAL has ever recorded — all 178 — comes from the one real ruler.** The other
rulers contribute **948 additional false positives and zero true positives**. That is what drags
precision from ruler quality down to the published 0.1541, and it is why the fix is *scoping*, not
re-tuning anything in HAL.

`[V]` The single real cross-LLM ruler — `fact-check-s2`, 395 labeled cases, observed family width
1..3 — scores **F1 = 0.8812**. The unscoped view **understates the one real measurement by ~0.62
F1** and stamps the result `ROBUST`. (0.8812 on 395 cases is verbatim the example citation in
`src/hal/measurement-ruler.ts` — #327's author already knew this number.)

`[V]` **`anon` holds SELECT on this view.** It is not an internal scratch metric; it is reachable by
an unauthenticated reader. An overclaim on a surface strangers can hit is product engineering, which
is why this warrants a migration rather than a doc note.

### Fix, rollback, verification

- **Forward:** `hal_accuracy_summary` **stops emitting a number it cannot justify** — the four ratio
  columns go NULL and `data_quality` becomes `UNRULED_MIXED_POPULATION_INCLUDES_MOCK` when the rows
  span more than one ruler. **Counts are retained** (they are facts about rows); only the derived
  ratios are withheld, mirroring #327's rule that a bad denominator yields null, never a substituted
  1. A new `hal_accuracy_by_ruler` emits one row per ruler with its own F1 and a citation string in
  #327's format.
- **Both view bodies were validated read-only** by running their `SELECT` bodies as plain queries
  against prod — no DDL. The refusal path returns exactly `f1_score=NULL`,
  `data_quality='UNRULED_MIXED_POPULATION_INCLUDES_MOCK'`, `distinct_rulers=5`,
  `mock_labeled_rows=643`, counts unchanged at `178/977/19/221`. The scoped view returns the
  `fact-check-s2` row at `f1_score=0.8812, cases_labeled=395, families 1..3, strictness 2,
  is_measurement=true`.
- **Rollback:** restores the previous definition **captured verbatim from `pg_get_viewdef`** and
  drops the new view.
- **Verification:** V1/V2 prove the blend before (and V2 needs none of this migration); V3–V5 prove
  the refusal after and that the counts did not move.

### What it deliberately does not do

- **Does not invent a corpus content hash.** `hal_runner_results` has `manifest_dataset_id` and
  `hyperdag_bench_commit` but **no content hash column**, and `hal_snapshot_registry` — which has
  `version` + `snapshot_hash` + `test_cases_count` — has **zero rows**. So every row reports
  `ruler_status = 'UNRULED'` with a per-row `ruler_gap` explaining why. That is the honest answer and
  it is uncomfortable on purpose.
- **Does not guess a strictness.** Only `fact-check-s2` is unambiguously the cross-LLM quorum path
  (strictness 2). `real`, `mock`, and the literal `1` report `NULL` rather than a reconstruction.
- **Does not hide the mock rows.** They are marked `is_measurement = false` and left visible.
  Hiding them would repeat the original error in the opposite direction.
- Changes no HAL threshold, no veto logic, no scoring behaviour. Views only.

### Blast radius

**No maintenance window required.** `CREATE OR REPLACE VIEW` locks the view only, for a catalog
update; it does not lock or scan `hal_runner_results`. Neither view is on a write path.

**What breaks — there is something.** Consumers reading `f1_score` / `precision` / `recall` /
`false_positive_rate` now receive NULL, because the live population is unruled. `[V]` Enumerated
consumers (`grep hal_accuracy_summary`, excluding `node_modules`) — exactly 6 files:

| File | Impact |
|---|---|
| `tests/hal-accuracy-summary.test.ts` | already tolerates NULL metrics |
| `scripts/preflight-cc-sprint-6.ts` | preflight check, not a served surface |
| `scripts/seed-ground-truth-26-prompts.ts` | seeding script |
| `src/types/database.types.ts` | generated types — **stale, needs regeneration** |
| `migrations/2026-05-11-hal-accuracy-summary-view.sql` | original definition |
| `migrations/2026-05-12-hal-ground-truth-labels.sql` | the redefinition now live |

**No route under `src/routes/` selects this view**, so no public API response changes shape. The
intended consequence: a dashboard that showed `0.26 ROBUST` now shows nothing plus
`UNRULED_MIXED_POPULATION_INCLUDES_MOCK` — the correct reading, and strictly better than a
confident wrong number on an anon-readable surface.

Column compatibility is preserved: the 13 existing columns keep their names, types, and **ordinal
positions**, so this is a true `CREATE OR REPLACE` (grants and dependencies survive) rather than a
`DROP` + `CREATE`, which would silently revoke `anon`/`authenticated`/`service_role` SELECT. The
rollback *does* need a DROP (a 13-column body cannot replace a 17-column view), so it re-grants
explicitly — and a test asserts that.

---

## Incidental findings — reported, not fixed, all outside this fence

1. **`tests/hal-accuracy-summary.test.ts` selects a column that no longer exists.** `[V]` It queries
   `select('tp, fp, fn, tn, total')`, but the live view has **`total_labeled` and `total_raw`** — the
   2026-05-12 redefinition renamed `total` and the test was never updated. **Pre-existing; not
   caused by this branch.** My migration keeps `total_labeled`/`total_raw` and does not resurrect
   `total`, so the test stays broken exactly as it already was. Fix belongs in `tests/`.

2. **Rollback provenance is a trap in this repo.** The oldest file on disk
   (`2026-05-11-hal-accuracy-summary-view.sql`) is **not** what was live — the 2026-05-12 migration
   redefined the view. Rolling back to the older file would have silently reverted four months of
   change and reintroduced the phantom `total` column. My rollback is captured from
   `pg_get_viewdef`, not from the file. Worth a standing rule: **roll back to what was measured, not
   to the oldest file.**

3. **Grant hygiene on views.** `[V]` `anon` and `authenticated` hold **INSERT, UPDATE, DELETE,
   TRUNCATE, REFERENCES, TRIGGER** as well as SELECT on `hal_accuracy_summary` — evidently from a
   blanket `GRANT ALL ON ALL TABLES`. Harmless on a non-updatable view today, but it is the wrong
   default and it will not stay harmless. My two new internal views are created with
   `REVOKE ALL ... FROM PUBLIC` + `GRANT SELECT TO service_role` only. A grant sweep is its own task.

4. **`repid_agents.tier` has drifted on one row.** `[V]`
   `SELECT count(*) FILTER (WHERE tier <> compute_tier(current_repid)) FROM repid_agents` → **1 of
   172**. Agent `51e8367b` sits at `current_repid = 10000` with `tier = 'ESTABLISHED'`, while
   `compute_tier(10000)` returns `'VETERAN'` (verified from its body). `trg_sync_tier` fires
   `BEFORE INSERT OR UPDATE`, so the row has not been updated since the value diverged. **Not
   fixed** — repairing it means UPDATEing prod data, which this lane may not do.

5. **`hal_runner_results.hal_providers_used` is unreliable as a family-width source.** `[V]` 653+510
   rows carry an **empty** array, and #327 separately reported single elements holding the literal
   `used:2` — a count written into a provider-name array. My `hal_accuracy_by_ruler` therefore
   reports `rows_missing_family_width` explicitly and `families_min/max` as NULL where unrecorded,
   rather than inferring a width. The upstream writer bug is not mine to fix.

---

## Needed outside this fence

| # | Item | Owner |
|---|---|---|
| 1 | **`src/engine/repid-update.ts`** must stop emitting `penalty_suppressed: true` alongside a non-zero `repid_delta_applied`, and should clamp `repid_after` to `[10, 10000]` before insert. **This is where the live defect 1 actually is** — the trigger rename does not reach it. Once the 24h tripwire in the audit view reads 0, the suppression-coherence CHECK becomes safe to add. | scoring lane |
| 2 | **Sean's GO** on the defect-2 constraints. They are a live-behaviour change: a writer overshooting 10000 will start failing loudly. Recommended, but not a co-sign-only call. | Sean |
| 3 | `tests/hal-accuracy-summary.test.ts` — fix the `total` → `total_labeled` selection, and replace the `HAS_DB` presence check with a real probe so a dead URL reports as an environment failure rather than a view defect (#327 follow-up 1). | tests lane |
| 4 | `src/services/hal-evaluations-writer.ts` should persist a `MeasurementRuler` including a corpus **content hash**, and `hal_snapshot_registry` (0 rows, already has `snapshot_hash`) is the natural target. Until then `ruler_status` is `UNRULED` everywhere by construction (#327 follow-ups 2 and 4). | HAL writer lane |
| 5 | Regenerate `src/types/database.types.ts` after the view migration applies — it is already stale and the new columns will widen the gap. | whoever applies |
| 6 | Grant sweep on views (finding 3) and the single tier-drift row (finding 4). | ops |

---

## Discipline notes

- **No DDL was applied.** Every statement run against `qnnpjhlxljtqyigedwkb` was a `SELECT`,
  including the validation of both new view bodies. No transaction was opened; nothing needed
  rolling back.
- **Scratch files** stayed in the OS temp dir (`%TEMP%/lane-migrations`). Nothing was written into
  the repo outside the three fenced paths.
- **Worktree locked** for the duration.
- **What I could not verify** is stated as `unknown` in the one place it arises (whether the
  −220,389 survives in `current_repid` today) rather than reconstructed.
