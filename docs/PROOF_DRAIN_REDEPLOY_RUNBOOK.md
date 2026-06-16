# PROOF_DRAIN_REDEPLOY_RUNBOOK — Route drain to real Plonky3 prover

**Date:** 2026-06-15  
**Author:** CC (feat/cc-2026-06-15-stub-quarantine)  
**Status:** STAGED — Sean action required. Do NOT restart until migration is applied.  
**Tier:** Steps 1–3 = Tier-2 (code/config, no prod data). Step 4 restart = Tier-3 (Sean-only Railway).

---

## Context

The proof-drain-worker currently targets `zkp-postcard-production.up.railway.app` (the stub prover).
It returns `proof_bytes=null` / `scheme=sha256_commitment_poc` → all rows land as stubs (`is_real=false`).

The REAL Plonky3 prover is `hyperdag-core-production.up.railway.app`. It returns real `proof_bytes`
(non-empty base64, ~10 KB) and `scheme='plonky3_range_check'`. Setting `ZKP_SERVICE_URL` on BOTH
services re-routes new queue entries to the real prover so drained rows become `is_real=true`.

---

## Pre-conditions (ALL must be true before proceeding)

- [ ] `2026-06-15-zkp-is-real-discriminator.sql` applied to prod (`qnnpjhlxljtqyigedwkb`) — Sean runs in Supabase SQL editor.
- [ ] `HyperDAG-core` Railway service is running (D-062 env var `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` confirmed set — already done per INFRA_INVENTORY §11).
- [ ] `feat/cc-2026-06-15-stub-quarantine` branch merged (or deployed directly from branch).
- [ ] `PROOF_DRAIN_RECORD_REAL_FIELDS=true` — enables the drain to write real `scheme`/`proof_bytes`/`statement` into `repid_zkp_proofs`. **Required for rows to be classified `is_real=true` by the migration backfill AND by new rows.**

---

## Step 1 — Apply the migration (Supabase SQL editor)

```sql
-- Run 2026-06-15-zkp-is-real-discriminator.sql verbatim.
-- Verify after:
SELECT is_real, scheme, count(*)
  FROM repid_zkp_proofs
 GROUP BY 1, 2
 ORDER BY 1, 2;
-- Expected: is_real=true → 1 row (the one real proof); is_real=false → ~56,823.
```

---

## Step 2 — Set env vars on Railway: `repid-engine` service

These control the ENQUEUE side (which URL goes into `repid_proof_queue.zkp_service_url`):

| Variable | Value |
|---|---|
| `ZKP_SERVICE_URL` | `https://hyperdag-core-production.up.railway.app` |
| `PROOF_DRAIN_RECORD_REAL_FIELDS` | `true` |

> **Why both services?** `pipeline.ts` and `agents-external.ts` enqueue using `process.env.ZKP_SERVICE_URL`.
> The drain worker's `fetchPendingBatch` filters `WHERE zkp_service_url = config.zkpServiceUrl`.
> Both must match or new queue rows won't be claimed by the new prover drain.

---

## Step 3 — Set env vars on Railway: `proof-drain-worker` service

| Variable | Value | Notes |
|---|---|---|
| `ZKP_SERVICE_URL` | `https://hyperdag-core-production.up.railway.app` | Must match repid-engine's value |
| `PROOF_DRAIN_RECORD_REAL_FIELDS` | `true` | Write real scheme/proof_bytes/statement to repid_zkp_proofs |
| `EAS_CONTINUOUS_ANCHOR_ENABLED` | `false` (keep OFF for now) | Turn ON only after verifying real proof rows appear |
| `PROOF_DRAIN_PROVER_TIMEOUT_MS` | `30000` (default) | Increase to 60000 if hyperdag-core is slow on cold starts |

---

## Step 4 — Restart proof-drain-worker (Sean Railway action)

In the Railway dashboard for the `proof-drain-worker` service:
1. Confirm env vars from Step 3 are saved.
2. Click **Deploy** (or trigger a redeploy from the branch).
3. Watch logs for the boot log line:
   ```
   [ProofDrainService] boot complete: zkpServiceUrl=https://hyperdag-core-production.up.railway.app PROOF_DRAIN_RECORD_REAL_FIELDS=true ...
   ```
4. Within 60 s the heartbeat log should appear:
   ```
   [ProofDrainService][heartbeat] status=running ticks=N ...
   ```

**Also restart repid-engine** so new enqueues use the new URL (Railway → repid-engine → Deploy).

---

## Step 5 — Verify (run after restart, allow 5 min)

```sql
-- Real proofs climbing:
SELECT count(*) FILTER (WHERE scheme IS NOT NULL AND octet_length(proof_bytes) > 0) AS real_proofs,
       count(*) FILTER (WHERE is_real = true) AS is_real_count,
       max(created_at) FILTER (WHERE is_real = true) AS latest_real
  FROM repid_zkp_proofs;
-- Expected: real_proofs > 0 and climbing; is_real_count matches real_proofs (post-migration).

-- Queue draining:
SELECT status, count(*) FROM repid_proof_queue
 WHERE zkp_service_url = 'https://hyperdag-core-production.up.railway.app'
 GROUP BY 1;
-- Expected: completed rows appearing; pending → 0 over time.
```

---

## Rollback

Set `ZKP_SERVICE_URL` back to `https://zkp-postcard-production.up.railway.app` on both services
and redeploy. Existing `is_real=true` rows are unaffected (the column is additive/reversible).
Set `PROOF_DRAIN_RECORD_REAL_FIELDS=false` to revert to stub-only inserts.

---

## Ambiguities / known issues

1. **Old queue rows**: rows already in `repid_proof_queue` with `zkp_service_url='https://zkp-postcard-production.up.railway.app'`
   will NOT be picked up by the re-routed drain (the WHERE filter won't match). They will either
   drain via the old worker if it is still running, or stay pending. To force-drain old rows:
   ```sql
   UPDATE repid_proof_queue
      SET zkp_service_url = 'https://hyperdag-core-production.up.railway.app'
    WHERE status = 'pending'
      AND zkp_service_url = 'https://zkp-postcard-production.up.railway.app';
   ```
   **Sean decides** whether to do this — it is a data change, not included in the code stage.

2. **hyperdag-core `/zkp/repid-proof` endpoint shape**: the drain sends
   `{ agent_id, score, nonce, metadata: { job_id } }`. The real prover must accept this shape
   and return `{ proof_type, commitment, proof_bytes, proof_size_bytes?, merkle_root?, proof_hash?, tier?,
   public_statement?, repid_score_actual?, poseidon2_leaf?, leaf_scheme? }`.
   If the endpoint path or request shape differs on the real prover, the drain will receive
   non-2xx → `withRetry` backs off → circuit breaker trips → logs loud. Check Railway logs if
   `real_proofs` stays at 0 after 10 minutes.

3. **`is_real` column migration must be applied BEFORE restart**: if the worker writes new rows
   before the migration runs, those new rows default to `is_real=false`. Re-run:
   ```sql
   UPDATE repid_zkp_proofs
      SET is_real = (scheme IS NOT NULL AND octet_length(proof_bytes) > 0);
   ```
   This is safe and idempotent.
