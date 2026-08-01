# Investigation Report: Stuck Contract `18dd4e05` Lifecycle Analysis

**Date:** August 1, 2026  
**Subject Contract:** `18dd4e05-121e-4a80-9c1e-2a538dacd9e0` (Stuck at `status='fulfilled'`)  
**Comparison Contract:** `2eccd820-c523-4aa3-b4d9-f0e1847c729a` (Successfully completed on the same day)  

---

## Executive Summary
This report analyzes why the lifecycle of service contract `18dd4e05-121e-4a80-9c1e-2a538dacd9e0` stalled after reaching `status='fulfilled'`. 

Our database analysis confirms that:
1. The buyer's escrow payment was successfully verified and settled on-chain (0.10 USDC, tx `0x3270e29cfed601bebcdbfd6e25926f82d9438f03eb23a51c7da3fe2eeb1656a9`).
2. The contract was successfully processed by the handler, verified (verdict: `PASS`), and updated to `status='fulfilled'`.
3. The reason the contract never closed is that **the buyer never called the `/api/v1/contracts/:id/satisfy` endpoint**. 
4. The most likely cause of this stall is a **Gateway Timeout (30s proxy limit)** during the synchronous `/api/v1/agent/process-contracts` request. Because the handler took **51.7 seconds** to verify the first contract, the client aborted the execution flow before reaching the `/satisfy` step.

---

## 1. Database-Sourced Lifecycle Artifacts

### A. Stuck Contract Row (`18dd4e05-121e-4a80-9c1e-2a538dacd9e0`)
* **Status:** `fulfilled`
* **Agreed Price (Raw):** `100000` (0.10 USDC)
* **Buyer Agent ID:** `848da285-93c5-4e99-a989-3d9e49ebed09`
* **Provider Agent ID:** `84f2d7de-5bb9-4f3b-92ca-aecc7c498271`
* **Payment ID (`x402_payment_id`):** `234a364a-46c1-4a47-a5b8-b325f8b2b762`
* **Dispute Validation Queue ID:** `null`
* **Dispute Verdict:** `null`
* **Buyer Satisfaction Score:** `null`
* **Timestamps:**
  * `created_at`: `2026-07-23T04:32:29.813381+00:00`
  * `escrowed_at`: `2026-07-23T04:32:31.746000+00:00`
  * `fulfilled_at`: `2026-07-23T04:33:23.538000+00:00`
  * `settled_at`: `2026-07-23T04:32:31.746000+00:00` (Note: Set to the escrow time due to legacy pre-billing behavior)
  * `satisfied_at`: `null`
  * `expires_at`: `2026-07-30T04:32:29.813381+00:00`
* **Result Object:**
  ```json
  {
    "score": 0.8499999999999999,
    "verdict": "PASS",
    "confidence": 0.9,
    "validators": [
      "HUMAN",
      "CC2-INT-1777945733967",
      "HUMAN"
    ],
    "contract_id": "18dd4e05-121e-4a80-9c1e-2a538dacd9e0",
    "verified_at": "2026-07-23T04:33:23.538Z",
    "patent_marker": "P-001",
    "validator_count": 3
  }
  ```

### B. Stuck Contract Settlement Row (`x402_settlements`)
* **ID:** `234a364a-46c1-4a47-a5b8-b325f8b2b762`
* **Tip ID:** `contract_18dd4e05-121e-4a80-9c1e-2a538dacd9e0`
* **Prediction Topic:** `verification`
* **Status:** `settled`
* **Amount:** `100000` (0.10 USDC)
* **Payer Address:** `0xdf6b8215D193b11B4903d223729c3CF7A6de271d`
* **Is Simulated:** `false` (Real on-chain settlement)
* **Transaction Hash:** `0x3270e29cfed601bebcdbfd6e25926f82d9438f03eb23a51c7da3fe2eeb1656a9`
* **Timestamps:**
  * `created_at`: `2026-07-23T04:32:31.723815+00:00`
  * `delivered_at`: `2026-07-23T04:32:31.713000+00:00`

