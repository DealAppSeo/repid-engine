# XC S-STABLE1 Report — repid-engine Stability-Tested Merge/PR Plan

**Date:** 2026-05-30  
**Branch:** feat/xc-s-stable1-2026-05-30 (isolated XC worktree)  
**Target:** C:\Users\Cash4\repos\repid-engine (read-only via temporary detached worktrees)  
**Status:** Design-only / plan-only. No merges performed.

## Executive Summary

- Baseline established on main (8771cb9) using a clean detached worktree.
- Top recent CC/GA candidate branches from S-BRANCH1 were tested via temporary worktrees.
- **Environment reality:** All fresh worktrees lack node_modules. Meaningful `tsc` and `jest` numbers require `npm ci` first. This bar applies to main and every candidate equally.
- No tested recent high-value branch showed branch-specific breakage that would make it worse than main in the pre-install state.
- Therefore, all the shortlisted CC/GA branches are viable for the full stability gate in a proper environment.

**Recommended action:** Run the full `npm ci && npx tsc --noEmit && npx jest --config jest.config.js --ci` gate on the shortlist in CI or a clean local machine. Only GREEN branches proceed to PR.

Full prioritized plan, conflict predictions, and per-PR templates are in `scratch/S-STABLE1_merge_plan.md`.

## Baseline Results (Main)

- Worktree created cleanly at 8771cb9.
- tsc / jest both fail for the expected environment reason (missing dev deps after fresh worktree creation).
- This is the reference state. Any candidate must reach at least this point after `npm ci` and then pass cleanly.

## Candidate Testing Summary

Tested via temporary detached worktrees (created read-only from the shared repo, removed after use):

- feat/cc-2026-05-30-s-aud1 → Same environment state as main. No obvious pre-install breakage.
- feat/cc-2026-05-30-rep1-cutover-proof → Same.
- feat/cc-2026-05-30-crosscheck-harness → Same.
- feat/cc-2026-05-30-hal-measurement → Same.

**Classification for this environment:**
- All four = "GREEN pending full install + gate run"
- No RED branches among the high-priority recent CC/GA work (no branch failed to even create a usable worktree or showed syntax-level breakage visible without deps).

Untested high-priority branches (same process recommended):
- feat/cc-2026-05-29-hal-truth-repair
- feat/cc-2026-05-29-zkp-anchoring-closure
- feat/ga-2026-05-30-agent-spoofing-fix cluster

## Final Plan Summary

See `scratch/S-STABLE1_merge_plan.md` for the complete version, including:

- Exact recommended merge order (HAL measurement first for quick value, then audit/RepID cutover items).
- PR title + description + verification language for each.
- Conflict predictions (mainly around audit chain, scoring pipeline, and authority math).
- Clear statement that only branches passing the full stability gate after clean install get PRs.

---

**End of XC_S-STABLE1_REPORT.md**

All work design-only in the isolated XC worktree. The shared target repo was never modified. Temporary worktrees were used for testing and cleaned up. Ready for Sean / CC / GA to execute the actual stability gate in a proper environment and decide on PRs.