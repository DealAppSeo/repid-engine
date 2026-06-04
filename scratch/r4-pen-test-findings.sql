-- R4 External-model Pen Test findings (Grok primary; equiv for DeepSeek/Qwen/ChatGPT probes on staging)
-- test_run_id: r4-2026-06-03-grok
-- Tag artifacts: all with this id.
-- Route to red_team_results (adjudication live).
-- Severity: critical/high/med/low. Repro, fix, rollback.

-- Note: probes conceptual on code/staging equiv (no live keys for real curl, but logic review + known from R2 redteam).
-- After apply RLS-33, retest.

INSERT INTO red_team_results (test_run_id, attack_type, payload, finding, severity, repro, fix, rollback, created_at) VALUES
('r4-2026-06-03-grok', 'f2-authz-spoof', '{"flag": "bypass", "env": "HYPERDAG_F2_AUTHZ=off"}', 'f2-authz invariant assert can be bypassed if env not strictly enforced in deployed path (old if(!isEnvKey) shape lingered in some branches)', 'high', 'curl /f2-endpoint -H "x-f2-flag: spoof" or set process.env in worker; check code_version !=6d92490 assert', 'Assert the security INVARIANT (as in 6d92490 commit) in all f2 paths; use allowlist not env check', 'revert the assert commit if needed, but keep strict check', now()),
('r4-2026-06-03-grok', 'x402-replay', 'reuse x_payment_header or idempotency_key from prior settle', 'Replay possible if no strict nonce/unique in x402-gate before RLS or signature check', 'high', 'Take header from prior /x402 response, resend to /x402/inbound; check if duplicate insert or double spend', 'Enforce unique on x_payment_header + idempotency in x402_settlements (already in code); add replay window check in x402-gate.ts', 'DROP the unique constraint temporarily for debug (not rec)', now()),
('r4-2026-06-03-grok', 'controller-input', 'unsanitized prompt or url to controller.abort or external fetch', 'AbortController timeout or fetch to controller.aitrinitysymphony.com may allow SSRF or long hang if no validation on controller urls', 'med', 'POST /notify with bad controller_url; observe timeout or error leak', 'Validate controller URLs against allowlist in hitl-notification-dispatcher.ts and notify.ts; use AbortSignal properly', 'remove abort for debug', now()),
('r4-2026-06-03-grok', 'rls-exposure', 'anon key select on x402_settlements or agent_services before clean policy', 'Pre RLS-33 apply, anon could read settlements (owner data) if no policy or over-grant', 'high', 'Use anon key from .env, .from("x402_settlements").select(); succeeds if no RLS or public policy', 'Apply the clean RLS-33 (only owner for x402_settlements, public for agent_services; creds deny-all); verify with anon vs service queries', 'DROP POLICY "owner_read_own" ON x402_settlements; etc (per migration rollback)', now()),
('r4-2026-06-03-grok', 'authz-spoof', 'spoof app_agent_id in jwt for RLS or x402', 'If jwt claim not validated strictly, can read others data post RLS', 'med', 'Forge jwt with different app_agent_id, query with anon+claim; see if RLS uses it without verify', 'Validate jwt in middleware or use service for sensitive; RLS policies use verified claims only', 'relax policy for test', now());

-- To log more from other models: repeat with test_run_id r4-deepseek-..., etc.
-- After: SELECT * FROM red_team_results WHERE test_run_id LIKE 'r4-%' ORDER BY severity;
-- Adjudicate in loop (fix high first).
