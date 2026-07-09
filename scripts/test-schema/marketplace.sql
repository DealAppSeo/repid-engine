-- =============================================================================
-- marketplace.sql  —  TrustMarket-light P0 schema (listings + offers)
-- =============================================================================
-- Purpose: the marketplace_listings (+ marketplace_offers) tables backing the
-- TrustMarket-light P0 endpoints (POST /api/v1/marketplace/list,
-- GET /api/v1/marketplace/browse). Per TRUSTMARKET_LIGHT_SPEC_v0.
--
-- Agents AND humans post haves/wants (buy or rent); browse is public and each
-- card carries the poster's RepID + tier badge — trust shown, not claimed.
--
-- SAFETY: apply ONLY to the disposable TEST project (ref ebiftjvrbsotpdthsyav).
-- NEVER apply to prod (qnnpjhlxljtqyigedwkb) — prod DDL is Sean-gated.
-- Additive + idempotent (CREATE TABLE IF NOT EXISTS). Safe to re-run.
--
-- RLS is ENABLED from creation (additive/RLS-on requirement). Browse reads
-- OPEN listings only. On prod, /list + /browse run under the service-role key
-- (RLS-bypassing), so no public-write policy is granted there. On the TEST
-- project — which only exposes the anon/publishable key — a permissive
-- test_all_access policy is granted at the bottom so the write-path round-trip
-- test can insert/select. That grant is acceptable ONLY on a throwaway test DB.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- marketplace_listings — a have/want card posted by an agent or a human.
-- ---------------------------------------------------------------------------
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
  -- poster_verified: TRUE only when the caller provably controls poster_id
  -- (human JWT, DB-issued agent key, or an env key explicitly bound to this
  -- poster_id). FALSE for an env-key poster declaring an unbound identity — its
  -- card shows NO RepID/tier badge, so a trusted agent's badge can never be
  -- impersonated. Default TRUE keeps the clean human/DB-key paths unchanged.
  poster_verified boolean not null default true,
  repid_at_post integer,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);
alter table public.marketplace_listings enable row level security;

-- Idempotent backfill for an already-created table (CREATE TABLE IF NOT EXISTS
-- above won't add columns to a pre-existing table). Existing rows default TRUE.
alter table public.marketplace_listings
  add column if not exists poster_verified boolean not null default true;

-- Browse hits open listings newest-first; index the hot filter/sort path.
create index if not exists marketplace_listings_open_recent_idx
  on public.marketplace_listings (status, created_at desc);
create index if not exists marketplace_listings_kind_idx
  on public.marketplace_listings (kind);
create index if not exists marketplace_listings_category_idx
  on public.marketplace_listings (category);

-- ---------------------------------------------------------------------------
-- marketplace_offers — an offer against a listing. Created now for schema
-- completeness; P0 exposes NO offer endpoints (offer/accept are P1).
-- ---------------------------------------------------------------------------
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

-- ===========================================================================
-- RLS POLICIES + GRANTS — disposable TEST project ONLY.
-- ---------------------------------------------------------------------------
-- The TEST project only exposes the anon/publishable key (no service_role JWT
-- in env). Mirror seed-test-supabase.sql: RLS stays ENABLED, but anon +
-- authenticated get full access so the write-path round-trip test can run.
-- Acceptable ONLY on a throwaway test DB. Do NOT replicate on prod — on prod
-- these endpoints run under the RLS-bypassing service-role key and NO public
-- write policy is granted.
-- ===========================================================================
do $$
declare t text;
  tbls text[] := array['marketplace_listings','marketplace_offers'];
begin
  foreach t in array tbls loop
    execute format('drop policy if exists test_all_access on public.%I', t);
    execute format('create policy test_all_access on public.%I for all to anon, authenticated using (true) with check (true)', t);
    execute format('grant all on public.%I to anon, authenticated', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
