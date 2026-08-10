# Living-proof attestation minter

`mint-attestation.mjs` runs ONE full real cycle that produces a fresh, independently
verifiable on-chain ERC-8004 attestation on Base Sepolia:

> pick eligible provider → mint ephemeral buyer+provider keys (revoked after) → buyer buys
> the provider's verification service with a **real x402 USDC settlement** → contract settles →
> FeedbackLoopWorker writes the provider's RepID on-chain → **verify that tx on Base Sepolia**
> (status 0x1 + ReputationRegistry) → print the BaseScan link.

Nothing is faked: any leg that can't run exits non-zero with the reason. The proof surface is
`erc8004_reputation_writes` + the chain itself (the site/demo already reads it); this keeps it fresh.

## Run it once (validate)
On Railway (has all the env), from the repid-engine service shell:
```bash
node scripts/cron/mint-attestation.mjs
```
Exit 0 + a `basescan.org/tx/…` line = a fresh attestation was minted and verified. Cost: ~0.05–0.1
test-USDC per run from the funded buyer wallet (`BASE_SEPOLIA_PRIVATE_KEY`).

## Schedule it (the recurring loop)
**Railway cron (recommended — server-side, already holds every env var this needs):**
add a cron service on the `repid-engine` project (or a schedule on a lightweight service) with:
- **Start command:** `node scripts/cron/mint-attestation.mjs`
- **Cron schedule:** `0 12 * * *` (daily noon UTC) — daily keeps proof fresh at ~0.1 USDC/day
  (the funded wallet lasts ~1000+ runs). Hourly is fine too if you want denser proof; mind the spend.

Requires (all already set on repid-engine): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or
`SUPABASE_SECRET_KEY`), `BASE_SEPOLIA_PRIVATE_KEY` (funded), and the server flags `X402_REAL_RPC=true`
+ `X402_ENFORCEMENT_ENABLED=true`. Optional: `ENGINE_BASE_URL`, `BASE_SEPOLIA_RPC`, `MINT_BUYER_AGENT`.

The minter rotates across eligible providers (least-recently-attested first), so the on-chain proof
spreads across the roster instead of hammering one agent.
