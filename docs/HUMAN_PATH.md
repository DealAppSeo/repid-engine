# Human path — documented, and shadowed

## Measured against the deployed process, 2026-09-24

Keyless reads of `repid-engine-production`, deployed commit `553d1cd` (this route is not in that commit). Times are the `checked_at` / `last_updated` fields those responses carried, around 23:08Z.

| Call | Result |
|------|--------|
| `GET /readiness` | `SELF_SERVE_ACCOUNTS_ENABLED` **on**, `HUMAN_AGENT_BIND_ENABLED` **on**. `misconfigured` empty. |
| `GET /api/v1/security/status` → `account_creation` | Password **RETIRED**. Email-OTP **OPEN** (provisioning, delivery, and token signing all configured). |
| `GET /api/v1/faucet/info` | `dispenses: false`, `chain_id` 84532, network name Base Sepolia. Three public faucet URLs. |
| `GET /api/v1/faucet/balance` with no address | **400**, missing address. No RPC. |
| `POST /api/v1/account/connect` `{}` | **401** `signature_required`. The flag-off response is 503, and that was not what came back. The handler checks the flag, then the signature, and inserts only after both. |
| `POST /api/v1/human/bind` `{}` | **401** `signature_required`. That check runs before the bind flag is consulted, so this 401 does not measure the flag. `/readiness` does. |
| `POST /api/v1/stake/deposit` `{}` | **400** `builder_address and amount required`, before any credit. |
| `GET /api/v1/human/path` | **401** `Unauthorized: API key required`. That string is the auth middleware for a path it does not recognise. This commit does not mount the shadow. |
| `POST /api/v1/builder/token-signup`, `POST /agents/human` | **Not called.** Both insert a row. |

`REAL_STAKING_ENABLED` and `OWNER_CEILING_SHADOW_ENABLED` are not on the public readiness allowlist. Their production values are **NOT_CHECKED** from this pass.

The "defaults off" lines below are the code default when the variable is unset. They are not the production reading. Production has the two published flags on.

The walk a person takes:

**sign up → connect wallet → get Base Sepolia testnet tokens → stake → bind agents → blast-radius cap.**

`GET /api/v1/human/path` records that sequence and performs none of it. Every step comes back `mode: "shadow"`, `applied: false`, `persisted: false`. The module is `src/services/human-path-shadow.ts`. Its import graph cannot reach the database client; `tests/human-path-shadow.test.ts` fails if that changes.

This is not `POST /agents/human`. That route inserts a `repid_agents` row named `HUMAN` and writes the returned `privateId` into `constitution`. It is not a zero-knowledge registration. The shadow does not call it.

| # | Step | Live handler | What the live handler does | What the shadow does |
|---|------|--------------|----------------------------|----------------------|
| 1 | Sign up | `POST /api/v1/builder/token-signup`, and email-OTP at `POST /api/v1/agent-gate/request-otp` | Token-signup inserts a `token_only` builder. OTP creates a full account only when provisioning, email delivery, and token signing are all configured. Password signup returns 410. | Includes `signupPosture()` (already public at `GET /security/status`). Inserts nothing and sends no code. |
| 2 | Connect wallet | `POST /api/v1/account/connect` | Requires `x-hd-wallet`, `x-hd-timestamp`, and `x-hd-signature`. `SELF_SERVE_ACCOUNTS_ENABLED` defaults off (503). When on, inserts `auth_method: wallet` and grants no RepID. | Publishes that flag as `on` / `off` / `ignored_value` (`TRUE` and `1` are `ignored_value`). Verifies no signature and inserts no account. |
| 3 | Testnet tokens | `GET /api/v1/faucet/info`, `GET /api/v1/faucet/balance` | Read-only. `dispenses: false`. Names the public Base Sepolia faucets. The chain id is whatever `getActiveNetwork()` reports. | Repeats `dispenses: false`. Does not dial an RPC. |
| 4 | Stake | `POST /api/v1/stake/deposit` | Credits a builder's stake. A claimed on-chain USDC transfer counts as real only when `REAL_STAKING_ENABLED` is on and `deposit-verifier` accepts the transfer. | Does not credit stake and does not publish that flag. The flag is not on the public readiness allowlist. |
| 5 | Bind agents | `POST /api/v1/human/bind` | Signature over the bind message. `HUMAN_AGENT_BIND_ENABLED` defaults off. One live owner per agent per scope. | Publishes that flag the same way as connect. Inserts no binding. |
| 6 | Blast-radius cap | observed beside the x402 decision; the decision does not read it | `attenuateCeiling` is the minimum of the agent tier ceiling and the owner cap. It cannot widen. `OWNER_CEILING_SHADOW_ENABLED` only records what the decision would have been. | Computes the number when the query supplies both `agent_ceiling` and `owner_cap` (`none` means a lookup found no owner limit). Omitting either is `NOT_CHECKED` with `ceiling_usdc: null` — a missing cap is not zero. Applies nothing. Does not publish the observer flag. |

A later step does not mean an earlier step ran. The shadow is a map of the walk, not a session.

Query the cap without writing:

```
GET /api/v1/human/path?agent_ceiling=100&owner_cap=25
```

`ceiling_usdc` is 25 and `bound_by` is `owner_limit`. The live authorisation is unchanged.
