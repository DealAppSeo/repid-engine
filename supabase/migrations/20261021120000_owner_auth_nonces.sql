-- OWNER AUTHORIZATION NONCES — the durable record of used owner approvals (P0-TK-03, XC1 #1444).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated). FILE ONLY.                                       ║
-- ║  Apply it BEFORE the code that reads it is deployed: from that deploy on,           ║
-- ║  src/services/owner-authorization.ts claims every verified owner approval here,     ║
-- ║  and with this table ABSENT every owner approval is refused as `not_checked`         ║
-- ║  (fail closed): keys.create, grant.mint and the stake actions stop working.         ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHAT. An owner approval (EIP-712 OwnerAuthorization) carries a random 32-byte nonce and lives at
-- most 10 minutes. Until now the used nonces were held in process memory only, so a restart let a
-- used approval verify again inside its lifetime (XC1 P0-TK-03). The engine now records each
-- verified (signer, nonce) here AFTER the signature checks out, and refuses one that is already
-- present ('replayed'). A forged approval never reaches the insert, so it cannot burn a real nonce.
--
--   signer      the expected owner wallet, lower-case (resolved server-side, never from the body).
--   nonce       the approval's nonce, lower-case 0x + 64 hex.
--   expires_at  when the approval itself expires. A row past it can be deleted at any time: an
--               expired approval is refused before this table is read.
--   used_at     when the engine accepted it.
--
-- The PRIMARY KEY is the replay guard across replicas: a concurrent second insert fails with 23505,
-- which the engine reads as 'replayed'.
--
-- ACCESS. RLS on; every privilege revoked from anon and authenticated — only the engine's secret key
-- (service_role) reads or writes. Mirrors 20261013000000_kernel_receipts.sql. No row holds anything
-- about an end user beyond the owner wallet address the approval was signed by.

create table if not exists public.owner_auth_nonces (
  signer     text        not null,
  nonce      text        not null,
  expires_at timestamptz not null,
  used_at    timestamptz not null default now(),
  primary key (signer, nonce)
);

alter table public.owner_auth_nonces enable row level security;

revoke all on public.owner_auth_nonces from anon, authenticated;

-- ── ROLLBACK (DOWN) — run this to undo, if the table is ever applied ───────────────────
-- Revert the code first (the engine refuses every owner approval without this table).
-- drop table if exists public.owner_auth_nonces;
