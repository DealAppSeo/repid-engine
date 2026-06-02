# XC S-APPLY1 Report — Co-Sign Backlog Processing

**Date:** 2026-05-30  
**Branch:** feat/xc-s-apply1-2026-05-30 (isolated XC worktree)  
**Status:** Design-only / review complete. No objects applied.

## Executive Summary

Three pending design-only items were reviewed for break-risk in the context of the existing co-sign backlog:

1. CC's S-AUD1 audit chain migration (reviewed via existing hal_audit_chain logic present in the checkout).
2. S-SDK1 TrustShell SDK interface (3 core methods).
3. S-SEC3 RLS Agent-State (74 tables) + sensitive OTHER triage.

**Recommended apply order (lowest risk / highest impact first):**
- S-SEC3 Agent-State core + sensitive OTHER (P1)
- S-AUD1 audit chain logic (P2, once the exact final migration is provided)
- S-SDK1 surface (P3, only after missing audit-chain verification endpoint is implemented)

Full details, per-item risks, verification queries, and exact rollback commands are in `scratch/S-APPLY1_cosign_queue.md`.

## Review Findings (High Level)

**S-AUD1 / Audit Chain:**
- Existing append logic correctly uses advisory xact lock and caller-supplied canonical JSON text (not row::text).
- Ordering on the chain table is by internal id (correct for the chain itself).
- For UUID-based source events, callers must ensure deterministic "previous" selection via (created_at, id).
- Risk: single global lock key could serialize high-volume writers; caller canonicalization mismatch breaks verification.
- Gap: The specific S-AUD1_migration.sql file referenced was not present in this checkout.

**S-SDK1:**
- score() and verify() map to largely built endpoints.
- audit() has a material gap (full chainStatus + broken detection walker not complete in reviewed routes).
- Matrix and gap analysis in the queue document.

**S-SEC3:**
- Sensitive OTHER correctly elevated with service_role-first policies.
- No anon-key write paths found for the listed sensitive tables in src/ (all writes via service_role client).
- Low break-risk for backend.

## Next Steps

1. CC to provide/confirm the final S-AUD1 migration file for detailed review.
2. Implement the missing audit chain verification endpoint (unblocks S-SDK1 P3).
3. CC verification + Cowork co-sign per batch before Sean applies.

All work design-only in isolated XC worktree. No changes applied.

---

**End of XC_S-APPLY1_REPORT.md**