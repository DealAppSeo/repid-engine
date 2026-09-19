# T12 inventory — public lookups only

Measured 2026-09-19 against `GET /api/v1/passport/:slug` and `GET /api/v1/services`
on `repid-engine-production.up.railway.app`. No remint. No key creation.
`GET /api/v1/agent-keys` is public but only returns `{enabled, scopes, how}` —
no per-agent key. Missing keys are **ABSENT**. We did not create them.

| agent | row exists | ERC-8004 mint | API key present | served proof age (days) | marketplace listing |
|---|---|---|---|---|---|
| trinity-orch | YES | MINTED | ABSENT | 8.8 FAILED | 3 |
| trinity-w3c | YES | MINTED | ABSENT | 2.2 MEASURED | 3 |
| trinity-torch | YES | MINTED | ABSENT | 10.8 FAILED | 2 |
| trinity-gcm | YES | MINTED | ABSENT | 9.8 FAILED | 3 |
| trinity-chesed | YES | MINTED | ABSENT | 12.8 FAILED | 2 |
| trinity-mel | YES | MINTED | ABSENT | 11.8 FAILED | 3 |
| trinity-apm | YES | UNVERIFIED | ABSENT | 13.8 FAILED | 3 |
| trinity-sophia | YES | UNVERIFIED | ABSENT | 6.2 MEASURED | 2 |
| trinity-nexus | YES | MINTED | ABSENT | 0.8 MEASURED | 2 |
| trinity-hdm | YES | MINTED | ABSENT | 16.8 FAILED | 3 |
| trinity-shofet | YES | MINTED | ABSENT | 5.0 MEASURED | 5 |
| trinity-veritas | YES | MINTED | ABSENT | 0.8 MEASURED | 5 |

Seven agents have served-proof `ageDays > 7`. Remint is Sean (signer / on-chain). **BLOCKED-SEAN** for those seven; the other five are MEASURED on freshness. API keys: all twelve ABSENT on the public surface (not BLOCKED-SEAN for mint — just not presented).
