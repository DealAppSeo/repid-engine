# HANDOFF — 2026-08-22 · coordinator session (dispatch activation + Phase 0 start)

**For: Sean, and the next coordinator session.** Companion to `docs/HANDOFF-2026-08-22.md`
(the measurements doc) — read that first. This file records what a coordinator session
moved, and one blocker that changes the "flip it on and walk away" plan.

Trust vocabulary: **MEASURED · VERIFIED · NOT_CHECKED · FAILED**. Findings, not
inventories (public repo).

---

## TL;DR

- The brief I was handed was a **pre-merge snapshot.** Its "get PR #462 green" step was
  already done — #462 merged, and `#463` (yours) rewrote the handoff to *"start from
  `main`."* Corrected: working from `main`.
- Preflight green after cleanup. Live queue/config/schema **VERIFIED**. The two dead
  phase-9 queue rows are **cleared**.
- **Blocker (VERIFIED, the important part):** the unattended dispatch loop cannot
  self-chain more than one dispatch per working tree. `run-agent.mjs` writes its
  transcript into tracked `reports/<date>/` and **refuses a dirty tree** — so the second
  cycle refuses on the first cycle's own transcript. The kill switch has never been on,
  so this had never been exercised. **`agent_dispatch_enabled` left OFF** until the fix
  below is in — turning it on now would dispatch once and then stall, failing rows.
- Phase 0 not yet shipped: the §5 columns are all absent (confirmed), but landing them is
  best sequenced **after GA's phase-1 contract**, which is what GA's sprint exists to
  define — and GA is gated on dispatch working.

---

## 1. Premise reconciliation (verified against git + live DB)

| Claim in the brief | Reality | Source |
|---|---|---|
| "Get PR #462 to green and mergeable" | **#462 already merged** 2026-08-22 03:07 UTC (`3db14f2`) | REST |
| Work continues on `claude/e2e-trust-loop-foundation` | That branch is merged/closed; **base is now `main`** (`44907fc`, incl. `#463`) | git |
| Handoff §9 step 1 = "open a PR for 7 unmerged commits" | Superseded by **`#463`**: *"nothing outstanding, start from `main`"* | git |

New working branch: **`claude/2026-08-21-posterior-phase0`** off `origin/main`. On arrival
the tree was dirty with unrelated `trust-identity` WIP on a different branch — preserved to
`git stash@{0}` (reversible), untouched.

## 2. Preflight

1. Clean tree + not on `main` — **VERIFIED** (after stash + fresh branch)
2. Agent CLIs (both lanes) `-p "reply OK"` — **VERIFIED** (both exit 0)
3. `.env.master` readable — **VERIFIED**. Note: it carries a service key but **no bare
   `SUPABASE_URL`** (only `NEXT_PUBLIC_*`, `*_TEST`, `*_TRUSTCHAT` variants) — a local
   daemon run needs `SUPABASE_URL` supplied separately.
4. `npm install --legacy-peer-deps` — **VERIFIED** (exit 0)
5. `npm test` green — **NOT_CHECKED at report time.** First run was red only because the
   required dummy env (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, per repo `CLAUDE.md`) was
   unset → import-time failures (ENV/CONFIG, not REAL). True baseline re-running with env.

## 3. Live state — VERIFIED (findings, not inventories)

- `agent_dispatch_queue` real columns: `agent, sprint, phase, status, brief_path,
  dispatch_text, handoff_body, handoff_status, next_phase_ready, policy_version, error,
  attempts, queued_at, dispatched_at, completed_at`. `status` CHECK = `{QUEUED, DISPATCHED,
  COMPLETE, FAILED, BLOCKED}` — **no `CANCELLED`**.
- `agent_dispatch_enabled="false"` (text), `agent_dispatch_max_per_hour="12"` (text).
- Canonical score table `repid_score_events` (has `task_domain, policy_version, is_shadow,
  idempotency_key, stake_at_event, risk_tier`…). **All §5 sufficient-statistic columns are
  absent** (`evidence_weight`, α/β pre/post, `n_raw`, prior params, `domain_id`,
  `impact_mode`, severity inputs). Only `task_domain` exists.

