# XC S-BRANCH1 Report — repid-engine Branch Debt Inventory

**Date:** 2026-05-30  
**Branch:** feat/xc-s-branch1-2026-05-30 (isolated XC worktree)  
**Target repo (read-only):** C:\Users\Cash4\repos\repid-engine  
**Scope:** Design-only inventory and analysis. No merges or edits performed on the shared repo.

## Executive Summary

The shared `repid-engine` has significant branch debt (~140 feature branches, very few merged to main). Recent activity is dominated by CC and GA sprints around audit, RepID cutover, HAL measurement, and authority fixes.

**Key finding on GA's T12 concurrency claim:** No evidence of MAX_CONCURRENCY, async parallel task spawn, or the claimed atomic claiming logic was found in any feat/ga-* branch or the main codebase. The terms appear only in incidental comments about "atomic claim" patterns in workers. The fix does not live in repid-engine's recent GA branches.

**Recommended high-level apply order (for Sean):**
1. Recent high-value CC branches around S-AUD1 / audit, RepID cutover proof, HAL measurement/truth-repair (after CC/Cowork review).
2. GA authority/spoofing/observability fixes (they share tips and look related).
3. Archive or selectively merge useful XC design artifacts from our own sprints.
4. Explicitly do not merge any "wip/" or "DO NOT MERGE" branches.

Full details, tables, and per-branch flags below.

## TASK 1: Inventory of the 20 Most Recent Branches

Data pulled via read-only `git -C` on the target repo (sorted by committerdate descending, enriched with ahead-of-main count and subject).

| # | Branch | Last Commit | Ahead of main | Last Subject (one-line) | Recommended Flag |
|---|--------|-------------|---------------|-------------------------|------------------|
| 1 | feat/cc-2026-05-30-s-aud1 | 2026-05-30 | 2 | feat(audit): S-AUD1 hash-chained audit trail + tool_call_log (DESIGN-ONLY) | REVIEW (high value, recent CC audit work) |
| 2 | feat/cc-2026-05-30-rep1-cutover-proof | 2026-05-30 | 4 | feat(repid): S-REP1 cutover readiness — gate 2 missed sites + fix aggregator import + real-delta proof | REVIEW (directly relevant to ongoing RepID cutover) |
| 3 | feat/cc-2026-05-30-crosscheck-harness | 2026-05-30 | 4 | feat(verify): swarm-throughput check — concurrency must be real, not serial | REVIEW (ties directly to the concurrency verification we are doing) |
| 4 | feat/cc-2026-05-29-zkp-anchoring-closure | 2026-05-30 | 3 | feat(zkp): S-ZK1 REST anchor variant (no DATABASE_URL) + apply post-26306 epoch | REVIEW (ZKP work, recent) |
| 5 | feat/ga-2026-05-30-agent-spoofing-fix | 2026-05-29 | 6 | feat(ga): lock authority math and fix failure latency logging | REVIEW (GA authority/spoofing fix — candidate for merge after review) |
| 6 | feat/ga-observability-2026-05-29 | 2026-05-29 | 6 | feat(ga): lock authority math and fix failure latency logging | REVIEW (same tip as above; related GA observability work) |
| 7 | recovery/ga-authority-2026-05-30 | 2026-05-29 | 6 | feat(ga): lock authority math and fix failure latency logging | REVIEW (recovery variant of the GA authority work) |
| 8 | feat/cc-2026-05-30-hal-measurement | 2026-05-29 | 1 | measure(hal): labeled-corpus runner → hal_runner_results (P0 measurement, no scoring change) | REVIEW (directly supports current HAL measurement efforts) |
| 9 | feat/cc-2026-05-29-hal-truth-repair | 2026-05-29 | 1 | fix(hal): route live score-event pipeline through the discriminative fact-check scorer (flag-gated) | REVIEW (HAL truth/repair work) |
|10 | feat/xc-hal-repid-legibility-2026-05-29 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE or selective merge (our own design artifact; useful reference) |
|11 | feat/xc-repid-integrity-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (duplicate of above from our sprints) |
|12 | feat/xc-repid-writer-cutover-2026-05-29 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (our prior work) |
|13 | feat/xc-rls-remediation-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (our prior RLS work) |
|14 | feat/xc-s-apply1-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (our prior work) |
|15 | feat/xc-s-branch1-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (current sprint branch) |
|16 | feat/xc-s-sdk1-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (our prior SDK work) |
|17 | feat/xc-s-sec3-s-pub0-2026-05-30 | 2026-05-29 | 3 | feat(repid): reversible WRITER_DIRECT_APPLY flag + single-applier cutover (D-054/D-055) | ARCHIVE (our prior work) |
|18 | feat/xc-repid-sync-2026-05-29 | 2026-05-29 | 2 | feat(repid): idempotent sync aggregator (XC 2026-05-29) | ARCHIVE or selective merge (our RepID sync design) |
|19 | wip/hal-scorer-recalibration-2026-05-29 | 2026-05-29 | 1 | wip(hal-scorer): PARK co-mingled HAL scorer recalibration edits — DO NOT MERGE | ARCHIVE (explicit "DO NOT MERGE") |
|20 | wip/worktree-snapshot-2026-05-29 | 2026-05-29 | 3 | WIP snapshot: preserve dirty shared worktree before isolation [2026-05-29] | ARCHIVE (explicit WIP snapshot, not for merge) |