### C. Stuck Contract Reputation Score Events (`repid_score_events`)
* **Provider Event (ID 157296):**
  * `agent_id`: `84f2d7de-5bb9-4f3b-92ca-aecc7c498271` (Provider)
  * `event_type`: `SERVICE_FULFILLED`
  * `delta`: `+10`
  * `repid_before`: `1410` | `repid_after`: `1420`
  * `created_at`: `2026-07-23T04:33:26.460850+00:00`
* **Buyer Event (ID 157297):**
  * `agent_id`: `848da285-93c5-4e99-a989-3d9e49ebed09` (Buyer)
  * `event_type`: `SERVICE_FULFILLED`
  * `delta`: `+5`
  * `repid_before`: `1195` | `repid_after`: `1200`
  * `created_at`: `2026-07-23T04:33:26.648244+00:00`

### D. Stuck Contract Queues
* **`dispute_validation_queue`:** `[]` (No entries associated with this contract ID)
* **`peer_verification_queue`:** `[]` (No entries associated with this contract ID)

---

## 2. Chronological Comparative Timeline (July 23, 2026)

This table tracks and compares the transaction flows of both contracts executed on the same day.

| Timestamp (UTC) | Event for Stuck Contract `18dd4e05` | Event for Completed Contract `2eccd820` |
| --- | --- | --- |
| **04:32:29.660** | `POST /api/v1/contracts` creation request received | |
| **04:32:29.813** | Row created in `service_contracts` (status='pending') | |
| **04:32:29.951** | `POST /api/v1/contracts/.../escrow` request received | |
| **04:32:31.713** | Payment delivered on-chain (tx `0x3270...`) | |
| **04:32:31.723** | Row created in `x402_settlements` (status='settled') | |
| **04:32:31.746** | Contract updated (status='escrowed', `settled_at` and `escrowed_at` set) | |
| **04:32:31.825** | `POST /api/v1/agent/process-contracts` request received | |
| **04:33:23.538** | Contract verification completed. Status updated to `'fulfilled'` | |
| **04:33:26.460** | Provider `repid_score_events` generated (+10 RepID) | |
| **04:33:26.648** | Buyer `repid_score_events` generated (+5 RepID) | |
| **04:33:35.729** | | `POST /api/v1/contracts` creation request received |
| **04:33:35.858** | | Row created in `service_contracts` (status='pending') |
| **04:33:35.986** | | `POST /api/v1/contracts/.../escrow` request received |
| **04:33:36.856** | | Payment delivered on-chain (tx `0xeea7...`) |
| **04:33:36.871** | | Row created in `x402_settlements` (status='settled') |
| **04:33:36.885** | | Contract updated (status='escrowed') |
| **04:33:36.961** | | `POST /api/v1/contracts/.../fulfill` request received (direct fulfill) |
| **04:33:37.021** | | Contract direct fulfillment completed. Status updated to `'fulfilled'` (takes only **60ms**) |
| **04:33:42.374** | | Provider FULFILLED `repid_score_events` generated (+10 RepID) |
| **04:33:42.523** | | Buyer FULFILLED `repid_score_events` generated (+5 RepID) |
| **04:33:42.697** | | `POST /api/v1/contracts/.../satisfy` request received |
| **04:33:42.725** | | Contract updated (status='satisfied') |
| **04:33:42.750** | | Contract updated (status='settled', `settled_at` updated to current time) |
| **04:33:42.803** | | Provider SATISFIED `repid_score_events` generated (+30 RepID) |
| **04:33:42.879** | | Buyer SATISFIED `repid_score_events` generated (+15 RepID) |

---

## 3. Findings: Distinguishing Data vs. Inference

