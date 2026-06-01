# RepID Engine Public API Reference

This document catalogs the public endpoints exposed by the RepID Engine. All details reflect the actual codebase implementation.

---

## GET /health

Returns the system health status, database connection test results, blockchain connection info, and validation queue metrics.

* **Path:** `/health`
* **Method:** `GET`
* **Authentication:** None (Public)
* **Response Code:** `200 OK`
* **Response Shape:**
  ```json
  {
    "status": "ok",
    "version": "1.0.0",
    "timestamp": "2026-06-01T23:49:11.000Z",
    "supabaseConnected": true,
    "hashkeyConnected": true,
    "hashkeyBlockNumber": 41917386,
    "hashkeyChainId": 84532,
    "deployerConfigured": true,
    "engine": "HyperDAG RepID Scoring Engine",
    "protocol": "hyperdag.dev",
    "validation_queue": {
      "processing_total": 0,
      "processing_hitl_pending": 0,
      "processing_stuck": 0,
      "processing_hitl_pending_over_24h": 0,
      "last_processed_at": "2026-05-24T06:09:07.000Z",
      "last_created_at": "2026-05-24T06:09:07.000Z",
      "pending_count": 0
    }
  }
  ```

> [!NOTE]
> There is also a basic health check mounted at `GET /api/v1/health` which returns:
> `{ "status": "ok", "version": "1.0.0", "service": "repid-engine" }`

---

## GET /api/v1/status

Returns a consolidated public system status overview, last telemetry heartbeat, Merkle audit status, and last 24h econ metrics.

* **Path:** `/api/v1/status`
* **Method:** `GET`
* **Authentication:** None (Public - bypasses global authorization checks)
* **Response Code:** `200 OK`
* **Response Shape:**
  ```json
  {
    "service": "repid-engine",
    "version": "1.0.0",
    "network": "base-sepolia",
    "timestamp": "2026-06-01T23:50:00.000Z",
    "operational": {
      "supabase": true
    },
    "metrics_24h": {
      "onchain_attestations": 0,
      "real_settlements": 0,
      "score_events": 120,
      "firecrawl": {
        "enabled": true,
        "calls": 0,
        "cost_usd_24h": 0,
        "by_agent": [],
        "note": "rollout active, 0 calls in last 24h (research agents only)"
      }
    },
    "last_heartbeat": null,
    "audit_status": null,
    "hero_receipt": "/api/v1/receipts/hero"
  }
  ```

---

## POST /api/v1/hal/evaluate

Evaluates a text payload using the Hallucination Auditor Layer (HAL) multi-signal pipeline (either the fast Extractor or the cross-LLM Fact-check depending on strictness).

* **Path:** `/api/v1/hal/evaluate`
* **Method:** `POST`
* **Authentication:** None (Public - bypasses global authorization checks & SQL-injection keywords sanitizer)
* **Request Header:** `Content-Type: application/json`
* **Request Body Example:**
  ```json
  {
    "text": "AI agent completed transaction at block 41917330.",
    "context": {
      "domain": "finance",
      "certainty": 0.85,
      "product": "trusttrader"
    },
    "strictness": 2
  }
  ```
* **Response Code:** `200 OK` or `400 Bad Request`
* **Response Shape:**
  ```json
  {
    "hal_score": 0.35,
    "decision": "clean",
    "mode": "fact-check",
    "strictness": 2,
    "product": "trusttrader",
    "signals": {
      "providers_used": 2,
      "agreement": 0.8,
      "degraded": false,
      "quorum": true,
      "provider_health": {
        "groq": "healthy",
        "anthropic": "healthy"
      }
    },
    "provider_responses": [],
    "latency_ms": 120
  }
  ```

---

## GET /api/v1/repid/:agentId

Looks up an AI agent's current reputation standings (RepID score, tier name, last update source, and time).

* **Path:** `/api/v1/repid/:agentId`
* **Method:** `GET`
* **Authentication:** None (Public)
* **Response Code:** `200 OK` or `404 Not Found` (if agent does not exist)
* **Response Shape:**
  ```json
  {
    "agent_id": "f3ef0bf8-5cdc-4fad-bce8-5144f01dc271",
    "repid_score": 9581,
    "tier": "VETERAN",
    "last_updated": "2026-05-26T19:55:50.833Z",
    "source": "cached"
  }
  ```

> [!NOTE]
> The tier system ranges from `PROBATIONARY` (0–499) → `EARNING` (500–999) → `ESTABLISHED` (1,000–4,999) → `AUTONOMOUS` (5,000–7,999) → `VETERAN` (8,000–10,000).
> A legacy route `/api/v1/repid/:agent_id` is defined, returning `{ agent_id, repid_score, tier_level, activity_30d, created_at }`, but is shadowed by the public router endpoint above.

---

## GET /api/v1/audit/verify

Walks the append-only `hal_audit_chain` tamper-evident log in ascending ID order, recomputing the SHA-256 hash of each event to verify complete audit trail integrity.

* **Path:** `/api/v1/audit/verify`
* **Method:** `GET`
* **Authentication:** None (Public)
* **Response Code:** `200 OK` or `500 Internal Server Error`
* **Response Shape (Clean Chain):**
  ```json
  {
    "valid": true,
    "total_entries": 124,
    "last_id": 124
  }
  ```
* **Response Shape (Broken Chain):**
  ```json
  {
    "valid": false,
    "total_entries": 5,
    "first_break_at_id": 6,
    "expected_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "actual_hash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  }
  ```
