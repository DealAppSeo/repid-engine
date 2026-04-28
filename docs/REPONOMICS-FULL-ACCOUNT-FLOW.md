# Reponomics — Full-Account Flow

End-to-end walkthrough of the email + password builder lifecycle. Companion
to `REPONOMICS-MODEL.md` (the math) and the trading-bridge architecture
doc (the integration contract).

This is the **full-account** path. The companion **token-only** path
(zero-friction visitor demo) lives in `REPONOMICS-LIVE-DEMO.md`.

---

## Visitor flow

```
Sign up (email + password)
    │
    ├─► POST /api/v1/builder/full-signup
    │     └─► returns { builder_id, login_token }
    │
Mint ERC-7231 SBT
    │
    ├─► POST /api/v1/builder/mint-erc7231   (Bearer login_token)
    │     └─► returns { erc7231_token_id, tx_hash?, is_simulated }
    │
Create one or more agents
    │
    ├─► POST /api/v1/builder/create-agent
    │     body: { agent_name, agent_role? }
    │     └─► { agent_id, agent_address, initial_repid: 1000 }
    │
Link Alpaca paper trading account
    │
    ├─► POST /api/v1/builder/link-trading-account
    │     body: { provider: 'alpaca_rest', api_key, secret_key }
    │     └─► validates with broker, encrypts creds (AES-256-GCM),
    │         stores on builder row
    │
Stake (uses existing /api/v1/stake/deposit)
    │
    └─► authority := f(stake, mean R/W/C of agents, builder RepID)
                    (see stake-vault.computeAuthority — quadratic)

Agent executes a paper trade
    │
    ├─► POST /api/v1/agent/execute-paper-trade
    │     body: { agent_id, symbol, qty, side, rationale? }
    │     ├─ check notional ≤ authority * cap%
    │     ├─ getTradingBridge(provider).placeOrder(...)
    │     ├─ insert linked_bets row + paper_trade_orders row
    │     └─► { order_id, linked_bet_id, authority, cap_pct }
    │
Paper trade resolves
    │
    ├─► resolver polls Alpaca → P&L → resolveBet(outcome)
    │     ├─ apply_linked_bet_resolution RPC (atomic)
    │     ├─ wisdom + character updates
    │     └─ if outcome=true: bumpAgentCapPct() (+5%, capped at 90%)
    │
Notification fires
    │
    └─► dispatchNotificationFor(builder_id)
          channel = console (default) | webhook | telegram
```

---

## Authority cap progression

Each agent starts at **50%** of the builder's authority. Every successful
resolved trade bumps the cap by **+5%**, up to a hard ceiling of **90%**.
Caps are stored at `builders.notification_prefs.agent_trade_caps[agent_id]`.

This is the "trust ladder" for autonomous agents — they earn larger
position sizes by demonstrating they can win.

---

## What's real vs simulated

| Step                          | Real / Simulated                                      |
| ---                           | ---                                                   |
| Email + password signup       | **REAL** (bcryptjs cost 10, hand-rolled HMAC token)   |
| ERC-7231 mint                 | **SIMULATED** until BASE_ERC7231_REGISTRY env set     |
| Agent creation                | **REAL** (`repid_agents` row + builder linkage)       |
| Stake deposit                 | **SIMULATED** until X402_REAL_RPC env set             |
| Authority computation         | **REAL** (stake-vault.computeAuthority)               |
| Alpaca REST link              | **REAL** (paper-api.alpaca.markets validation)        |
| Paper trade execution         | **REAL** Alpaca paper order via REST                  |
| Trade resolution              | **REAL** Alpaca order-status polling                  |
| Notification (console)        | **REAL** (default; logs to stdout)                    |
| Notification (webhook)        | **REAL** (POSTs JSON to URL)                          |
| Notification (telegram)       | **REAL** if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set |
| Alpaca MCP link / trade       | **NOT YET** — v0.2 (501 Not Implemented today)        |

---

## Required env vars

| Var                              | Purpose                                                |
| ---                              | ---                                                    |
| `FULL_ACCOUNT_JWT_SECRET`        | HMAC secret for login_token (DEFAULT IS NOT SECRET)    |
| `TRADING_CREDS_ENCRYPTION_KEY`   | 32-byte hex or any string ≥ 32 chars (sha256 derived)  |
| `BASE_ERC7231_REGISTRY`          | optional — enables real on-chain mint                  |
| `DEPLOYER_PRIVATE_KEY`           | optional — required if BASE_ERC7231_REGISTRY is set    |
| `BASE_RPC_URL`                   | optional — defaults to https://mainnet.base.org        |
| `ALPACA_PAPER_BASE_URL`          | optional — defaults to https://paper-api.alpaca.markets/v2 |
| `ALPACA_DATA_BASE_URL`           | optional — for cap-check price quotes                  |
| `TELEGRAM_BOT_TOKEN`             | optional — for telegram notifications                  |
| `TELEGRAM_CHAT_ID`               | optional — for telegram notifications                  |

Secrets are injected via Railway env vars in production. Defaults exist
for local boot but are **not safe** for public deployment.

---

## Curl recipes

```bash
# Sign up
curl -X POST $API/api/v1/builder/full-signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"longenoughpassword"}'

# Login
curl -X POST $API/api/v1/builder/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"longenoughpassword"}'

# Mint (use login_token from previous step)
curl -X POST $API/api/v1/builder/mint-erc7231 \
  -H "Authorization: Bearer $TOKEN"

# Create agent
curl -X POST $API/api/v1/builder/create-agent \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"SwingTrader-1","agent_role":"momentum-equity"}'

# Link Alpaca paper account
curl -X POST $API/api/v1/builder/link-trading-account \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"alpaca_rest","api_key":"AK...","secret_key":"SK..."}'

# Execute trade
curl -X POST $API/api/v1/agent/execute-paper-trade \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"<UUID>","symbol":"AAPL","qty":1,"side":"buy","rationale":"breakout"}'

# Resolve open trades manually (also runs on schedule when wired)
curl -X POST $API/api/v1/builder/resolve-paper-trades \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"force":true}'

# Dashboard
curl $API/api/v1/builder/dashboard/$BUILDER_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

## Out of scope (v0.2)

- Real KYC (this flow is email + password only — demo-grade)
- Custodial wallet integration (Coinbase Smart Wallet, etc.)
- Multi-broker support (only Alpaca paper today)
- Mainnet trading (paper only)
- MCP-backed Alpaca path (stub today, real in v0.2)
