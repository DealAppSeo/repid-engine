# Red Team — Economic Attack 4: Self-dealing (analysis + applied fix)

**Date:** 2026-05-23 · **Author:** CC2 (Backend Hardening R1) · **Status:** direct variant **FIXED** (DB constraint applied); sock-puppet variant = V2.

## 1. Attack
An agent sets itself as both `buyer_agent_id` and `provider_agent_id` on a `service_contracts`
row and "fulfills" it, minting RepID with no external counterparty.

## 2. Deterministic check (read-only)
- **Current occurrences:** `SELECT COUNT(*) FROM service_contracts WHERE buyer_agent_id = provider_agent_id` → **0**.
- **Existing guards:** none. No code in `src/` compares buyer vs provider before contract creation;
  no DB constraint existed. Gap real but unexploited.

## 3. Fix applied (DB layer — the one data-layer write sanctioned for this attack)
Migration `supabase/migrations/20260523120000_no_self_dealing_service_contracts.sql`:
```sql
ALTER TABLE service_contracts
  ADD CONSTRAINT service_contracts_no_self_dealing
  CHECK (buyer_agent_id <> provider_agent_id);
```
Idempotent (guarded on `pg_constraint`), reversible (`DROP CONSTRAINT`). Applied to prod
(`qnnpjhlxljtqyigedwkb`) and verified: constraint present, a self-dealing insert is rejected with
`check_violation`, a cross-agent insert still succeeds, 0 current self-deals, 0 leftover test rows.
Regression: `tests/red-team/self-dealing.test.ts`.

## 4. Endpoint guard (handed to Gemini)
The CHECK surfaces as a DB error (→ 500) on the create path. For a clean 4xx, add an explicit guard at
the contract-creation endpoint (contracts.ts, x402 territory this cycle):
```ts
if (req.body.buyer_agent_id === req.body.provider_agent_id) {
  return res.status(400).json({ error: 'self_dealing_not_allowed', message: 'buyer and provider must differ' });
}
```
Handoff: `CC2_HANDOFF_TO_GEMINI_x402.md` (H3). CC2 did not modify `contracts.ts`.

## 5. Sock-puppet variant → V2
One operator controlling two distinct `agent_id`s with mutual contracting defeats a same-id check.
Mitigation needs off-chain identity linking (ERC-8004 identity binding / TrustEnvoy.dev), human
verification, or statistical pattern detection (overlaps with the RepID-inflation concentration work
in `repid-inflation-analysis.md`). Out of scope tonight; documented as V2 follow-up.
