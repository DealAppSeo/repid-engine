-- IMMUNE RECEIPTS — append-only evidence + a lifecycle event log, with a derived state projection (M2).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (owner-gated). FILE ONLY — do not run.                             ║
-- ║  Creates two append-only tables + one view. Nothing live changes until the owner        ║
-- ║  applies this AND sets IMMUNE_PERSIST_ENABLED (default OFF). With the flag OFF the        ║
-- ║  write path is a dry-run that returns the row + events and touches no table.             ║
-- ║  SAFE BY DEFAULT: RLS + append-only + anon/authenticated lockout are enforced as DDL      ║
-- ║  below (deny-by-default; service_role is the single writer). Only the future              ║
-- ║  least-privilege worker/engine ROLE SPLIT is left as owner intent.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY (D-130, Chat's addition). A receipt being STORED, cryptographically VALID, origin-AUTHENTICATED,
-- outcome-VERIFIED, SETTLED, and ANCHORED are DIFFERENT states. A flat "receipts" table where a row's
-- existence implies the strongest state is exactly the evidence-laundering risk the P0 gate exists to
-- stop. So the evidence is immutable (`immune_receipts`), every lifecycle transition is a separate
-- append-only EVENT (`immune_receipt_events`), and current state is DERIVED by folding events
-- (`immune_receipt_state`) — never inferred from the row. A stored receipt is only `recorded`;
-- `authoritative` requires an `origin_authenticated` event the protected engine alone may append (P0),
-- and the receipt's own `authoritative` FIELD is recorded as evidence but is NOT trusted for state.
--
-- CONTENT ADDRESSING. `content_hash` = keccak256 of the receipt body (src/immune/combined-receipt.ts
-- combinedReceiptContentHash). It is the natural primary key: identical evidence collapses to one row
-- (append-only dedup), and any tampered field changes the hash — a separate verifier recomputes it.

-- ── 1. immune_receipts — the immutable evidence record (one row per unique receipt) ─────────────────
create table if not exists public.immune_receipts (
  content_hash        text primary key,                 -- keccak256 of the receipt body; swap a field and this changes
  schema_version      text not null,                    -- the receipt's `schema` (e.g. immune-combined-receipt/1)
  experiment_id       text not null,
  mission_id          text,                              -- from the signed sandbox attestation payload
  artifact_hash       text not null,
  result              text not null,                     -- correct | incorrect | not_scorable (the headline, never a bare VERIFIED)
  settlement_outcome  text not null,                     -- success | failure | none (a verified-incorrect may legitimately be a failure)
  mode                text not null,                     -- shadow | active
  independence_class  text not null,                     -- same_controller_measured never becomes independent_counterparty by replay
  maker_id            text,
  maker_controller    text,
  checker_id          text,
  evaluation_version  text,
  policy_digest       text,
  settlement_event_id text,
  ruler               jsonb,                             -- {oracle_set_id, hash} — a measurement with no ruler is not a result
  receipt             jsonb not null,                    -- the FULL signed combined receipt = the re-verifiable evidence (hashes + attestations only; NO raw artifacts or secrets)
  recorded_at         timestamptz not null default now()
);
comment on table public.immune_receipts is
  'Append-only immune combined-receipt evidence, keyed by content_hash. INSERT-only: a correction is a NEW row (new content_hash) + a superseded event, never an UPDATE. `receipt` holds only hashes + signed attestations — never raw artifacts or secrets. Storage implies ONLY that the evidence exists; state is read from immune_receipt_state, never from this row.';
create index if not exists immune_receipts_experiment_idx on public.immune_receipts (experiment_id);
create index if not exists immune_receipts_recorded_idx   on public.immune_receipts (recorded_at);

-- ── 2. immune_receipt_events — the append-only lifecycle event log ──────────────────────────────────
create table if not exists public.immune_receipt_events (
  id            bigserial primary key,
  content_hash  text not null references public.immune_receipts(content_hash),
  event_type    text not null check (event_type in (
                  'recorded',              -- the evidence was stored (M2)
                  'outcome_verified',      -- verifyCombinedReceipt passed: crypto + bindings + no recombination (M2)
                  'verification_failed',   -- verifyCombinedReceipt failed — preserved, never deleted (M2)
                  'origin_authenticated',  -- P0: protected engine authenticated the execution ORIGIN (engine role only)
                  'policy_authorized',     -- the owner grant was bound + verified (engine role only)
                  'settled',               -- a RepID delta was durably settled (M3, engine role only)
                  'anchored',              -- anchored on-chain, testnet (M4, engine role only)
                  'revoked',               -- the evidence/authority was revoked
                  'superseded'             -- replaced by a correction (event_data.superseded_by = new content_hash)
                )),
  event_data    jsonb,                     -- verification reasons / provenance record / settlement ref / revocation reason / superseded_by
  actor         text not null,             -- who appended it (e.g. 'immune-slice-ci', 'repid-engine-protected')
  recorded_at   timestamptz not null default now()
);
comment on table public.immune_receipt_events is
  'Append-only lifecycle events for an immune receipt. INSERT-only (no UPDATE/DELETE). Current state is folded from these, not from immune_receipts. The once-only states are idempotent under concurrency via the unique index below.';
create index if not exists immune_receipt_events_hash_idx on public.immune_receipt_events (content_hash);
-- atomic idempotency for the SINGLE-OCCURRENCE states: two workers racing to authenticate/settle/anchor
-- the same receipt cannot both win — the second INSERT conflicts (Chat: concurrency uniqueness).
create unique index if not exists immune_receipt_events_once_idx
  on public.immune_receipt_events (content_hash, event_type)
  where event_type in ('origin_authenticated', 'policy_authorized', 'settled', 'anchored');

-- ── 3. immune_receipt_state — the DERIVED current-state projection (never infer state from a row) ────
-- security_invoker: the view runs with the QUERYING role's privileges, so it can never leak rows past the
-- underlying tables' grants/RLS (without it a view owned by a privileged role would bypass the lockout below).
create or replace view public.immune_receipt_state
  with (security_invoker = true) as
select
  r.content_hash,
  r.experiment_id,
  r.result,
  r.settlement_outcome,
  r.mode,
  r.independence_class,
  bool_or(e.event_type = 'recorded')             as is_recorded,
  bool_or(e.event_type = 'outcome_verified')     as is_outcome_verified,
  bool_or(e.event_type = 'origin_authenticated') as is_origin_authenticated,
  bool_or(e.event_type = 'policy_authorized')    as is_policy_authorized,
  bool_or(e.event_type = 'settled')              as is_settled,
  bool_or(e.event_type = 'anchored')             as is_anchored,
  bool_or(e.event_type = 'revoked')              as is_revoked,
  bool_or(e.event_type = 'superseded')           as is_superseded,
  -- AUTHORITATIVE is derived, NOT read from the receipt's self-asserted field: it requires an
  -- origin_authenticated event (P0, engine-appended) and must not be revoked or superseded.
  (bool_or(e.event_type = 'origin_authenticated')
     and not bool_or(e.event_type = 'revoked')
     and not bool_or(e.event_type = 'superseded')) as is_authoritative,
  max(e.recorded_at) as last_event_at
from public.immune_receipts r
left join public.immune_receipt_events e on e.content_hash = r.content_hash
group by r.content_hash, r.experiment_id, r.result, r.settlement_outcome, r.mode, r.independence_class;
comment on view public.immune_receipt_state is
  'Derived current state per receipt, folded from immune_receipt_events. is_authoritative requires an origin_authenticated event (P0) and no revoke/supersede — it is NOT the receipt.authoritative field. Consumers read state HERE, never from row existence.';

-- ── SECURITY: append-only, deny-by-default, no implicit anon/authenticated access (ENFORCED DDL) ─────
-- Enforced as DDL, not comments. The backend connects as service_role, which bypasses RLS for row access
-- but is STILL bound by table GRANTS — so revoking UPDATE/DELETE/TRUNCATE from it makes append-only hold
-- even for the engine (a correction is a NEW row + a `superseded` event, never an UPDATE). RLS is enabled
-- with NO permissive policy, so every non-bypass role (incl. the PostgREST-exposed anon/authenticated) gets
-- nothing by default (CWE-862: no row is reachable without an explicit grant + policy).
alter table public.immune_receipts       enable row level security;
alter table public.immune_receipt_events enable row level security;

revoke all on public.immune_receipts       from anon, authenticated;
revoke all on public.immune_receipt_events from anon, authenticated;
revoke all on public.immune_receipt_state  from anon, authenticated;

revoke update, delete, truncate on public.immune_receipts       from service_role;
revoke update, delete, truncate on public.immune_receipt_events from service_role;
grant  select, insert           on public.immune_receipts       to   service_role;
grant  select, insert           on public.immune_receipt_events to   service_role;
grant  select                   on public.immune_receipt_state  to   service_role;

-- INTENT (future least-privilege split — owner provisions the roles; NOT applied here): a dedicated
-- immune_worker gets INSERT on immune_receipts + an RLS policy on immune_receipt_events WITH CHECK
-- (event_type in ('recorded','outcome_verified','verification_failed')), while the authoritative events
-- ('origin_authenticated','policy_authorized','settled','anchored') and 'revoked'/'superseded' stay
-- INSERTable only by the engine role. Until those roles exist, service_role is the single trusted writer
-- and the TS layer (receipt-store.ts recordReceipt) enforces the M2-vs-engine split in process.

-- ── ROLLBACK (DOWN) — undo if ever applied (nothing live depends on it while IMMUNE_PERSIST_ENABLED is off) ─
-- drop view if exists public.immune_receipt_state;
-- drop table if exists public.immune_receipt_events;
-- drop table if exists public.immune_receipts;
