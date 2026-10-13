-- KERNEL RECEIPTS INDEX — a queryable mirror of the kernel's JSONL ledger (#1338).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated). FILE ONLY.                                       ║
-- ║  Do NOT run `apply_migration`/DDL against the shared project for this. The orchestr-║
-- ║  ator applies it when Sean decides. With this table ABSENT and the feature flag     ║
-- ║  CONFIRMED_OUTCOME_SCORING_ENABLED OFF (its default), nothing in production reads or ║
-- ║  writes it, and no score moves. This migration arms nothing on its own.             ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHAT. The kernel's authoritative record is the APPEND-ONLY JSONL ledger
-- (src/kernel/store.ts + routes/kernel.ts). That file is unchanged and stays the source of
-- truth. This table is a BEST-EFFORT secondary index: one row per receipt_id, written AFTER
-- the JSONL append succeeds, so a server-side verifier can look a receipt up by id without
-- re-reading an ephemeral file. A write here failing (or this table being absent) must never
-- affect the kernel decision path — the app-side writer swallows every error.
--
-- WHY THE CONFIRMED-OUTCOME VERIFIER NEEDS IT (CWE-345). The confirmed-outcome score
-- (src/scoring/confirmed-outcome.ts) moves ONLY on a SERVER-DERIVED confirmation. The verifier
-- (src/engine/repid-update.ts::resolveServerConfirmation) reads a row here BY receipt_id and
-- binds it to the ACTOR: `subject_agent_id` must equal the acting agent, the verdict must be
-- SETTLED, verification VERIFIED/FAILED, NOT simulated, and settled_by holdout/known_answer.
-- A caller supplies only a receipt id; the authoritative row is read here. A caller cannot
-- forge a row because RLS + GRANTs below make this service-role-only (a `sb_secret_…` key).
--
--   receipt_id          the call's id (minted before the tool runs). PRIMARY KEY, so the
--                       executed:true outcome row UPSERTs over the earlier decision row.
--   subject_agent_id    the agent the receipt is about — the actor-binding anchor.
--   settled_by          null | 'holdout' | 'known_answer' | 'person' (kernel SettledBy).
--   verdict_label       'PROVISIONAL' | 'SETTLED'.
--   verification_status 'VERIFIED' | 'FAILED' | 'NOT_CHECKED' | 'NOT_APPLICABLE'.
--   is_simulated        a simulated record can never settle a real score move.
--   receipt_hash        keccak of the receipt (audit; the JSONL chain remains authoritative).
--   receipt             the full kernel-receipt/1 JSON.
--   consumed_at         ONE-TIME USE (replay-inert). NULL until a server-verified confirmation
--                       first MOVES a score; the engine then claims the receipt with a conditional
--                       `UPDATE ... SET consumed_at = now() WHERE receipt_id = $1 AND consumed_at
--                       IS NULL RETURNING receipt_id` (repid-update.ts::claimConfirmationReceipt).
--                       A second attempt with the same receipt_id matches ZERO rows and is held
--                       inert — no second move. A NULL here means "not yet spent", NEVER "verified":
--                       the verification checks (settled/verdict/simulated/settled_by) are separate.
--
-- ACCESS. RLS on; every privilege revoked from anon and authenticated — only the engine's
-- secret key (service_role) reads or writes. Mirrors supabase/migrations/20261006160000_
-- answer_key_graph.sql. No row holds anything about an end user.

create table if not exists public.kernel_receipts (
  receipt_id          text        primary key,
  subject_agent_id    text        not null,
  settled_by          text,
  verdict_label       text,
  verification_status text,
  is_simulated        boolean     not null,
  receipt_hash        text,
  receipt             jsonb       not null,
  consumed_at         timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists kernel_receipts_subject_idx
  on public.kernel_receipts (subject_agent_id);

alter table public.kernel_receipts enable row level security;

revoke all on public.kernel_receipts from anon, authenticated;

-- ── ROLLBACK (DOWN) — run this to undo, if the table is ever applied ───────────────────
-- drop index if exists public.kernel_receipts_subject_idx;
-- drop table if exists public.kernel_receipts;
