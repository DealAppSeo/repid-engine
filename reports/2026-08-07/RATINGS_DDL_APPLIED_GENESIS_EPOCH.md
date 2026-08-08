# Prod DDL applied — repid_ratings + repid_outcomes with Genesis epoch policy

**Date:** 2026-08-07
**Authorized by:** Sean — "GO ratings DDL only with epoch/provenance."
**Applied by:** CC via Supabase MCP `apply_migration` (name: `repid_ratings_with_genesis_epoch`).
**Project:** `qnnpjhlxljtqyigedwkb` (Trinity prod) — confirmed by `repid_agents` presence before applying.
**Migration file:** `migrations/2026-08-07_repid_ratings.sql` (amended to match exactly what was applied).

## What was applied
Two tables (both were absent — verified `information_schema` before applying, no clobber):
- `repid_outcomes` — server-side source of truth for rating admissibility (gate decision + fold root + counterparty + value_at_risk).
- `repid_ratings` — append-only rating log; one rating per (rater, outcome, stage); no self-rating.

## Genesis epoch policy (the new part, per Sean 2026-08-07)
Both tables carry two permanent, queryable labels so a bootstrap/dogfood score can never be
laundered as organically-earned:
- `epoch text NOT NULL DEFAULT 'genesis'` CHECK IN (`iam`, `genesis`, `earned`)
  - **iam** = identity commitment exists, no score claim · **genesis** = V1 cohort, disclosed · **earned** = external.
- `provenance text NOT NULL DEFAULT 'bootstrap'` CHECK IN (`bootstrap`, `external`)
  - **bootstrap** = we generated it (dogfood) · **external** = a stranger did.

Defaults are the honest current state: we are in the genesis epoch; unproven rows are bootstrap.

**No stake capital on Genesis scores** — enforced at the DB, not just the app:
```sql
CONSTRAINT chk_no_stake_on_bootstrap CHECK (
  provenance <> 'bootstrap' OR value_at_risk IS NULL OR value_at_risk = 0
)
```
A bootstrap outcome cannot carry real value-at-risk. Fail-closed.

## Verification (done = provable)
- `epoch`/`provenance` columns present on both tables, defaults `'genesis'` / `'bootstrap'` [SQL].
- Both guards present in `pg_constraint`: `chk_no_stake_on_bootstrap`, `chk_no_self_rating` [SQL].
- Live functional test (in a self-cleaning DO block): a bootstrap outcome with `value_at_risk = 5`
  was **rejected** (`check_violation`); a bootstrap outcome with `value_at_risk = 0` was **accepted**.
- Prod clean afterward: `repid_outcomes` = 0 rows, `repid_ratings` = 0 rows, leaked test rows = 0 [SQL].

## Effect
The ratings API (merged in #367) now has its tables. Until now `GET /ratings/:agentId` returned an
empty summary and `POST /ratings` failed closed. Ratings can now be ingested — every genesis-epoch
row labeled, never counted as earned, never able to unlock real capital. This unblocks dogfooding the
scoring machine (deltas fire, gate refuses, drift flags) without poisoning the claim ledger.

## What this does NOT claim
Dogfooding proves the **machine** works, not that the **weights are calibrated** to stranger
behavior — those are different rulers, kept separate. No external user yet.
