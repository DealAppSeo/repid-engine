-- 2026-09-06-verified-tool-receipts-view.sql
-- APPLIED 2026-09-06 (logged here for version control + reproducibility).
--
-- v_trustshell_tool_receipts_verified: classify each receipt as verified vs
-- quarantined by RECOMPUTING its HMAC against the signing key (sig_version 2:
-- hmac(agent_id|tool_name|input_hash|output_hash|minted_by, key)). Forged/legacy
-- rows (direct-insert minted_by=null, sig_version 1, or a signature mismatch) show
-- verified=false with a reason — quarantined, NEVER deleted (canon: pause, don't erase).
--
-- Live at creation: 1 verified (trustshell.mvp.selftest) / 14 quarantined
-- (legacy_sig_v1 — XC's forge red-team rows + legacy). Every RPC-minted (v2)
-- receipt verifies true going forward.
--
-- Runs in the view-owner context so the secret key is read internally but NEVER
-- selected. Granted to service_role only: the key-touching verdict stays server-
-- side; public surfaces read it through the engine (GET /api/v1/tool-receipt/verified),
-- not anon-direct.

CREATE OR REPLACE VIEW public.v_trustshell_tool_receipts_verified AS
SELECT
  r.id, r.vertical, r.agent_id, r.tool_name, r.tool_version,
  r.input_hash, r.output_hash, r.execution_time_ms,
  r.minted_by, r.sig_version, r.hmac_signature, r.created_at,
  (r.sig_version = 2
    AND r.minted_by IS NOT NULL
    AND e.expected IS NOT NULL
    AND r.hmac_signature = e.expected) AS verified,
  CASE
    WHEN r.sig_version IS DISTINCT FROM 2 THEN 'legacy_sig_v' || COALESCE(r.sig_version::text, 'null')
    WHEN r.minted_by IS NULL         THEN 'no_minter_direct_insert'
    WHEN e.expected IS NULL          THEN 'signing_key_unavailable'
    WHEN r.hmac_signature <> e.expected THEN 'signature_mismatch'
    ELSE NULL
  END AS quarantine_reason
FROM public.trustshell_tool_receipts r
LEFT JOIN public.receipt_signing_key k ON k.id = 1
LEFT JOIN LATERAL (
  SELECT encode(
    extensions.hmac(
      r.agent_id || '|' || r.tool_name || '|' || r.input_hash || '|' || r.output_hash || '|' || r.minted_by,
      k.key_material, 'sha256'), 'hex') AS expected
) e ON true;

REVOKE ALL ON public.v_trustshell_tool_receipts_verified FROM anon, authenticated;
GRANT SELECT ON public.v_trustshell_tool_receipts_verified TO service_role;

-- rollback: DROP VIEW IF EXISTS public.v_trustshell_tool_receipts_verified;
