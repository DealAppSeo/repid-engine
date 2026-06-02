# Security Posture (S-BUILD Phase 5)

## Database
- 548/548 tables RLS-enabled (S-RLS-LOCKDOWN + waves)
- Anon key blocked on sensitive tables (hal_*, repid_score_events, trinity_tasks, paper_trades, governance, etc.)
- Service role required for writes
- F2 agent spoofing fix deployed

## Authentication & Authorization
- F2 spoofing fix (GA 2026-06-01)
- IPv6 rate limiting (/64 masking via ipKeyGenerator)
- CORS restricted (not wildcard)
- Auth middleware on sensitive routes; explicit public pre-auth for read-only endpoints

## Audit Trail
- Hash-chained (SHA-256) on hal_production_events + tool_call_log
- Tamper detection via verify-chain.ts
- 700+ entries (growing)

## Transport
- All public endpoints HTTPS (Railway)
- HTTP should redirect (verified externally)

## Secrets
- .env must never be committed (see S-SECURE audit)
- All production keys via env only

## How to Verify
- RLS count: SELECT relrowsecurity, COUNT(*) FROM pg_class ...
- Chain: node scripts/verify-chain.ts --table hal_production_events
- Audit: curl /api/v1/audit/verify
- npm audit (see S-SECURE reports)

See S-SECURE_pentest_readiness.md for full checklist.