**Notes on the list:**
- Many recent XC branches share the same tip and message because they are worktrees created from the same base commit for our own sprints. They are effectively snapshots of design work.
- The truly "live" recent development is concentrated in the feat/cc-* (audit, RepID cutover, HAL measurement) and feat/ga-* (authority/spoofing/observability) lines.
- Several branches are already at low ahead counts (1–4), making them easier candidates for review/merge.

## TASK 2: GA's Claimed T12 Concurrency Fix

**Search performed:** Full repo grep + targeted searches in all feat/ga-* branches for MAX_CONCURRENCY, async task spawn / parallel execution, atomic claiming logic on trinity_tasks, runLoop changes, etc.

**Result:** No evidence found.

- No constant or configuration named MAX_CONCURRENCY (or similar) exists in any feat/ga-* branch or main.
- Mentions of "atomic claim" appear only as comments in worker files (validation-queue-worker, dispute-resolution, etc.) describing workarounds because Supabase `.update()` does not provide native row-level locking/returning for queues.
- No async parallel task spawning or bounded concurrency pool inside the runLoop or ConstitutionalAgent logic was located in the recent GA branches.
- The two most recent feat/ga-* branches (feat/ga-2026-05-30-agent-spoofing-fix and feat/ga-observability-2026-05-29) share the same tip and focus on authority math locking + failure latency logging — no concurrency executor changes.

**Cross-check note:** As the user suspected, if the fix exists it is not visible in repid-engine's recent GA branches. It may live only in the trinity-symphony-shared-ga repo (or a private/unpushed branch), or the claim may refer to planned/intended work rather than shipped code.

**Recommendation:** This item should be treated as "not yet located in the expected place." GA should be asked to point to the exact commit/branch containing the MAX_CONCURRENCY + async spawn + atomic claiming implementation before any merge discussion.

## TASK 3: Merge-to-Main Plan

**Recommended order (highest value / lowest immediate risk first):**

1. **feat/cc-2026-05-30-hal-measurement** and **feat/cc-2026-05-29-hal-truth-repair** (low ahead count, directly support current HAL measurement / truth efforts that are active across teams).

2. **feat/cc-2026-05-30-s-aud1** (S-AUD1 audit trail + tool_call_log — high value for the current audit push; review the design-only note in the subject).

3. The cluster of recent **feat/ga-*-authority/spoofing/observability** branches (they appear related and address real production issues around authority math and latency). These share tips and should be reviewed together for conflicts.

4. **feat/cc-2026-05-30-rep1-cutover-proof** and **feat/cc-2026-05-30-crosscheck-harness** (directly tied to RepID cutover and concurrency verification work we are doing right now).

5. **feat/cc-2026-05-29-zkp-anchoring-closure** (ZKP anchoring work; lower risk, useful for the ZKP track).

**Items to explicitly archive / not merge (at least not yet):**
- All the recent `feat/xc-*` branches from our own sprints (they are design artifacts and worktree snapshots; useful as reference but not production merges).
- Any `wip/*` branches (explicit "DO NOT MERGE" in subjects).
- `recovery/ga-authority-2026-05-30` (recovery branch — review what it recovered vs the feat/ga- versions).

**Likely conflicts / review needs:**
- Any branches touching `hal_audit_chain`, `append_hal_audit_chain`, or the scoring pipeline will likely conflict with each other and with the S-AUD1 work.
- Authority math changes in the GA cluster will need careful diffing against any RepID / authority paths touched by CC RepID cutover branches.
- Sean review is required for anything touching production scoring paths, audit chains, or authority calculations (especially the GA authority/spoofing cluster).

**Suggested process for Sean:**
- Start with the low-ahead CC HAL measurement + truth-repair branches (quick wins, support active work).
- Then the S-AUD1 and RepID cutover proof branches (high current relevance).
- Hold the GA authority cluster for a dedicated review session (they are the riskiest for subtle math changes).
- Archive the XC design branches after extracting any useful SQL/docs into living docs or the main tree where appropriate.

---

**End of XC_S-BRANCH1_REPORT.md**

All analysis read-only on the target repo via git -C from the isolated XC worktree. No branches were modified or merged. Ready for handoff to Sean / CC / GA for the actual merge decisions.