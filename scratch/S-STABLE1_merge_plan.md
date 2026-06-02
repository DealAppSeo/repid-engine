# S-STABLE1 — repid-engine Safe Merge/PR Plan (Stability-Tested)

**Date:** 2026-05-30  
**Branch:** feat/xc-s-stable1-2026-05-30 (XC isolated worktree)  
**Target:** C:\Users\Cash4\repos\repid-engine (read-only analysis via git worktrees)  
**Scope:** Design-only / plan-only. NO actual merges or code changes performed.

## Baseline (Main at 8771cb9)

**Environment reality in this setup (consistent across all tested branches):**
- Fresh detached worktrees do **not** have node_modules.
- `npx tsc --noEmit` fails with "This is not the tsc command you are looking for" (requires local typescript via `npm install` or `npm ci`).
- `npx jest --config jest.config.js --passWithNoTests --ci` fails with "Preset ts-jest not found" (same root cause: missing devDependencies).

**Therefore the true bar is:**
1. `npm ci` (or equivalent clean install)
2. `npx tsc --noEmit` → must be clean (0 errors)
3. `npx jest --config jest.config.js --ci` → all tests pass (or the project's normal test command)

This bar applies equally to main and every candidate. Any branch that cannot pass after a clean install is RED.

## GREEN / YELLOW / RED Classification of Top Candidates

The following branches were tested via temporary detached worktrees (created from the shared repo, cleaned up after). All reached the exact same environment-limited state as main:

**Tested candidates (from S-BRANCH1 high-priority REVIEW list):**

- feat/cc-2026-05-30-s-aud1 → Reached same state as main (no branch-specific tsc/jest breakage visible pre-install). **Classification: GREEN pending full `npm ci` verification**
- feat/cc-2026-05-30-rep1-cutover-proof → Same. **GREEN pending install**
- feat/cc-2026-05-30-crosscheck-harness → Same. **GREEN pending install**
- feat/cc-2026-05-30-hal-measurement → Same. **GREEN pending install**

**Untested but high-priority from S-BRANCH1 (recommend same process):**
- feat/cc-2026-05-29-hal-truth-repair
- feat/cc-2026-05-29-zkp-anchoring-closure
- feat/ga-2026-05-30-agent-spoofing-fix (and related GA authority/observability tips)

**Overall finding:** No recent high-value CC/GA branch showed obvious compile or test breakage that would make it worse than main in a pre-install state. All are viable candidates for the full `npm ci + tsc + jest` gate in a proper environment.

**RED branches (from inventory, not recommended even for testing in this round):**
- Any `wip/*` (explicit "DO NOT MERGE")
- Most recent `feat/xc-*` design branches (our own sprint artifacts — useful as reference, not for merge)

## Safe Merge-Order PR Plan (Only GREEN branches)

**Prerequisite for every PR:**
- The branch must pass `npm ci && npx tsc --noEmit && npx jest --config jest.config.js --ci` (or the project's documented equivalent) on a clean machine/CI runner.
- Only branches that are GREEN after this gate get a PR.

**Recommended order (lowest risk / highest current value first, after the above gate):**

1. **feat/cc-2026-05-30-hal-measurement** (and closely related feat/cc-2026-05-29-hal-truth-repair)
   - Why first: Directly supports active HAL measurement / truth efforts. Low ahead count. High team value.
   - Likely conflicts: Minimal (mostly new measurement harness + minor scorer routing).
   - PR title: `feat(hal): labeled-corpus measurement runner + discriminative fact-check scorer (S-HAL1/S-HAL2)`
   - Description: Adds the P0 measurement infrastructure and flag-gated truth-repair path. Includes verification that tsc is clean and full test suite passes.
   - Verification in PR: Link to CI run showing `tsc --noEmit` clean + jest pass on the merge commit.

2. **feat/cc-2026-05-30-s-aud1**
   - Why: Delivers the hash-chained audit trail + tool_call_log (foundational for current audit push).
   - Likely conflicts: With other recent audit-related changes (check against crosscheck-harness and RepID cutover branches).
   - PR title: `feat(audit): S-AUD1 hash-chained audit trail + tool_call_log (DESIGN-ONLY reviewed)`
   - Description: Adds the audit chain infrastructure with proper serialization and locking. Full stability gate passed.
   - Verification: CI showing clean tsc + passing tests; mention of the S-APPLY1 review.

3. **feat/cc-2026-05-30-rep1-cutover-proof**
   - Why: Directly unblocks the RepID single-applier cutover (high current priority).
   - Likely conflicts: With other RepID-related recent branches (writer-cutover, integrity, etc.).
   - PR title: `feat(repid): S-REP1 cutover readiness — gate 2 fixes + real-delta proof`
   - Description: Addresses missed sites in the RepID aggregator cutover and adds proof of real delta application.
   - Verification: Stability gate + explicit note that this is part of the coordinated RepID cutover sequence.

4. **feat/cc-2026-05-30-crosscheck-harness**
   - Why: Provides the swarm-throughput / concurrency verification harness (directly supports our current concurrency verification work).
   - Likely conflicts: Low, but coordinate with any GA concurrency work once located.
   - PR title: `feat(verify): swarm-throughput crosscheck harness (concurrency must be real)`
   - Description: Adds the harness to detect serial vs parallel execution in the agent swarm.
   - Verification: Stability gate + example run showing it correctly identifies concurrency state.

**Later / conditional (after the above and after any missing endpoints from S-SDK1 are implemented):**
- feat/cc-2026-05-29-zkp-anchoring-closure (ZKP work — lower immediate blast radius)

## Conflict Predictions (high-level)

- Audit-related branches (s-aud1, crosscheck-harness, hal-measurement) may touch overlapping files in `src/services/`, `src/routes/audit*`, and hal_* writers.
- RepID cutover branches (rep1-cutover-proof + our prior XC RepID work) will touch `src/scoring/pipeline.ts`, the aggregator, and related RepID paths — review together.
- GA authority/spoofing branches touch authority math — high risk of subtle conflicts with any RepID or stake logic; hold for dedicated review session with Sean.

## Final Recommendation to Sean

1. Run the full stability gate (`npm ci && tsc && jest`) on the shortlist above in a clean CI or local environment.
2. Only the ones that come back GREEN after the gate get PRs.
3. Merge in the order listed (HAL measurement first for quick win, then the audit and RepID cutover items that are actively blocked on each other).
4. Treat the GA authority cluster as a separate review wave.

All of the above is a **plan only**. No merges, no PRs created, no code changed in the shared repo.

---

**End of S-STABLE1_merge_plan.md**