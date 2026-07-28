-- =============================================================================
-- 2026-07-27_marketplace_p0.sql — APPLIED TO PRODUCTION. This is a RECORD.
-- =============================================================================
-- Project: qnnpjhlxljtqyigedwkb (Trinity prod). Applied by Claude (single-writer
-- lane, CLAUDE_RULES r7: net-new additive objects, prod DDL logged) on
-- 2026-07-27, autonomous build-loop Beat 47. Two Supabase migrations:
--   1. create_marketplace_listings_and_offers_p0
--   2. harden_marketplace_tables_revoke_anon_grants
--
-- WHY: `GET /api/v1/marketplace/browse` is PUBLIC and keyless and had been
-- returning HTTP 500 `{"error":"browse_query_failed"}` on live prod since the
-- TrustMarket-light P0 endpoints shipped in #153. Root cause was not code:
-- `marketplace_listings` existed in NO schema in prod [V information_schema,
-- enumerated across all schemas], because the only DDL in the repo
-- (scripts/test-schema/marketplace.sql) is explicitly scoped to the disposable
-- TEST project. The endpoint shipped; its table never did.
--
-- WHAT DIFFERS FROM scripts/test-schema/marketplace.sql: that file ends with a
-- permissive `test_all_access` policy + `grant all ... to anon, authenticated`,
-- correct for a throwaway test DB and a public-write hole on prod. That block is
-- OMITTED here, exactly as that file's own header instructs. On prod both
-- endpoints run under the service-role key, which bypasses RLS.
--
-- POST-APPLY POSTURE [V pg_class/pg_policies/has_table_privilege]:
--   marketplace_listings — rls=true, policies=0, anon SELECT/INSERT=false,
--     authenticated SELECT=false, service_role SELECT/INSERT=true
--   marketplace_offers   — identical
-- VERIFIED LIVE: browse -> HTTP 200 {"listings":[],"count":0}; with
--   ?kind=have&limit=5 -> HTTP 200; anon PostgREST read of the table ->
--   HTTP 401 `42501 permission denied for table marketplace_listings`.
--
-- NOTE ON THE SECOND MIGRATION: the revoke is not redundant. This project has
-- default privileges that auto-grant table-level access on new public tables to
-- anon + authenticated — verified directly: immediately after creation, and
-- with no grant of mine, `has_table_privilege('anon', ..., 'INSERT')` was TRUE.
-- RLS-with-zero-policies already denied those roles, but that is a single layer:
-- anyone later adding one permissive policy would silently open a public write
-- path on a table that looks locked. Revoking the grants is the same remediation
-- precedent already applied to `x402_settlements`. Defence in depth, because the
-- failure mode here is quiet.
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.marketplace_listings (
  id            uuid primary key default gen_random_uuid(),
  poster_type   text not null check (poster_type in ('agent','human')),
  poster_id     text not null,
  kind          text not null check (kind in ('have','want')),
  category      text,
  title         text not null,
  description   text,
  price_usdc    numeric,
  mode          text not null check (mode in ('buy','rent')),
  rent_period   text,
  status        text not null default 'open' check (status in ('open','matched','closed')),
  repid_at_post integer,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);
alter table public.marketplace_listings enable row level security;

create index if not exists marketplace_listings_open_recent_idx
  on public.marketplace_listings (status, created_at desc);
create index if not exists marketplace_listings_kind_idx
  on public.marketplace_listings (kind);
create index if not exists marketplace_listings_category_idx
  on public.marketplace_listings (category);

create table if not exists public.marketplace_offers (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null references public.marketplace_listings(id) on delete cascade,
  offerer_id   text not null,
  offerer_type text not null check (offerer_type in ('agent','human')),
  amount_usdc  numeric,
  message      text,
  status       text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at   timestamptz not null default now()
);
alter table public.marketplace_offers enable row level security;

create index if not exists marketplace_offers_listing_idx
  on public.marketplace_offers (listing_id);

-- Migration 2 — see NOTE above.
revoke all on public.marketplace_listings from anon, authenticated;
revoke all on public.marketplace_offers  from anon, authenticated;
