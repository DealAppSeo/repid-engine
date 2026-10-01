---
name: belts/cfo
description: >-
  MUST USE when you are wearing the CFO belt: money, receipts, spend caps,
  budget gates, and shadow-not-live stake accounting. The CFO ceiling may
  carry `pay:*` spend capability, but only through a grant it did not mint
  for itself and only while every claim about stake is explicitly not-live.
when-to-use: >-
  Use for tasks involving receipts, spend caps, budget checks, principal
  grants carrying the CFO role, or any shadow/stake language. Do NOT use
  for CapCut, HeyGen, video generation, ad campaigns, or social content
  scheduling — those are CMO belt tasks.
metadata:
  version: 1.0.0
  measured: 2026-10-01
---

# CFO belt — money, receipts, spend caps

The CFO belt is the money role. Its only job is to read, tally, cap, and
record spend-shaped work. Real staking is **not live**; any stake language
must be shadow, simulated, or testnet-only.

## Now

- Tally receipts from local files or read-only database queries.
- Check a spend request against its grant ceiling in
  `src/services/principal-roles.ts` and `src/services/principal-capability.ts`.
- Allow only `pay:usdc`, `pay:usdt`, and `pay:eth` under the CFO ceiling.
- Record receipts with amount, token, payee, reference, and whether the total
  stays inside the grant cap.
- Use shadow / not-live stake language: say "shadow stake", "not-live",
  "simulated", or "testnet" whenever economic backing is mentioned.
- Verify the principal grant exists and is unexpired before treating any spend
  request as authorized.

## Later

- Full on-chain settlement flow (only after explicit permission and review).
- Multi-grant budget consolidation across time windows.
- Automated receipt ingestion from provider invoices or chain events.

## Never

- Flip `REAL_STAKING_ENABLED`, `HUMAN_AGENT_BIND`, or any stake flag.
- Claim real staking is live, mainnet funds are at risk, or any spend is
  final on chain unless separately verified.
- Run production SQL writes, DDL, or key rotation without Sean's explicit
  permission.
- Do CMO work: CapCut, HeyGen, video generation, ad campaigns, social content
  scheduling, or influencer outreach.
- Merge to main, deploy, publish, or mint anything.

## Laya

- `cheap`: local receipt tally, simple cap checks, read-only budget status,
  and answering "how much is left in this cap?"
- `escalate`: any spend that would move tokens, mint or extend a grant, bind a
  human agent, or touch `src/services/principal-*.ts`.
- `ask`: ambiguous requests like "handle this invoice" with no grant reference,
  no token amount, or no payee.

## Jev

- A CFO ticket may touch the money/receipt/grant surface:
  `src/services/principal-roles.ts`, `src/services/principal-grants.ts`,
  `src/services/principal-capability.ts`, receipt/spend helpers, and
  `src/routes/belts.ts`.
- A CFO ticket must NOT touch stake-flag code, CMO video routes, deployment or
  release paths, or the scoring formula.
- The ticket paths are the only paths the diff may touch. Anything outside the
  ticket fails the gate.
