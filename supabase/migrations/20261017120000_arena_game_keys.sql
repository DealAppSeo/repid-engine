-- AGENTCHESS ARENA — GAME KEYS (one wallet signature per game, not per move).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated). FILE ONLY.                                       ║
-- ║  Until this runs, every /api/v1/arena route answers 503 arena_tables_missing and    ║
-- ║  writes nothing (src/arena/store.ts ensureTables probes arena_game_keys and         ║
-- ║  arena_games.events). ARENA_ENABLED stays off; nothing is armed by this file.       ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- Builds on 20261016120000_arena.sql (applied 2026-10-16; 0 games at the time of writing).
--
-- arena_game_keys: a wallet's grant to a browser-held P-256 key for ONE game. The grant statement
-- and its wallet signature are stored and published with the game, so anyone can check every
-- game-key signature without trusting the engine. A new grant for the same game and side revokes
-- the old key ('replaced'); the wallet can end it ('ended_by_wallet'); the game's end ends it too.
-- Old rows stay, so signatures made by a replaced key stay verifiable. There is no timed expiry.
--
-- arena_games.events: resign and draw offers/acceptances, each with its game-key signature.
--
-- arena_signatures.action: widened for the three new wallet statements: grant, revoke, scoresheet.
--
-- ACCESS. RLS on, no policies, every privilege revoked from anon and authenticated, like the
-- other arena tables.

create table if not exists public.arena_game_keys (
  game_id          uuid        not null references public.arena_games (id),
  participant      text        not null check (participant ~ '^human:0x[0-9a-f]{40}$'),
  thumbprint       text        not null check (thumbprint ~ '^[A-Za-z0-9_-]{43}$'),   -- RFC 7638, sha256, base64url
  public_jwk       jsonb       not null,                                               -- {kty: EC, crv: P-256, x, y}
  capabilities     text[]      not null check (capabilities <@ array['move', 'offer_draw', 'accept_draw', 'resign']::text[]),
  grant_statement  text        not null,
  grant_signature  text        not null,
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_reason   text        check (revoked_reason in ('replaced', 'ended_by_wallet')),
  primary key (game_id, participant, thumbprint),
  constraint arena_game_keys_revoked_has_reason check ((revoked_at is null) = (revoked_reason is null))
);
-- One ACTIVE key per game and side.
create unique index if not exists arena_game_keys_one_active on public.arena_game_keys (game_id, participant) where revoked_at is null;

alter table public.arena_games add column if not exists events jsonb not null default '[]'::jsonb;

alter table public.arena_signatures drop constraint if exists arena_signatures_action_check;
alter table public.arena_signatures add constraint arena_signatures_action_check
  check (action in ('challenge', 'accept', 'move', 'predict', 'grant', 'revoke', 'scoresheet'));

alter table public.arena_game_keys enable row level security;
revoke all on public.arena_game_keys from anon, authenticated;

-- ── ROLLBACK (DOWN) ─────────────────────────────────────────────────────────────────────
-- alter table public.arena_signatures drop constraint if exists arena_signatures_action_check;
-- alter table public.arena_signatures add constraint arena_signatures_action_check check (action in ('challenge', 'accept', 'move', 'predict'));
-- alter table public.arena_games drop column if exists events;
-- drop table if exists public.arena_game_keys;