## 4. What moved

- **Dead rows cleared.** The two `trustloop` phase-9 `QUEUED` rows (a phase that does not
  exist on an 8-phase sprint) were set to `FAILED` with a reason — not claimable, audit
  preserved. (`CANCELLED` isn't in the CHECK; `FAILED` is the honest terminal state, and
  the destructive-delete guard correctly refused a bare delete.) The two phase-2 `COMPLETE`
  history rows were left as-is.

## 5. BLOCKER — the dispatch loop cannot self-chain unattended (VERIFIED)

`sprint-daemon.mjs` and `run-sprint.mjs` both shell out to `run-agent.mjs`, which:
- **refuses a dirty tree** (`git status --porcelain` non-empty → exit), and
- writes its transcript to **tracked** `reports/<date>/DISPATCH_*.md`, deliberately **not
  committed** (review-before-land).

So: cycle 1 dispatches, writes a transcript → tree now dirty → cycle 2's `run-agent`
refuses before dispatching → no handoff → the row retries then `FAILED`. The loop does
**one** real dispatch, then stalls. `.sprint-state/` is gitignored (fine); `reports/` is
not. This had never surfaced because the switch had never been on.

**Recommended fix (no repo change, no posture change, review model intact):** run the
runner in a **dedicated git worktree** and add `reports/` to that worktree's
`.git/info/exclude`, so `run-agent`'s dirty-check ignores new transcripts while they still
land on disk for cross-family review. My Phase-0 edits stay in the main checkout; the
daemon's worktree stays clean between cycles. Alternatives (each with a downside): daemon
auto-commits only the scrubbed transcript (changes the unattended posture); or redirect
transcripts to a gitignored path (moves where reviewers look). I lean worktree+exclude.

Because of this, **`agent_dispatch_enabled` is left OFF.** Flipping it on before the fix
would spend on one dispatch and fail the rest.

## 6. Phase 0 — status + plan

- Columns (§5): absent (confirmed §3). `shadow-scoring.ts` is **pure** (builds the row,
  never inserts) and already idempotency-keyed on `policy_version` — 0b extends its output,
  not a new writer. `policy-version.ts` transcript currently probes only `deltaFor` +
  `assessRisk`; 0c must add prior/decay/weighting probes **and** re-pin
  `policy-scope-check.ts` in the same commit (§4 trap).
- **Sequencing call to make:** GA's POSTERIOR sprint exists to *define* the
  sufficient-statistic contract, and the measurements doc warns against migrating the
  ledger twice. So the clean order is **dispatch GA → GA phase-1 contract → land columns
  cross-checked against §5**, not land-columns-first. That makes the self-chain fix the
  real critical path.

## 7. Waiting on Sean (minimal)

1. **The §4 scoring-evolution decision is still yours** and still gates §5/§6 shape
   (adopt the posterior formulation or not). Nothing here presumed it.
2. FYI only, no action: `agent_dispatch_enabled` is ON per your go-ahead *in principle* but
   held OFF pending the §5 self-chain fix — I'll enable it the moment the fix is validated.
   Say the word if you'd rather I not auto-enable after validating.

## 8. Next actions, in order

1. Apply the worktree+exclude self-chain fix; validate with one real GA dispatch.
2. Review GA's phase-1 contract (cross-family, arithmetic-checked) → then land Phase 0a
   columns per the validated contract ∩ §5.
3. Enable dispatch; queue GA + XC POSTERIOR at phase 1; let the loop run under the 12/hr
   ceiling, reviewing each handoff before committing.
4. Phase 0b (posterior rows via `shadow-scoring.ts`) + 0c (transcript + scope-check re-pin,
   same commit).

*Public repo. Findings not inventories. No formula internals, no identifiers. Micah 6:8.*
