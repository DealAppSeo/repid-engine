-- DRAFT — NOT APPLIED. Sean applies prod DDL (CLAUDE_RULES r6/r28). Nothing reads or writes this
-- table unless PAYMENT_ANCHOR_VERIFY_MODE is set (default off).
--
-- PAYMENT ANCHOR CLAIMS: one on-chain settlement anchors at most one contract, once.
--
-- Why. A payment anchor (an x402 settlement tx hash) is what lets a high-value success earn
-- RepID: wash-trading reputation is meant to require wash-trading money. Without a replay table,
-- one real 1 USDC payment can be presented again and again, for the same contract or for any
-- other, and every presentation verifies on chain because the tx is real. The E2E eval of
-- 2026-11-16 (gap 4) found the anchor accepted on shape alone; this table is the "once" half of
-- the fix. src/services/payment-anchor-verify.ts is the other half: it reads the receipt and binds
-- the tx to the contract named by our own records.
--
-- The UNIQUE key is the authority, not the code. The verifier pre-checks with a SELECT only to skip
-- an RPC call; two concurrent presentations of one tx race on this constraint, and the loser gets
-- 23505, which the code reports as a replay.
--
-- x402_settlements.tx_hash already exists but is NOT unique (only idx_x402_settlements_tx_hash,
-- a plain btree, MEASURED 2026-11-16), and it records server-side settlements, not anchors
-- presented by a caller. This is a separate table so a future reader never has to wonder whether a
-- row was the engine settling or a caller anchoring.
--
-- Service role only: RLS on, no policies, no grants to anon/authenticated.

create table if not exists public.payment_anchor_claims (
  id               uuid primary key default gen_random_uuid(),
  chain_id         integer not null,
  tx_hash          text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),   -- lowercase, enforced
  contract_id      uuid not null,
  payee_address    text not null check (payee_address ~ '^0x[0-9a-f]{40}$'),
  payer_address    text check (payer_address is null or payer_address ~ '^0x[0-9a-f]{40}$'),
  amount_units     numeric(78, 0) not null check (amount_units > 0),     -- USDC smallest unit
  settlement_kind  text not null check (settlement_kind in ('eip3009', 'transfer')),
  verified_at      timestamptz not null,
  created_at       timestamptz not null default now()
);

create unique index if not exists payment_anchor_claims_tx_uidx
  on public.payment_anchor_claims (chain_id, tx_hash);

create index if not exists payment_anchor_claims_contract_idx
  on public.payment_anchor_claims (contract_id);

alter table public.payment_anchor_claims enable row level security;
revoke all on public.payment_anchor_claims from anon, authenticated;

comment on table public.payment_anchor_claims is
  'One settlement tx anchors at most one contract, once (unique chain_id, tx_hash). Written by src/services/payment-anchor-db.ts only after the receipt verified on chain. Read by the replay pre-check.';
