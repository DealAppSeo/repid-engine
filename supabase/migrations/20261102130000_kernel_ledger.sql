-- KERNEL LEDGER — the policy kernel's authoritative ledger, durable (RT-3 / RT-3b / RT-4).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated, HIGH). FILE ONLY.                                 ║
-- ║  Nothing reads or writes this table until KERNEL_LEDGER_BACKEND=supabase is set on  ║
-- ║  repid-engine. Apply it BEFORE setting the flag: with the flag set and this table   ║
-- ║  ABSENT, every ledger read fails and every kernel spend is refused (NOT_CHECKED).   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY. The kernel's owner limits are only as durable as the ledger they live in. Today that ledger is a
-- JSONL file in the OS temp directory (src/routes/kernel.ts), which a Railway restart or redeploy empties:
--   RT-3   the nonce high-water mark is lost, so an older, still-unexpired generous policy can be POSTed
--          again over the owner's limit-to-zero, and is accepted;
--   RT-3b  the spend history is lost, so the daily and total caps start again from zero;
--   RT-4   (fixed in code by reserving /decide spend ALLOWs; it needs this table to survive a restart).
--
-- WHAT. One row per ledger record (a receipt or a signed policy), holding the exact JSONL line the file
-- ledger would have written. TEXT, not jsonb, so a receipt reads back byte for byte and its keccak hash and
-- Ed25519 signature (kernel-receipt/2) still verify. src/kernel/store.ts createSupabaseStore reads it in
-- seq order and rebuilds the same index the file ledger builds.
--
--   seq          1, 2, 3, ... assigned by the writer as 1 + the last row it read. PRIMARY KEY: two writers
--                that read the same tip (two replicas) collide here, the second is refused and re-reads, so
--                the receipt chain cannot fork and a stale replica cannot spend a budget already spent.
--                The reader refuses the whole ledger on a gap, so a deleted row is never read as absent.
--   line         the record, as one line of JSON.
--   recorded_at  when the row landed (audit only; the kernel reads times from the records).
--
-- APPEND-ONLY. UPDATE, DELETE and TRUNCATE are refused by trigger (for every role, the table owner
-- included) and their privileges are revoked from service_role. A ledger row that could be edited or
-- removed would let a lost limit-to-zero or a lost spend read as "nothing there".
--
-- ACCESS. RLS on with no policies, every privilege revoked from anon and authenticated: only the engine's
-- secret key (service_role) reads and inserts. Mirrors 20261013000000_kernel_receipts.sql. Rows hold agent
-- ids, owner wallet addresses, policy limits and receipt hashes; never an end user's personal data, and
-- never a tool's arguments (receipts carry only their hash).

create table if not exists public.kernel_ledger (
  seq         bigint      primary key check (seq > 0),
  line        text        not null,
  recorded_at timestamptz not null default now()
);

alter table public.kernel_ledger enable row level security;

revoke all on public.kernel_ledger from anon, authenticated;
revoke update, delete, truncate on public.kernel_ledger from service_role;
grant select, insert on public.kernel_ledger to service_role;

create or replace function public.kernel_ledger_refuse_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.kernel_ledger is append-only: % is refused', tg_op;
end;
$$;

drop trigger if exists kernel_ledger_no_update_delete on public.kernel_ledger;
create trigger kernel_ledger_no_update_delete
  before update or delete on public.kernel_ledger
  for each row execute function public.kernel_ledger_refuse_change();

drop trigger if exists kernel_ledger_no_truncate on public.kernel_ledger;
create trigger kernel_ledger_no_truncate
  before truncate on public.kernel_ledger
  for each statement execute function public.kernel_ledger_refuse_change();

-- ── VERIFY (expect: rls true, 0 rows, the two triggers) ─────────────────────────────────
-- select relrowsecurity as rls, (select count(*) from public.kernel_ledger) as rows
--   from pg_class where oid = 'public.kernel_ledger'::regclass;
-- select tgname from pg_trigger where tgrelid = 'public.kernel_ledger'::regclass and not tgisinternal;
--
-- ── ROLLBACK (DOWN) ─────────────────────────────────────────────────────────────────────
-- First unset KERNEL_LEDGER_BACKEND (or set it to "file") on repid-engine and redeploy: the kernel goes back
-- to the temp-dir file. Then the table can stay; it is inert. Dropping it DESTROYS the durable ledger (the
-- owner limits and spend history it holds), which is exactly RT-3/RT-3b; only do it on purpose:
-- drop table if exists public.kernel_ledger;
-- drop function if exists public.kernel_ledger_refuse_change();
