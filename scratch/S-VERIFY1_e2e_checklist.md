# S-VERIFY1 End-to-End Flow Verification Checklist

**Date:** 2026-06-01  
**Purpose:** Sean (or delegate) walks this checklist AFTER all S-MERGE1 waves land, redeploys complete, and all SQL batches (S-RLS-LOCKDOWN, S-AUD1, etc.) have been applied.

Run this in the order listed. Mark each item with timestamp and result.

## Pre-Checks (before walking the list)
- [ ] Confirm deployed SHAs:
  - repid-engine: `git -C /path/to/deployed-repo rev-parse HEAD` matches `main` HEAD at merge time.
  - trinity-symphony-shared: same for its main.
- [ ] Confirm no deprecated model strings are live (grep deployed code for known deprecated models from S-BRANCH1 inventory).
- [ ] Confirm the smoke script (S-VERIFY1_post_merge_smoke.sh) is present and executable in the deployment (see platform notes in the script header for macOS/Windows runners).

## Core Checklist

[ ] **repid-engine /health → 200**  
    `curl -sf $ENGINE_URL/health` returns 200. Timestamp: ________ Result: PASS/FAIL

[ ] **repid-engine /api/v1/status → 200**  
    `curl -sf $ENGINE_URL/api/v1/status` returns 200 with healthy payload. Timestamp: ________ Result: PASS/FAIL

[ ] **HAL scoring returns 5 signals on test prompt**  
    POST a simple factual prompt to the HAL evaluate/signals endpoint.  
    Response must contain the full 5-signal block (or equivalent per current HAL lib).  
    Timestamp: ________ Result: PASS/FAIL  
    Example prompt: "The capital of France is Paris."

[ ] **hal_production_events has previous_entry_hash column**  
    Run: `SELECT column_name FROM information_schema.columns WHERE table_name='hal_production_events' AND column_name='previous_entry_hash';`  
    Must return a row. Timestamp: ________ Result: PASS/FAIL

[ ] **verify-chain.ts → VALID** (against hal_production_events or hal_audit_chain)  
    Run the verify-chain script (or equivalent) on the audit table.  
    Must return overall status VALID with no broken links.  
    Timestamp: ________ Result: PASS/FAIL

[ ] **tool_call_log table exists**  
    `SELECT 1 FROM information_schema.tables WHERE table_name='tool_call_log';` returns a row.  
    Timestamp: ________ Result: PASS/FAIL

[ ] **RLS enabled on 241+ tables**  
    Run the RLS count query (see S-VERIFY1_REPORT or S-RLS-LOCKDOWN verification section):  
    `SELECT relrowsecurity, COUNT(*) FROM pg_class ... GROUP BY relrowsecurity;`  
    Expect high number with `true` (enabled). Timestamp: ________ Result: PASS/FAIL

[ ] **anon key blocked on sensitive tables**  
    Using a client initialized with only the anon key (never service_role):  
    - `SELECT * FROM hal_production_events LIMIT 1;` → permission denied or empty  
    - Same for: repid_score_events, trinity_tasks, paper_trades, governance_votes, memory_warm, etc.  
    Timestamp: ________ Result: PASS/FAIL (all must be blocked)

[ ] **service_role still works**  
    Using service_role key:  
    - `SELECT COUNT(*) FROM hal_production_events;` succeeds  
    - `SELECT COUNT(*) FROM trinity_tasks;` succeeds  
    - Same for other sensitive tables.  
    Timestamp: ________ Result: PASS/FAIL

[ ] **Swarm claiming (inject-and-watch → 3/3 claimed)**  
    Run inject-and-watch (or equivalent probe) with 3 probes over ~60s.  
    Expect at least 3 successful claims in the window.  
    Timestamp: ________ Result: PASS/FAIL

[ ] **trinity-symphony-shared deployed SHA matches main HEAD**  
    Same SHA verification as repid-engine. Timestamp: ________ Result: PASS/FAIL

[ ] **Agent health: 6+ workers active in last 5 min**  
    Query trinity_agent_registry or agent_heartbeat for distinct agents with recent last_ping / last_active.  
    Expect ≥6 distinct active agents in the last 5 minutes.  
    Timestamp: ________ Result: PASS/FAIL

[ ] **No deprecated model strings in deployed code**  
    Grep the deployed images/containers for any model IDs or strings that were flagged as deprecated in S-BRANCH1 inventory.  
    Expect zero matches. Timestamp: ________ Result: PASS/FAIL

## Post-Checklist

- Overall status: GREEN (all 13 items PASS) / YELLOW (minor non-blocking issues) / RED (any critical failure)
- Notes / blockers found:
- Next action (e.g., "escalate to Sean / CC for rollback" or "sign-off for next wave"):

**Run this checklist after every major wave or SQL batch apply.** Keep timestamps for audit trail.

---

**End of S-VERIFY1_e2e_checklist.md**  
Use in conjunction with the smoke script and the SQL verification queries.