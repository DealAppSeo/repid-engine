# Plonky3 prover observability

The Plonky3 STARK prover runs as a separate Rust + Axum service
(`hyperdag-core/services/zkp-postcard`). The repid-engine talks to it
over HTTP via the bridge in `src/zkp/plonky3-real.ts`. This doc
covers the observability surface of both halves.

## Endpoints (Axum service)

Both endpoints are unauthenticated read-only and live on the same
port as the proof endpoints (`PLONKY3_PROVER_URL` / `:$PORT`,
default 8080).

### `GET /health`

JSON for liveness checks and the bridge's pre-flight cache.

```json
{
  "status": "ok",
  "uptime_seconds": 12847,
  "proofs_generated_total": 318,
  "proofs_failed_total": 4,
  "version": "0.1.0"
}
```

### `GET /metrics`

Prometheus exposition format — same numbers, scrapable directly:

```
# HELP plonky3_proofs_generated_total Successful proofs generated
# TYPE plonky3_proofs_generated_total counter
plonky3_proofs_generated_total 318
# HELP plonky3_proofs_failed_total Failed proof attempts
# TYPE plonky3_proofs_failed_total counter
plonky3_proofs_failed_total 4
# HELP plonky3_uptime_seconds Service uptime
# TYPE plonky3_uptime_seconds gauge
plonky3_uptime_seconds 12847
```

## Scraping from Railway / Prometheus

Add a scrape job pointing at the prover's `/metrics`:

```yaml
scrape_configs:
  - job_name: plonky3-prover
    scrape_interval: 30s
    metrics_path: /metrics
    static_configs:
      - targets: ['<prover-host>:8080']
```

Railway: the prover service can publish a public domain (open) or
stay on the internal Railway network (preferred — only repid-engine
+ Prometheus need to reach it). Either way, the scrape is HTTP GET
of `/metrics`; no auth required because the data leaks no secrets.

## Bridge: 60-second health cache (`checkProverHealth`)

Every call to `generateProofReal()` now starts with a pre-flight
`GET /health` to decide whether to attempt the real prover or go
straight to the HMAC fallback. Without a cache, this would add a
TCP+HTTP round-trip per proof call.

The cache:

- TTL: **60 seconds**.
- One in-process entry: `{ healthy: boolean, checkedAt: timestamp }`.
- Result is cached in **both directions** — a "down" verdict caches
  for 60s the same way an "up" verdict does. This is the whole
  point: when the prover is sick, every proof call would otherwise
  burn the full 5s prove-attempt timeout. Caching "down" lets the
  bridge fall back to HMAC immediately for a minute, then re-check.
- Test escape hatch: `_resetProverHealthCacheForTest()` is exported
  for unit tests so each case starts clean.

## Counter semantics — what counts as "failed"

`proofs_failed_total` increments on internal handler errors only:

- Unknown `agent_id` (no canonical RepID in the in-process map →
  HTTP 404).
- Plonky3 STARK prover returns `Err(...)` (the handler still serves
  a SHA-256 commitment fallback so the request succeeds; the failure
  metric records that the real STARK path didn't work).

`/health` and `/metrics` calls are **not** counted — they're
read-only and free.

`proofs_generated_total` increments once per successful response
from `generate_proof`, regardless of whether the proof was
`plonky3_range_check` or the SHA-256 commitment fallback. If you
need the breakdown, parse `proof_type` from individual responses —
adding a per-proof-type counter is a v0.2 followup.

## Trade-off in the cache TTL

If the prover starts up partway through a 60s window during which
the bridge has cached a "down" verdict, the bridge keeps using HMAC
fallback for up to 60 more seconds. Acceptable: the alternative is
to issue real prove calls into a known-down prover and pay the 5s
timeout each time. Auto-recovery happens at the next cache miss.

## Versioning

`SERVICE_VERSION` is a `const` in `services/zkp-postcard/src/main.rs`.
The bridge's `proof_source` field is unrelated to that version — it
flows from this code's branching, not from anything the Axum service
returns.

## Files

- `src/zkp/plonky3-real.ts` — bridge, `checkProverHealth()`,
  `generateProofReal()`.
- `tests/zkp-prover-health.test.ts` — 8 tests covering
  200-ok / 500 / 404-shape / timeout / network-error / cache-hit /
  cache-expiry / cached-down-doesn't-hammer.
- `hyperdag-core/services/zkp-postcard/src/main.rs` — Axum service.
- `hyperdag-core/services/zkp-postcard/docs/OBSERVABILITY.md` —
  the Rust-side equivalent of this doc.