### A. What the Data SHOWS (Factual Assertions)
1. **Verification Succeeded & Status Updated:** The database shows that contract `18dd4e05` successfully passed human/agent peer-validation consensus (`score: 0.85`, `verdict: "PASS"`). The engine updated its status to `fulfilled`, and registered its `repid_score_events` correctly.
2. **Missing `/satisfy` Request:** The `trinity_agent_logs` contains absolute record for all incoming E2E HTTP requests. On July 23, 2026, there are recorded endpoints for contract `2eccd820` (`/escrow`, `/fulfill`, `/satisfy`). However, for `18dd4e05`, there are only logs for `/escrow` and `/api/v1/agent/process-contracts`, but **no record of any `/satisfy` request**.
3. **Execution Latency Contrast:** The verification execution via the handler (`/api/v1/agent/process-contracts`) for `18dd4e05` took **51.7 seconds** (from the HTTP entry start to the contract's `fulfilled_at` timestamp). For `2eccd820`, the direct fulfillment endpoint (`/api/v1/contracts/:id/fulfill`) bypassed verification consensus and took only **60 milliseconds**.
4. **On-Chain Settlement Occurred at Escrow:** Both contracts had their payments settled on-chain during the escrow phase (since they both have associated `x402_settlements` with a valid transaction hash and status `'settled'`), indicating that "Settle on Delivery" was either disabled or bypassed.

### B. What is INFERRED (Highly Probable Explanations)
1. **Gateway Timeout / Connection Disconnect:** Because the handler-based verification request for `18dd4e05` took 51.7 seconds, the client calling `/agent/process-contracts` hit a **30-second Gateway Timeout** (standard proxy limit for platforms like Railway).
2. **Client Aborted Before `/satisfy` Execution:** As a consequence of the timeout, the E2E test runner client terminated with an HTTP 502/504 error. Because the client died, the sequential execution flow never reached the next step, which was to call `POST /api/v1/contracts/18dd4e05-121e-4a80-9c1e-2a538dacd9e0/satisfy`.
3. **Server Succeeded in Background:** Despite the client disconnect, the server completed the handler processing in the background, updating the database status to `fulfilled`. Since the client was already dead, the contract was left orphaned in `fulfilled` state.
4. **`2eccd820` Succeeded Due to Bypass:** The second contract (`2eccd820`) used direct fulfillment (`--direct-fulfill` flag), which processed instantly (60ms) and successfully completed before hitting any network/gateway timeouts, thereby allowing the `/satisfy` call to proceed normally.

---

## CC verification addendum (2026-08-01)

Report authored by GA. Claims re-run against prod Supabase before acceptance, per the
rule that an agent's report is `[reported]` until a query makes it `[verified]`.

**CONFIRMED [V]** — single query over `service_contracts` LEFT JOIN `x402_settlements`:

| contract | settled | fulfilled | delta |
|---|---|---|---|
| `18dd4e05` | 04:32:31.72 | 04:33:23.54 | fulfilled **53.7s** after creation, **51.8s** after payment |
| `2eccd820` | 04:33:36.87 | 04:33:37.02 | 1.16s |

The stall is real, the 50s-order latency is real, and `18dd4e05` is still `fulfilled`
with a genuine on-chain payment (`0x3270e29c…`, is_simulated=false).

**NARROWED — point 4 does not generalise.** The report concludes that settle-on-delivery
was "disabled or bypassed". That holds for the two **July** contracts, but not as a
statement about the system:

| contract | settled | fulfilled | order |
|---|---|---|---|
| `e2dfb4ca` (Aug 1) | 05:04:28.00 | 05:04:27.32 | settled **after** delivery ✓ |
| `97c2d308` (Aug 1) | 05:09:07.74 | 05:09:06.93 | settled **after** delivery ✓ |

Deferred settlement landed 2026-08-01 and works. July exchanges paid at escrow because
that is what the code did then — not because a working gate was bypassed.

**WHAT THIS FOUND DOWNSTREAM.** The public receipt asserted pay-on-delivery for every
exchange unconditionally, which made it false for exactly these July rows. Fixed in
repid-engine PR #299: the ordering is now derived per exchange and the narrative follows
it. That defect was worth more than the orphan itself, and it came out of checking the
report rather than accepting it.

**STILL OPEN — the structural point.** Loop completion depends on the CLIENT staying
connected long enough to call `/satisfy`. Any slow verification orphans a paid contract,
and the money has already moved. `npm run ops:reconcile` detects this class; nothing
closes it. Fixing that means making finalisation server-side rather than caller-driven —
a live behaviour change, so it is flagged, not made here.
