# Metrics truth — what each number actually counts
**2026-08-01, queried live.** Written because "2", "3" and "39" were all being used for the same claim and all three were true of different questions. Use this before any post, deck, or investor line.

## The four numbers, and what each one means

| Number | Definition | Value | Safe to say |
|---|---|---|---|
| **Full harness loops** | `service_contracts.status='settled'` **AND** a non-simulated settlement with a real `tx_hash` | **3** | ✅ *"three complete trust loops, all verifiable on-chain"* |
| Real x402 settlements | `x402_settlements.is_simulated=false AND tx_hash IS NOT NULL` | 39 | ⚠️ money-path only — **36 of these predate the A2A contract path** |
| Contract-linked settlements | the above, joined to a real contract row | 3 | ✅ same as full loops |
| `/stats.recent_settlements` | `count(*) FROM x402_settlements WHERE created_at > now() - 7 days` | 2 | ❌ **never call this "trust loops"** |

## Why the numbers diverge

Of the 39 real settlements, **36 have no contract row at all** — their `idempotency_key` is not a contract id. They ran 2026-07-03 → 07-08, before the A2A contract path existed. They are real money movements; they are **not** harness loops. Quoting 39 as "trust loops completed" would overstate by 13×.

`/stats.recent_settlements` is a 7-day window with **no `is_simulated` filter and no contract join**. It can simultaneously overstate (counts simulated rows) and understate (ignores anything older than a week). It is a liveness indicator, not an achievement count.

## The three real loops

| contract | date | settlement tx | RepID events | on-chain writes |
|---|---|---|---|---|
| `2eccd820…` | 2026-07-23 | `0x…` ✅ | 4 | 1 |
| `e2dfb4ca…` | 2026-08-01 | `0x11dd9fd6…` ✅ | 4 | 1 |
| `97c2d308…` | 2026-08-01 | `0x588f905a…` ✅ | 4 | 1 |

`97c2d308` is the showcase receipt — the only one that was **negotiated** (2 competing bids).

## A correction to my own reporting

I published "3 settled contracts" in the 2026-08-01 handoff. At that moment it was **true of contract status and false of the thing people would infer** — one of the three (`e2dfb4ca`) had a settlement row stuck at `status='settling'` with a NULL `tx_hash`, the residue of an unchecked-write bug I fixed in `8a2c748` without reconciling the row it damaged.

The transfer was always real — `0x11dd9fd6…`, block 44896192, SUCCESS, 0.10 USDC — verified directly on Base Sepolia before the row was repaired. **The chain was ahead of the ledger for ~12 hours and nothing surfaced it.** That is the failure mode `SETTLED_UNRECORDED` now exists to name, and it argues for a reconciliation sweep rather than trusting that a fix repairs its own history.

## Rules

1. **"Full harness loop" is the only number for the trust claim.** It requires a settled contract *and* real money *and* reputation movement.
2. **Never quote `/stats` as an achievement.** It answers "is anything happening this week".
3. **Real settlements ≠ loops.** If the split matters to the claim, state both.
4. **A fixed bug does not repair the rows it damaged.** Reconcile explicitly, against the chain, and say when you did.
