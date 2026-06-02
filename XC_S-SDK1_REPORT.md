# XC S-SDK1 Report — TrustShell SDK Interface + Reputation Inheritance

**Date:** 2026-05-30  
**Branch:** feat/xc-s-sdk1-2026-05-30 (isolated XC worktree)  
**Status:** Design-only complete. No DB changes or production code modifications.

## Executive Summary

Two focused design artifacts were produced in `scratch/`:

1. **S-SDK1_trustshell_interface_spec.md**  
   - Exact TypeScript + Python signatures for the three mandated methods (`score`, `verify`, `audit`).  
   - Clear mapping to repid-engine endpoints.  
   - BUILT vs NEEDS_BACKEND matrix (as of 2026-05-30).  
   - Auth model (API key pattern), rate limits, and standardized error shapes.  
   - Aligns with the broader surface already present in the trustshell skeleton's `docs/api-reference.md`.

2. **S-SDK1_reputation_inheritance_spec.md**  
   - Precise rule: `effective_repid = MIN(own_repid, delegator_repid)` evaluated at delegation/tool-call time.  
   - Data model centered on `tool_call_log` (S-AUD1 dependency) + supporting structures.  
   - Exact gating points identified in `constitutional-agent-base.js` (delegateToTool, claim/process paths, spawnNextStep, genesis logic).  
   - Full edge-case coverage and break-risk analysis.

## Key Design Decisions

- The three SDK methods form the **minimal stable public contract** that all TrustShell consumers should target.
- Reputation inheritance is enforced at the point of delegation (not only at genesis).
- The 70-point HITL floor is absolute under delegation.
- Max delegation depth of 3 is a hard anti-laundering control.
- All changes are intended to be behind feature flags until S-AUD1, critical RLS batches, and S-REP3 are live.

## Isolation & Scope

- All work performed exclusively in the XC isolated worktree on the dedicated branch.
- Read-only analysis only on the `trustshell` skeleton and the GA shared repo (constitutional-agent-base.js).
- Pure design-only output. No migrations, no code changes, no DB modifications.

## Handoff

The two spec files in `scratch/` are self-contained and ready for review by CC / Cowork / relevant owners (SDK implementers for the interface; GA/shared owners for the inheritance gating).

When alignment is reached, the specs can move to implementation (with appropriate feature flags for the inheritance piece).

---

**End of XC_S-SDK1_REPORT.md**

Design-only sprint complete in isolated XC worktree. Ready for handoff.