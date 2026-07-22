# CC-2 — Purpose-Gate Classifier v3 (tail non-deliverable domains, additive)

**Branch:** `feat/cc-2026-07-21-classifier-v3` (from `origin/main` @ `58fc113`)
**Files touched:** `src/scoring/task-purpose.ts`, `tests/task-purpose.test.ts`,
`tests/fixtures/purpose-gate-v3.provisional.jsonl`, `scripts/purpose-gate/count-v3-fixture.ts`
**Flag:** rides the EXISTING `REPID_PURPOSE_GATE_ENABLED` gate (`src/scoring/pipeline.ts:379`). No new flag, no new default-on behavior.

## What shipped

`classifyTaskPurpose()` was exact-match on `task_domain` (`d === 'evergreen'`, `d === 'cait'`, …).
Live traffic carries suffixed variants of the same families plus analysis chores, and every one of
them fell through the exact set to the DEFAULT (`deliverable`) — so a HAL cross-LLM veto could still
drain RepID on a task with no world-knowledge ground truth (the exact false-positive the purpose
gate exists to stop).

v3 adds **prefix-aware** matching of the tail families, purely additive.

### Domains added (prefix-aware, matched against `task_domain` only)

| Prefix | Purpose (weight 0) | Covers |
|---|---|---|
| `evergreen` | `operational` | `EVERGREEN_AUDIT` (+ v1 exact `evergreen`) |
| `diag` | `operational` | `diag_probe` |
| `shadow_reject` | `operational` | `SHADOW_REJECT` |
| `cait_eval` | `drill` | `cait_eval` (distinct from v1 exact `cait`) |
| `capability_gap` | `investigation` | `capability_gap` |
| `research` | `investigation` | research chores |
| `critique` | `investigation` | critique chores |
| `investigation` | `investigation` | investigation chores |

New `TaskPurpose` union member: `investigation` (additive; no member removed).

### Prefix logic + precedence (the invariants that keep it safe)

1. `DELIVERABLE_DOMAINS.has(d)` (exact) is checked **FIRST** — a real contracted deliverable can
   never be down-classified by a v3 prefix. Verified by test: every deliverable domain paired with
   ops-vocab bait still resolves `deliverable`, veto applies, weight 1.
2. The v3 prefix table runs **after** deliverable, **before** the prompt-text heuristics — `task_domain`
   is the reliable signal; prompt vocabulary stays secondary.
3. Matching is **case-insensitive** (`d` is lower-cased) and `startsWith` on `task_domain` only —
   never on prompt text.
4. All v3 tails return `halVetoApplies=false, weight=0` → the pipeline's symmetric `w_purpose`
   (`pipeline.ts:382`) zeroes the HAL delta in **both** directions (a chore is neither punished nor
   rewarded). No existing rule/domain/behavior removed.

## Before / after (PROVISIONAL fixture)

`scripts/purpose-gate/count-v3-fixture.ts` over `tests/fixtures/purpose-gate-v3.provisional.jsonl`
(13 rows; drawn/adapted from existing `tests/task-purpose.test.ts` prompts — **no claim of independent
provenance**):

```
fixture rows:            13
v1 non-deliverable:      2
v3 non-deliverable:      10
NEWLY non-deliverable:   8   (evergreen_audit, diag_probe, capability_gap, SHADOW_REJECT,
                              cait_eval, research, critique, investigation)
```

The 2 controls already suppressed by v1 (`evergreen`, `cait` exact) stay suppressed; the 3 deliverable
controls (`service_contract`, `code`, `some_new_domain`) stay scored — **0 false positives**.

## GA-1 dependency (the real oracle)

This fixture is **PROVISIONAL** and marked as such. GA-1's labeled corpus is the ground-truth oracle.
CC-2 re-runs the before/after count on GA-1 labels when they land; the numbers above are a smoke-level
demonstration of the mechanism, not a measured false-veto reduction.

## Go-live gate

v3 is inert until `REPID_PURPOSE_GATE_ENABLED` is on (already the live gate for PR #114's purpose gate).
Promote to live only when a **`--no-floor` replay on GA-1 labels** shows: (a) the false-veto rate on
tail domains DROPS, AND (b) **no real deliverable** is newly tagged non-deliverable (the false-positive
guard — must stay 0). Until that replay passes, v3 is shadow-safe additive classification only.

## Verification

- `npx tsc --noEmit` → exit 0.
- `npx jest --config jest.config.js tests/task-purpose.test.ts` → 50 passed / 50.
- `npx ts-node scripts/purpose-gate/count-v3-fixture.ts` → exit 0, mismatch guard clean.
