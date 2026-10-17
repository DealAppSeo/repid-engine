-- AGENTCHESS ARENA — five new tables for src/routes/arena.ts.
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated). FILE ONLY.                                       ║
-- ║  Until this runs, every /api/v1/arena route answers 503 arena_tables_missing and    ║
-- ║  writes nothing (src/arena/store.ts ensureTables). With ARENA_ENABLED off (default) ║
-- ║  the routes are 404 before any read. This migration arms nothing on its own.        ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- TESTNET + SHADOW. No column here is money, escrow, a payout or RepID. A stake is a recorded
-- number in {0, 0.1, 1, 10} testnet USD whose only effect is the chess-rating multiplier.
-- The chess rating (arena_ratings) is chess only and never feeds RepID. Trust signals
-- (arena_trust_signals) are shadow rows: conduct only, never the chess result.
--
-- STAKE TYPE: `numeric` (exact decimal, not float), checked against explicit numeric literals,
-- so 0.1 is exactly 0.1 and nothing like 0.1000000001 can pass.
--
-- "A player may stake only on its own win" is structural: the table has no side or beneficiary
-- column, and the staker (challenger) must be one of the two players (CHECK below). There is
-- no side-bet table.
--
-- UNRATED GAMES. `rated` must equal `owner_distinct`: a pair not shown to have different owners
-- is recorded, playable and replayable, but the engine never folds it into arena_ratings.
--
-- SINGLE-USE SIGNATURES. arena_signatures holds the sha256 of every signed statement a human's
-- wallet has had accepted; the primary key refuses a second use.
--
-- ACCESS. RLS on, no policies, every privilege revoked from anon and authenticated: only the
-- engine's service role reads or writes. Public reads go through the engine's routes.
-- Mirrors supabase/migrations/20261013000000_kernel_receipts.sql.

create table if not exists public.arena_games (
  id                uuid        primary key default gen_random_uuid(),
  status            text        not null check (status in ('pending', 'live', 'finished')),
  -- participant refs: 'agent:<repid_agents.id>' or 'human:<0x wallet, lowercase>'
  white             text        not null check (white ~ '^(agent:[0-9a-f-]{36}|human:0x[0-9a-f]{40})$'),
  black             text        not null check (black ~ '^(agent:[0-9a-f-]{36}|human:0x[0-9a-f]{40})$'),
  challenger        text        not null,
  stake_usd         numeric     not null check (stake_usd in (0::numeric, 0.1::numeric, 1::numeric, 10::numeric)),
  time_control      text        not null check (time_control in ('fast', 'normal', 'slow')),
  default_speed     text        not null check (default_speed in ('machine', '1', '0.5', '0.25')),
  owner_relation    text        not null check (owner_relation in ('distinct', 'same', 'unknown')),
  owner_evidence    text        not null check (owner_evidence in ('strong', 'administrative', 'none')),
  owner_distinct    boolean     not null,
  trust_evidence    boolean     not null,
  rated             boolean     not null,
  fen               text        not null,
  moves             jsonb       not null default '[]'::jsonb,   -- [{uci, san, at, clock_ms:{w,b}}]
  clock_ms          jsonb       not null,                       -- {w, b} remaining as of last_move_at
  illegal_attempts  jsonb       not null default '{"w":0,"b":0}'::jsonb,
  pre               jsonb,                                      -- ratings + spreads locked at accept
  result            text        check (result in ('1-0', '0-1', '1/2-1/2')),
  termination       text,
  version           integer     not null default 0,             -- compare-and-set on every write
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  last_move_at      timestamptz,
  finished_at       timestamptz,
  constraint arena_games_two_players       check (white <> black),
  constraint arena_games_staker_plays      check (challenger in (white, black)),
  constraint arena_games_distinct_is_owner check (owner_distinct = (owner_relation = 'distinct')),
  constraint arena_games_evidence_strong   check (not trust_evidence or (owner_relation = 'distinct' and owner_evidence = 'strong')),
  constraint arena_games_rated_is_distinct check (rated = owner_distinct),
  constraint arena_games_finished_result   check ((status = 'finished') = (result is not null))
);
create index if not exists arena_games_status_created_idx on public.arena_games (status, created_at desc);
create index if not exists arena_games_white_idx on public.arena_games (white);
create index if not exists arena_games_black_idx on public.arena_games (black);
create index if not exists arena_games_rated_finished_idx on public.arena_games (finished_at, id) where status = 'finished' and rated;

create table if not exists public.arena_ratings (
  participant  text        primary key,
  rating       numeric     not null,
  games        integer     not null check (games >= 0),
  updated_at   timestamptz not null default now()
);

create table if not exists public.arena_trust_signals (
  id              bigint      generated always as identity primary key,
  game_id         uuid        not null references public.arena_games (id),
  participant     text        not null,
  owner_distinct  boolean     not null,
  trust_evidence  boolean     not null,
  shadow          boolean     not null default true check (shadow),
  signals         jsonb       not null,
  created_at      timestamptz not null default now(),
  unique (game_id, participant)
);

create table if not exists public.arena_predictions (
  id              bigint      generated always as identity primary key,
  game_id         uuid        not null references public.arena_games (id),
  predictor       text        not null,
  is_participant  boolean     not null,
  side            text        not null check (side in ('white', 'black')),
  probability     numeric     not null check (probability >= 0 and probability <= 1),
  at_ply          integer     not null check (at_ply >= 0),
  created_at      timestamptz not null default now(),
  unique (game_id, predictor)
);

create table if not exists public.arena_signatures (
  statement_sha256  text        primary key check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  wallet            text        not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  action            text        not null check (action in ('challenge', 'accept', 'move', 'predict')),
  created_at        timestamptz not null default now()
);

alter table public.arena_games          enable row level security;
alter table public.arena_ratings        enable row level security;
alter table public.arena_trust_signals  enable row level security;
alter table public.arena_predictions    enable row level security;
alter table public.arena_signatures     enable row level security;

revoke all on public.arena_games, public.arena_ratings, public.arena_trust_signals, public.arena_predictions, public.arena_signatures from anon, authenticated;

-- ── ROLLBACK (DOWN) — run this to undo, if the tables are ever applied ──────────────────
-- drop table if exists public.arena_signatures;
-- drop table if exists public.arena_predictions;
-- drop table if exists public.arena_trust_signals;
-- drop table if exists public.arena_ratings;
-- drop table if exists public.arena_games;
