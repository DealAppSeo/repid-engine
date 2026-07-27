# Lessons Learned — 2026-07-25 → 27 sprint (consolidated)
Distilled from the 34 loop beats + this session. Format: lesson · why · how-to-apply. (Per-beat detail lives in the ledger.)

## What WORKED — keep doing
1. **Independent-verify-EVERY-beat (no self-validation) is the quality engine.** The loop caught its OWN defects: ReDoS bypasses inside its own PRs (Beats 31–33), a nightly smoke test that FABRICATED (18 runs, 0 real measurements, masking a public 500 — Beat 30), and several overclaims (Beats 6, 14). *Apply:* the producer never signs off; a fresh independent check does — this is non-negotiable and it pays for itself.
2. **Shadow-first discipline held.** Every scoring/routing change (HAL grounding, ANFIS, purpose-gate v3) shipped default-inert + flag-gated → byte-identical live behavior, measurement before enforce. *Apply:* never flip an enable-flag without measure + Sean GO.
3. **Schema-first before any prod write.** The `agent_services` insert failed on a FK to `service_categories` — caught by reading the schema first, not by a broken prod write. *Apply:* read columns + constraints (incl. FKs/triggers) before INSERT/DDL.
4. **Reuse the rail.** P3 EAS-anchoring reused `eas-attestation-service` (no new schema); demo-trio found 2 of 3 services already existed. *Apply:* CLAUDE-RULE-1 — show what exists first; build only the gap.

## MISTAKES — logged, owned, fixed
5. **Producing PRs faster than they merge → an 18-PR pile-up.** The loop's output isn't landing (main unchanged since #199), so stacks deepen + conflict risk grows and the work doesn't compound. *Apply:* match production rate to merge rate — enable auto-merge or a scheduled sweep; treat "merged" as the real done, not "PR opened."
6. **Self-inflicted `node_modules` wipe** (Beat 27) — a worktree op followed a `node_modules` junction and deleted the real one. *Apply:* never junction node_modules into a worktree; `rmdir` the junction before `git worktree remove --force`. (Already in memory.)
7. **gitleaks false-positives on a security tool's own fixtures** (P0 test `sk-…` string; the security-audit rules + fixtures; ANFIS canary; a `…_api_keys` table name in a doc). *Apply:* fix with inline `gitleaks:allow` on intentional fixtures — NEVER `--no-verify`. A secret scanner tripping on a security tool is expected, not a reason to bypass.
8. **Overclaim risk when reporting.** Beats 6/14 caught earlier beats' overstated claims. *Apply:* [V] vs [R] tags; a number is [R] until a query/tx proves it.
9. **Duplicate-investigation waste** (Beat 24) — re-investigated something already diagnosed. *Apply:* read the ledger/reports before starting; don't re-derive.

## Tooling patterns that emerged (reusable)
- **Local pre-CI logic check without worktree node_modules:** run the pure logic via the main repo's `tsx` with `NODE_PATH=<main>/node_modules` (+ async IIFE — tsx cjs has no top-level await). CI does the full tsc+jest.
- **Crypto hygiene backlog:** P0/P1 reference Merkle duplicates odd nodes (CVE-2012-2459) + no leaf/node domain separation — harden before load-bearing.
