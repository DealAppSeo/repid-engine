-- Anon cannot INSERT into the HAL quorum tables.
-- service_role is unchanged. This file is not applied by CI.

REVOKE INSERT ON TABLE public.hal_quorum_receipts FROM anon;
REVOKE INSERT ON TABLE public.hal_quorum_validator_votes FROM anon;
