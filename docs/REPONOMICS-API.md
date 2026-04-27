# Reponomics API reference (v0.1)

All endpoints are public (no API key) per Phase 8 of the reponomics
sprint. Auth bypass is in `src/middleware/auth.ts`.

Endpoints that change state on Sean's behalf
(`POST /trader/round/{start,resolve-open}` and
`GET /trader/oracle-sign/...`) require the `X-SEAN-SIGNATURE` header
— HMAC-SHA256 of the literal string `"start-trading-round"` keyed
with `SEAN_SIG_SECRET`.

---

## Builder

### `GET /api/v1/builder/:address`

Returns the builder profile + owned-agent roster + stake summary +
current authority.

```bash
curl -s "$ENGINE/api/v1/builder/0x4d4953530000…0002" | jq
```

Response:

```jsonc
{
  "id": "00000000-0000-0000-0000-000000000002",
  "address": "0x4d4953530000…",
  "display_name": "Builder M (mission builder)",
  "current_repid": 7000,
  "ghost_cohort_count": 0,
  "owned_agents": [{
    "id": "065ad…",
    "name": "APM",
    "current_repid": 7000,
    "wisdom_score": 1500,
    "character_score": 1700,
    "is_ghost": false
  }],
  "stake_summary": {
    "total_active": "50000000",
    "deposit_count": 1,
    "is_simulated": true
  },
  "current_authority": "12622",
  "authority_basis": { /* ... */ }
}
```

### `POST /api/v1/builder/register`

```jsonc
// body
{ "address": "0x...", "erc7231_token_id": "optional" }
// response
{ "ok": true, "builder_id": "uuid", "is_new": true }
```

## Stake

### `POST /api/v1/stake/deposit`

```jsonc
// body
{ "builder_address": "0x...", "amount": "1000000000", "tx_hash": "optional" }
// response
{ "ok": true, "builder_id": "uuid", "total_active_stake": "1000000000",
  "authority_after": "9392", "is_simulated": true }
```

### `POST /api/v1/stake/withdraw`

Blocks if any agent under this builder has open bets.

```jsonc
{ "builder_id": "uuid", "amount": "100000000" }
```

### `GET /api/v1/stake/authority/:builder_id`

```jsonc
{ "builder_id": "...", "stake_total": "...", "authority": "...",
  "basis": { /* ... */ } }
```

## x402 tip flow

### `POST /api/v1/tip/request`

Initiates an HTTP 402 challenge. Per Coinbase x402 spec.

```jsonc
// body
{ "requestor_agent_id": "uuid", "provider_agent_id": "uuid", "prediction_topic": "NBA Finals" }
// response — HTTP 402
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "asset": "0x036C…",
    "amount": "1100000",
    "payTo": "0x...",
    "resource": "/api/v1/tip/deliver/tip_xyz",
    "description": "Prediction tip on: NBA Finals"
  }],
  "error": "Payment required",
  "is_simulated": true,
  "tip_id": "tip_xyz"
}
```

### `POST /api/v1/tip/deliver/:tipId`

Requires `X-PAYMENT` header. v0.1 simulates verification when
`X402_REAL_RPC` is unset.

```jsonc
{ "ok": true, "tip_id": "tip_xyz", "content": "...",
  "is_simulated": true, "audit_chain_id": 12 }
```

## Bet placement / resolution

### `POST /api/v1/bet/place`

```jsonc
// body
{
  "agent_id": "uuid",
  "bet_amount": "1000000",
  "claimed_confidence": 6500,
  "prediction_payload": { "game": {...}, "predicted_outcome": true },
  "oracle_endpoint": "sports/nba-mock-...",
  "expected_resolution_time": "2026-04-27T18:00:00Z"
}
// response
{
  "betId": "bet_xyz",
  "plonky3ProofBytes": "0x...",
  "is_simulated": true,
  "authority_used": "12622"
}
```

### `POST /api/v1/bet/resolve`

```jsonc
{ "bet_id": "bet_xyz", "oracle_outcome": true, "oracle_signature": "..." }
```

Use `GET /api/v1/trader/oracle-sign/:bet_id/:outcome` (Sean-signature
gated) to obtain a valid signature for a (bet, outcome) pair.

## Trader (APM/VERITAS)

### `POST /api/v1/trader/round/start` — Sean-signature gated

```bash
SEAN_SIG=$(echo -n 'start-trading-round' | openssl dgst -sha256 -hmac "$SEAN_SIG_SECRET" | awk '{print $2}')
curl -X POST -H "X-SEAN-SIGNATURE: $SEAN_SIG" "$ENGINE/api/v1/trader/round/start"
```

Returns the new round's id, both bet ids, and the mock game info.

### `POST /api/v1/trader/round/resolve-open`

Resolves any open rounds whose `expected_resolution` window has
elapsed. Pass `{"force": true}` to ignore the window.

### `GET /api/v1/trader/state`

APM + VERITAS current state, open rounds, recent resolved.

## Two-builder demo

### `GET /api/v1/demo/two-builder/snapshot`

Side-by-side W vs M. Returns `crossover.builder_m_authority_exceeds_w`
boolean.

### `GET /api/v1/demo/two-builder/timeseries?limit=N`

Returns a paired `[w_authority, m_authority]` series across time
based on `stake_authority_snapshots`.

### `POST /api/v1/demo/two-builder/bootstrap`

Forces an immediate snapshot for both builders so the chart has data.

---

## Error codes

| Status | Meaning |
|---:|---|
| 400 | Bad request (missing fields, invalid amounts, etc.) |
| 401 | Sean-signature required |
| 402 | Payment required (x402) |
| 404 | Builder/agent/event not found |
| 500 | Internal — the response body's `error` field has details |

## Audit chain

Every endpoint that mutates state emits a row to `hal_audit_chain`
via `appendToAuditChain`. Public read endpoints at
`/api/v1/audit-chain/*` (added in the e2e demo sprint) expose the
chain.

`event_type` values used by reponomics:

- `stake_deposit`
- `builder_repid_recompute`
- `wisdom_update`
- `character_update`
- `bet_placed`
- `bet_resolved`
- `round_started`
- `x402_tip_requested`
- `x402_tip_delivered`
