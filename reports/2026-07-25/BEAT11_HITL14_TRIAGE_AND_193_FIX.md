# Beat 11 — HITL-14 triage + PR #193 8th-site fix
**Date:** 2026-07-26 · autonomous build-loop · all findings read-only SQL vs `qnnpjhlxljtqyigedwkb` unless noted.

## Part A — STEP 2: Beat 10 (PR #193) independently verified → real defect found + fixed

An independent `verifier` subagent (rule 3; did NOT produce #193) adversarially re-checked the SUPABASE_SECRET_KEY migration. Claims 1/2/3/5 hold [V]. **Claim 4 REFUTED — real latent defect:**

- **8th live site missed:** `src/routes/hal-test.ts:5-8` built its own Supabase client with the pre-migration `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_KEY || 'dummy-key'` pattern. Live-mounted (`index.ts:39` + `:236`, `POST /api/v1/hal-benchmark/run`). On a rotation to **only** `SUPABASE_SECRET_KEY` it would silently fall back to `'dummy-key'` — the exact silent-fail #193 exists to prevent. Git history (`fa51817`) had grouped it with `telegram.ts`/`hal-tester.ts`; #193 migrated 2 of those 3 siblings and skipped the third.
- The verifier also noted #193's own suggested self-verify grep (`grep -rn "SUPABASE_SECRET_KEY" src`) is **circular** — it can only count already-fixed sites, never surface a missed one. The catch required grepping the *legacy* names.

**Fix shipped (commit `8529a9e`, on the #193 branch):** applied the SECRET_KEY-first chain from sibling `hal-tester.ts`. `tsc --noEmit` clean; gitleaks clean; env-var-NAME only. Re-enumerated `src/` — **no remaining legacy-only Supabase service-key read sites**; all 8 now resolve `SUPABASE_SECRET_KEY` first. PR title updated 7→8; verification note posted as a PR comment.

**Penalty verdict (rule 3): NONE.** Beat 10 did not self-validate — a *different* agent caught this, exactly as the loop is designed to. Beat 10's error was an honest **incompleteness + a 7-site overclaim** in the PR title, not a faked pass. Corrected here + in the PR.

## Part B — STEP 3: the "14 HITL pending over 24h" `/health` metric is STALE (verify-first diagnostic)

`/health` reports `processing_hitl_pending_over_24h: 14`. Resolving those 14 `validation_queue` rows (all `status='processing'`) against their underlying `hitl_requests`:

| Underlying `hitl_requests.status` | count | note |
|---|---:|---|
| **expired** | **13** | 7-day window lapsed; oldest expired 2026-05-24, newest 2026-07-16; `resolved_at` all NULL |
| **pending** | **1** | id `62705ebb…`, task 434999, created 2026-07-25, expires 2026-08-01 |

- **The desync bug:** when a `hitl_request` expires, its `validation_queue` row is **not** advanced out of `status='processing'` → `/health` counts all 14 forever. The HITL-pending signal is therefore **permanently pinned near 14 and cannot surface a genuinely new pending item** (it would just be lost in the noise). This is a `validation_queue` ↔ `hitl_requests` reconciliation gap (`validation-queue-worker.ts` updates the row to `processing` on escalation but nothing reconciles it when the request later expires).
- **Content = 100% internal churn, 0 external deliverables:** every one is a `judge_escalated` / `judge_pcp_disagreement` / `pcp_low_confidence` escalation on an **internal swarm task** — HAL/canary/deception **corpus-building**, peer-review reports, an architecture explainer, and (the one live pending) an **ANFIS/LASSO glossary**. None is a customer/economic contract. Most are `pcpScore ~0.95` + adversarial-judge `CHALLENGE` (validators passed, the judge disagreed) on corpus work.

**So the honest reading of "14 humans-owed reviews": there is effectively nothing urgent here.** 13 are long-expired internal-corpus escalations (the review window closed weeks ago); 1 is a trivial internal glossary task with a week left. The real item is a **small monitoring-hygiene reconciliation**, not 14 pending decisions.

**Recommended fix (teed up, NOT shipped this beat — 6 PRs already await Sean; not stacking a 7th unprompted):** a bounded reconciliation that transitions a `validation_queue` row to a terminal `status` (e.g. `expired`/`timeout`) once its `hitl_request.status IN ('expired','resolved')`. One-time SQL backfill for the current 13 + a guard in the queue worker's periodic sweep so `/health`'s HITL signal becomes trustworthy again. Shadow-first / read-verify before any write. Small vision-adjacent question for Sean: should adversarial-judge `CHALLENGE` on **internal corpus** tasks escalate to HITL at all, or auto-resolve (it's the enqueue-churn pattern in miniature).

## Ground truth this beat [V]
- Live `/health`: `deployed_commit=ccb9c32`, `supabaseConnected=true`, HashKey chainId 177 @ block 25,347,694.
- Open loop PRs all MERGEABLE: #190, #188, #189, #191, #192, #193 (+ older #157/#155). None merged (Sean not present).
