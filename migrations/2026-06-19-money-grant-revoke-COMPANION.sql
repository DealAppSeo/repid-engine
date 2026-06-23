-- COMPANION to XC-S2's 2026-06-19-rls-wave-v1-remaining-critical.sql — authored by CC (CTO) 2026-06-19.
-- WHY: CC co-sign of XC's RLS wave found it SAFE but INCOMPLETE. The wave enables RLS + adds
-- service_role-only policies (so anon is deny-all under RLS) — but it does NOT revoke the underlying
-- table GRANTS. Verified live 2026-06-19 [V]: on public.x402_settlements (a MONEY table, 242 rows),
-- BOTH anon AND authenticated hold INSERT, UPDATE, DELETE, TRUNCATE grants. Today RLS-deny-all masks
-- them, but those grants are a loaded gun: one permissive policy or an RLS-disable turns them into a
-- live money-table write hole. Defense-in-depth (the D-060 lockdown pattern) = REVOKE the grants too,
-- so the table isn't one mistake away from exposure. RLS is the gate; revoking grants removes the gun.
--
-- SAFE: REVOKE of an absent grant is a harmless no-op (idempotent). Public SELECT is PRESERVED
-- (we revoke only the write privileges). Reversible (re-GRANT if a surface ever legitimately needs it).
-- Apply AFTER the RLS wave, in the same Sean session, with raw before/after.
--
-- BEFORE (verified 2026-06-19 [V], x402_settlements): anon + authenticated =
--   DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  (RLS on, 0 policies)

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.x402_settlements,
  public.x402_payment_gates,
  public.service_contracts,
  public.staking_deposits,
  public.staking_withdrawals,
  public.repid_score_events,
  public.trinity_task_audit_log,
  public.tool_call_log
FROM anon, authenticated;

COMMIT;

-- AFTER-APPLY PROOF (Sean paste raw — expect ZERO write privileges for anon/authenticated):
-- SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema='public'
--    AND table_name IN ('x402_settlements','x402_payment_gates','service_contracts',
--        'staking_deposits','staking_withdrawals','repid_score_events',
--        'trinity_task_audit_log','tool_call_log')
--    AND grantee IN ('anon','authenticated')
--    AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
--  ORDER BY table_name, grantee;   -- expect 0 rows
-- (SELECT for anon/authenticated is intentionally preserved where it was already granted.)
