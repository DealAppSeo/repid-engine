# XC MARATHON SPRINT: S-SECURE — Security Hardening + Branch Cleanup + Harmonia Schema

**Date:** 2026-06-02  
**Branch:** feat/xc-2026-06-02-security-hardening (isolated XC worktree)  
**Read-only targets:** repid-engine, trinity-symphony-shared (and -ga), trustchat-backend  
**Status:** ALL 7 PHASES COMPLETE. No shared-repo writes. Design-only where noted.

## Executive Summary

Executed the full 7-phase marathon without pause.

**Key outcomes:**
- **Secrets (Phase 1):** 19 alerts triaged. 2 repos have committed .env with real production secrets (Supabase service_role + LLM keys). P0: rotate + remove + history purge.
- **Deps (Phase 2):** repid-engine 1 critical + 4 high (protobufjs code exec risk); others moderate/high.
- **Pen-test (Phase 3):** NEEDS WORK. Strong on RLS/audit/HTTPS/auth boundaries. Blocked by secrets + supply chain criticals + rate-limit gaps.
- **Branches (Phase 4):** Engine ~171 remotes (101 merged safe); trinity ~31 (17 merged). Script produced for Sean (NOT executed).
- **Harmonia (Phase 5):** Apply-ready SQL with RLS, seeds, hash-chain notes, pre-flight. Design-only.
- **GA Docs (Phase 6):** CLEAN — CO-SIGN APPROVED.
- **Issues (Phase 7):** All 11 CLOSE (superseded by 2026 implementation).

**Overall posture:** Critical secrets exposure + supply chain issues must be fixed before pen-test or further deploys. Cleanup + co-sign + schema prep are ready.

All artifacts in `scratch/`. Full isolation maintained.

---

## Phase 1: Secret Scanning Triage (19 alerts)

**Findings (from PS Select-String + git history on 3 repos):**
- trinity-symphony-shared: committed .env with real SUPABASE_SERVICE_ROLE_KEY (JWT), ANTHROPIC sk-ant-..., OPENAI sk-proj-..., CEREBRAS csk-...
- repid-engine: identical committed .env with same real keys + DEEPSEEK.
- trustchat-backend: clean (no .env or matching secrets in current tree).
- Code fallbacks: some anon JWT defaults and 'sk-proxy' (mostly mocks or intended).
- .env.example: placeholders only (clean).
- History: .env touched in past commits; no mass deletions shown in sampled logs.

**Classification:**
- ACTIVE (real, need rotation): 2 (.env files in trinity + repid-engine)
- PUBLIC_BY_DESIGN / mocks: several (anon keys, test 'sk-12345')
- PLACEHOLDER: .env.example + comments
- HISTORICAL: exposure in git history of the .env files

**P0 actions (see scratch/S-SECURE_secret_audit.md for full table):**
- Rotate the exposed keys immediately.
- git rm --cached .env + enforce .gitignore on both affected repos.
- After rotation: history purge (filter-repo/BFG) + force-push (coordinate).
- Dismiss GitHub alerts post-cleanup with links to this audit.
- The service_role exposure directly undermines RLS work.

**Artifact:** scratch/S-SECURE_secret_audit.md

---

## Phase 2: Dependency Vulnerability Audit

**repid-engine:**
- 11 total: 1 critical (protobufjs arbitrary code exec), 4 high (transformers/onnx, tmp, etc.), 5 moderate, 1 low.
- Affects core paths (ethers/ws, rate-limit, transformers for any local/HAL inference).

**trinity-symphony-shared:**
- 5 (1 high qs DoS, 4 moderate).

**trustchat-backend:**
- 5 moderate.

**Recommendations:**
- `npm audit fix` (then --force for majors) in a test branch + full test run.
- Prioritize protobufjs + transformers in engine.
- Enable Dependabot on all three.

**Artifact:** scratch/S-SECURE_dependency_audit.md

---

## Phase 3: Pen-Test Readiness Assessment

**Checklist status (detailed in scratch/S-SECURE_pentest_readiness.md):**

**Strong / Verified:**
- RLS 545/545 + anon blocked on sensitive (S-RLS + CC work)
- Hash-chain (S-AUD1) + tool_call_log RLS
- HTTPS on public endpoints (200 on https for engine + trustchat-backend)
- Auth boundaries (most sensitive behind middleware; public read-only explicitly before auth and documented)
- CORS restricted (not wildcard; specific origins + denylist)
- Input mostly safe (parameterized Supabase queries)

**Needs Work / Gaps:**
- Secrets: committed real keys in .env (P0 blocker)
- Supply chain: critical + high vulns in repid-engine (protobufjs etc.)
- Rate limiting: present (ipKeyGenerator fix in code, Firecrawl limits) but vulns in deps + historical IPv6 crash not 100% confirmed resolved in prod.
- Dockerfile/ARG: not located in root scan (per GMPD: if ARG for private keys/service keys, move to runtime ENV only).
- HTTP->HTTPS redirect: partially verified externally.

