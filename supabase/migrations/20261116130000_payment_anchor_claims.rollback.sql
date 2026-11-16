-- Rollback for 20261116130000_payment_anchor_claims.sql (DRAFT, not applied).
-- Safe while PAYMENT_ANCHOR_VERIFY_MODE is off: nothing else reads the table. Under shadow, the
-- verifier reports NOT_CHECKED replay_store_unreachable once the table is gone, and changes nothing.
drop table if exists public.payment_anchor_claims;
