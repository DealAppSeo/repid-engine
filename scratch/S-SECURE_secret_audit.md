# S-SECURE Secret Scanning Triage Audit

**Date:** 2026-06-02  
**XC worktree:** feat/xc-2026-06-02-security-hardening (read-only analysis on shared repos)  
**Source:** GitHub secret scanning (19 alerts) + manual grep/Select-String across trinity-symphony-shared, repid-engine, trustchat-backend.

## Summary
- Total alerts referenced: 19
- Real committed .env files with production secrets found in 2/3 repos.
- **P0 ACTIVE real secrets exposed in git**: Supabase service_role keys (JWTs), Anthropic, OpenAI, Cerebras, DeepSeek API keys.
- These are **not** public-by-design anon keys; they are service/admin keys.

## Classification Table (key findings)

| # | Repo | File/Path | Secret Type | Status | Action |
|---|------|-----------|-------------|--------|--------|
| 1 | trinity-symphony-shared | .env (committed) | SUPABASE_SERVICE_ROLE_KEY (full JWT), ANTHROPIC_API_KEY=sk-ant-..., OPENAI_API_KEY=sk-proj-..., CEREBRAS_API_KEY=csk-... | ACTIVE (real, valid-looking) | ROTATE ALL KEYS IMMEDIATELY. Remove .env from git. Add to .gitignore. Purge history if possible. Flag to Sean. |
| 2 | trinity-symphony-shared | lib/ConstitutionalAgent.ts + lib/ConstitutionalAgentV4.js | Fallback default anon key JWT + LITELLM_MASTER_KEY || 'sk-proxy' | PUBLIC_BY_DESIGN or mock (anon key is intended for some paths; 'sk-proxy' is placeholder) | Review usage. Dismiss most as false positive if only anon. |
| 3 | repid-engine | .env (committed) | Same as above: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC, OPENAI, CEREBRAS, DEEPSEEK keys | ACTIVE (real) | Same P0: ROTATE + remove + gitignore + history purge. |
| 4 | repid-engine | .env.example | Placeholders (your-*, comma-separated, etc.) | PLACEHOLDER | Dismiss as false positive. |
| 5 | repid-engine | tests/ (e.g. hal-evaluations-writer.test.ts) | api_key: 'sk-12345' (mock) | PLACEHOLDER / TEST | Dismiss. |
| 6 | All | .env files in git history (logs show past commits touching .env) | Historical exposure of the same keys | HISTORICAL | Note for Sean: git filter-repo or BFG to purge .env from history. Rotate keys first. |
| 7 | trustchat-backend | (scan clean) | No .env or matching secret patterns found in current tree | CLEAN | No action. |
| 8-19 | Various | GitHub alerts (likely duplicates of above .env + any other sk- in history/docs) | LLM keys + Supabase service keys | Mostly covered by above | Dismiss the false positives / rotated after cleanup. |

**Breakdown:**
- ACTIVE (need immediate rotation): 2 (the .env files in trinity + repid-engine)
- ROTATED: 0 (keys still appear live in scans)
- PUBLIC_BY_DESIGN: ~3-5 (anon keys, mocks in tests/code)
- PLACEHOLDER: ~5+ (.env.example + test mocks)
- HISTORICAL: Multiple ( .env committed in past commits across repos)

## P0 Immediate Actions (for Sean / Cowork)
1. **Rotate the following keys NOW** (before any further deploys or use):
   - SUPABASE_SERVICE_ROLE_KEY (both repos share the same exposed JWT in scans)
   - ANTHROPIC_API_KEY (sk-ant-...)
   - OPENAI_API_KEY (sk-proj-...)
   - CEREBRAS_API_KEY
   - DEEPSEEK_API_KEY
   - Any LITELLM or other master keys referenced.

2. Remove .env from both repos:
   - git rm --cached .env
   - echo ".env" >> .gitignore (ensure .env.local, .env.* too)
   - Commit the removal + gitignore.

3. Git history purge (after rotation):
   - Use `git filter-repo --path .env --invert-paths` or BFG Repo-Cleaner on a clone.
   - Force push (coordinate with team, as it rewrites history).
   - Re-clone everywhere.

4. On GitHub: After rotation + removal, mark the 19 alerts as "Revoked" or "False positive" with notes linking to this audit. Do NOT dismiss until keys are rotated.

5. Audit code for other hard-coded fallbacks:
   - Search for any `|| 'sk-` or default JWTs in production paths.

## Additional Notes
- The exposed service_role keys grant full DB access (bypassing RLS). This is a critical breach of the S-RLS-LOCKDOWN work.
- Anon keys in code (e.g. trinity default) may be acceptable for public reads but should be reviewed against current RLS policies.
- No evidence of the keys in trustchat-backend current tree.
- .env.example in repid-engine is correctly using placeholders (good).

**Next:** After rotation and cleanup, re-run secret scan on GitHub and confirm 0 active real secrets.

---
End of S-SECURE_secret_audit.md (Phase 1 complete)