**Overall: NEEDS WORK**  
**Blocking before pen-test:** Secrets rotation/purge, critical/high dep fixes in engine, rate-limit confirmation.

**Artifact:** scratch/S-SECURE_pentest_readiness.md (full checklist + blocking list)

---

## Phase 4: Branch Cleanup Inventory

**Counts (post-fetch --prune, read-only):**
- repid-engine: 171 remote branches total. 101 fully merged to main (safe).
- trinity-symphony-shared (ga variant active): 31 total. 17 merged (safe).

**WIP/recovery/temp (safe):** recovery/ga-authority-2026-05-30, recovery/ga-x402-hardening-2026-06-01, wip/hal-scorer-recalibration-2026-05-29, wip/worktree-snapshot-2026-05-29 (and any others from grep).

**Stale:** Many early 2026-04/05 branches (demos, cc1/cc2/gemini sprints) overlap with merged.

**Script produced (NOT executed):** scratch/S-SECURE_branch_cleanup.sh with 5 grouped sections + instructions for Sean (review PRs, one group at a time, prune + recount, target <<20-30 active).

**Net:** Significant reduction possible (101+ merged + wip/stale on engine alone).

**Artifact:** scratch/S-SECURE_branch_cleanup.sh

---

## Phase 5: Harmonia Schema

**Prior artifact reviewed:** scratch/S-HARMONIA-1_schema.sql (good base with IF NOT EXISTS, seeds for 5+ free providers, previous_entry_hash).

**Produced:** scratch/S-SECURE_harmonia_apply.sql (enhanced apply-ready):
- Full CREATE TABLE IF NOT EXISTS for both tables.
- RLS enabled + service_role_full policy on both (anon blocked by default).
- All indexes.
- Idempotent seed for free tiers (groq, cerebras, google, ollama x3, together).
- Comments for hash-chain (app-side or trigger reusing S-AUD1 pattern).
- Pre-flight query comment.
- Notes: isolated research tables, no FKs, transactional budget+insert in app, update SCHEMA_TRUTH_MAP after apply.

**Pre-flight:** The SELECT to confirm tables don't exist yet (design-only; no DB connection performed).

**Status:** Ready for co-sign/Sean apply when free capacity exists.

**Artifact:** scratch/S-SECURE_harmonia_apply.sql

---

## Phase 6: Co-Sign GA's Docs PR

**Branch:** feat/ga-2026-06-01-docs-overhaul (reviewed read-only at current tip).

**Changed:** .env.example, README.md, docs/API.md only.

**Findings:**
- .env.example: only placeholders (comma-separated-api-keys, your-*, etc.). Clean.
- README metrics: "1,277 tests passing, 0 TypeScript errors", "545/545 database tables RLS-secured" — match verified state.
- docs/API.md: accurately lists real public endpoints (/health, /api/v1/status, /api/v1/hal/evaluate, /api/v1/repid/:agentId, /api/v1/audit/verify) that match src/index.ts mounts + route files.
- No source .ts changes in this PR → tsc unaffected (0 errors claim holds).
- Prior context (GA authority merge + F2 spoofing) already in history.

**Decision: CO-SIGN APPROVED.** Clean, accurate, net positive for onboarding/peer review. Ready for Sean merge.

---

## Phase 7: GitHub Issues Triage

**Repo:** trinity-symphony-shared-ga (11 open, mostly 2025-12-17 planning tasks).

**All 11: CLOSE (superseded)**
- Infrastructure Discovery, Sprint Kickoff: historical.
- BRD/SRS/Architecture Templates, ATS Business Requirements, Strategic Roadmap, Blue Ocean, Conductor Onboarding, Document Supabase Schema, Document ATS Architecture: all overtaken by real 2026 work (RLS lockdown + 545 claim, S-AUD1, migrations, SCHEMA_TRUTH_MAP, engine README + GA docs PR architecture sections, live conductors/agents/HAL/RepID).

**No KEEP or UPDATE needed.** Exact md paths in issues (e.g. docs/architecture/SUPABASE_SCHEMA.md with full ER) do not exist, but substance is covered better in living + shipped artifacts.

**Artifact:** scratch/S-SECURE_github_issues_triage.md (with close comment template).

---

## Completion Checklist

- [x] All 7 phases executed sequentially.
- [x] All scratch artifacts produced.
- [x] XC_S-SECURE_REPORT.md (this file).
- [x] No shared-repo modifications.
- [x] Isolation verified at start + throughout.
- [x] Co-sign decision recorded.
- [x] Scripts marked NOT EXECUTED where destructive.

**Next for Sean/Cowork:**
1. Rotate secrets (P0 from Phase 1) + purge .env from history.
2. `npm audit fix` (engine critical first) + test.
3. Run branch cleanup script (after PR review).
4. Merge GA docs PR (co-signed).
5. Close 11 symphony issues.
6. Apply harmonia schema when ready (free quota).
7. Re-audit secrets/deps + pen-test readiness.

**Overall:** Significant hardening progress possible. Secrets + deps are the immediate blockers.

---
**End of XC_S-SECURE_REPORT.md**

All phases complete. Marathon sprint delivered.