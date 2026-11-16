-- DRAFT: Sean applies (prod DDL is Sean-only). A new, empty table: no data change, no lock on any
-- existing table (deliberately no foreign key to repid_score_events, so creating it never waits on
-- the hot score-event table). Rollback: 20261116180000_hal_score_gate_shadow.rollback.sql
--
-- What it holds. With HAL_SCORE_GATE_MODE=shadow (default off; src/scoring/hal-score-gate.ts), one
-- row per HAL_SCORE_EVENT: the live HAL verdict and the HAL delta it applied, beside the verdict the
-- cross-provider quorum gives the same answer and the HAL delta THAT would apply. Each verdict has a
-- receipt id (halv1_ + sha256 of the verdict record, src/hal/verdict-receipt-id.ts). Nothing reads
-- this table to score: it is a measurement, and the mode check below makes "enforce" unwritable.
--
-- Until this is applied, shadow mode logs once that the table is missing and changes nothing else.
--
-- Service role only: RLS on with no policies, and no grants to anon/authenticated.
create table if not exists public.hal_score_gate_shadow (
  id                  bigserial primary key,
  score_event_id      bigint not null unique,            -- repid_score_events.id (no FK, see header)
  agent_id            uuid not null,
  mode                text not null default 'shadow' check (mode = 'shadow'),
  live_strictness     smallint not null,                 -- 1 = style extractor, 2 = fact-check quorum
  live_hal_mode       text,                              -- extractor | fact-check | extractor-fallback
  live_decision       text not null,                     -- the hal_decision written on the score event
  live_hal_score      numeric not null,
  live_hal_delta      integer not null,                  -- HAL delta applied, before decay and the clamp
  live_receipt_id     text not null check (live_receipt_id ~ '^halv1_[0-9a-f]{64}$'),
  quorum_source       text not null check (quorum_source in ('live', 'cache', 'fresh', 'not_checked')),
  quorum_hal_mode     text,
  quorum_raw_decision text,                              -- the quorum's verdict before the quorum gates
  quorum_decision     text,                              -- after them: what the score event would record
  quorum_hal_score    numeric,
  quorum_met          boolean not null default false,
  quorum_families     text[] not null default '{}',
  quorum_hal_delta    integer,                           -- HAL delta the quorum verdict would apply
  quorum_receipt_id   text check (quorum_receipt_id is null or quorum_receipt_id ~ '^halv1_[0-9a-f]{64}$'),
  quorum_latency_ms   integer,
  not_checked_reason  text,
  created_at          timestamptz not null default now(),
  -- No answer is not an answer: a quorum that did not check carries no verdict and no delta.
  constraint hal_score_gate_shadow_not_checked_is_empty
    check (quorum_source <> 'not_checked' or (quorum_decision is null and quorum_hal_delta is null))
);

comment on table public.hal_score_gate_shadow is
  'HAL_SCORE_GATE_MODE=shadow: live HAL verdict vs cross-provider quorum verdict per score event, with the HAL delta each would apply. Measurement only; nothing scores from it. See src/scoring/hal-score-gate.ts.';

alter table public.hal_score_gate_shadow enable row level security;
revoke all on public.hal_score_gate_shadow from anon, authenticated;
revoke all on sequence public.hal_score_gate_shadow_id_seq from anon, authenticated;
