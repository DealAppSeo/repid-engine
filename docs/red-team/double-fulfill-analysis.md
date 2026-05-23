# Red Team — Economic Attack 3: Double-Fulfill (state-machine analysis + constraint audit)

**Date:** 2026-05-23 · **Author:** CC2 (Backend Hardening R1) · **Firing mode:** deterministic-only (NO live firing of deltas/on-chain).
**Verdict:** ⚠️ **REAL, currently-unguarded gap** (latent — not yet exploited). Surfaced per the stop-and-surface rule. Fix handed to Gemini (route owner); not applied by CC2.

## 1. Attack
Same service contract fulfilled more than once → duplicate RepID deltas + duplicate
`service_fulfilled_settled` bridge events + (once on-chain writes are live) duplicate attestations.
Vectors: route retry / double-submit, two concurrent `/fulfill` requests, or a worker re-processing.

## 2. State-machine analysis (read-only)

`POST /:id/fulfill` — `src/routes/v1/contracts.ts:214-235`:
```
UPDATE service_contracts SET status='fulfilled', result, fulfilled_at WHERE id = :id   -- (1) no status precondition
if (data) await applyServiceFulfilledDeltas(data)                                       -- (2) re-applies every call
```
`applyServiceFulfilledDeltas` — `src/services/validation-repid-delta.ts:206`: **no internal idempotency
or status check.** It unconditionally calls `applyValidationEvent(provider,'SERVICE_FULFILLED',...)` and
`applyValidationEvent(buyer,'SERVICE_FULFILLED',...)` (each mutates RepID + writes `repid_score_events`
with `metadata.contract_id`), then inserts a `repid_events` `service_fulfilled_settled` row. Idempotency
is therefore entirely the caller's responsibility — and the caller has none. Same applies to the other
callers (`service-handler-base.ts:210`; cascade-settlement-worker).

## 3. FSM trigger (the reason the DB doesn't save us)
`enforce_service_contract_status_transition` (trigger `trg_service_contracts_status_transition`) permits:
```
escrowed  -> escrowed | fulfilled | disputed | expired
fulfilled -> fulfilled | satisfied | disputed     <-- fulfilled -> fulfilled is ALLOWED (self-transition)
```
So the second `/fulfill` UPDATE is a *valid* transition → it succeeds → `data` is returned → deltas
re-applied. The trigger blocks illegal *jumps*, not *repeats*.

## 4. Constraint audit (no per-contract backstop)
- `repid_events`: PK(id) only; `event_type` CHECK includes `service_fulfilled_settled`; index on
  `(subject_type, subject_id)` is **non-unique**. `subject_id` = **agent_id**, not contract (one agent
  legitimately has many — SHOFET has 26), and `event_data.contract_id` is NULL → **a per-contract unique
  index cannot even be built here, and a `(subject_id,event_type)` unique would catastrophically cap an
  agent at one lifetime fulfillment.** Do NOT add it.
- `repid_score_events`: PK(id) only; `SERVICE_FULFILLED`/`SERVICE_SATISFIED` allowed; carries
  `metadata.contract_id` + `metadata.role`. **No per-contract uniqueness.**
- `erc8004_reputation_writes`: UNIQUE(`tx_hash`) only — dedups identical transactions, not per-contract
  (two real fulfillments → two distinct tx_hashes).

## 5. Deterministic proof (DB-cleanable, fired nothing downstream)
SQL FSM walk (status-only; no route, no `applyServiceFulfilledDeltas`, no RepID/on-chain):
pending → escrowed → fulfilled → **fulfilled (succeeded, no exception)** = gap; then a
status-preconditioned update `WHERE id=:id AND status='escrowed'` matched **0 rows** = fix works.
Row deleted; leftover = 0. Production check: **0 duplicate SERVICE_FULFILLED per (contract_id, role)**
across 93 contracts / 169 events → not yet exploited.
Codified: `tests/red-team/double-fulfill.test.ts`.

## 6. Fix (handed to Gemini — route is x402 territory this cycle)
**Primary (app-level, one line):** add `.eq('status','escrowed')` to the `/fulfill` UPDATE so the
transition is atomic and idempotent — a second call matches 0 rows → return idempotent/409 and skip
delta application. Mirror at the other callers. Full diff in `CC2_HANDOFF_TO_GEMINI_x402.md` (H4).
**Why not a DB unique index alone:** `applyValidationEvent` mutates `current_repid` *before* inserting
the score event, so a unique-index rejection on insert would still leave a double RepID award. The
precondition is the correct primary control; a DB index is optional defense-in-depth and must be
coordinated with CC1 (bridge owner).

CC2 did not modify `contracts.ts` / `validation-repid-delta.ts` (CC1/Gemini territory).
