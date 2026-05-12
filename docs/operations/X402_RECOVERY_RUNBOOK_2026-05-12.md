# X402 Recovery & Wakeup Runbook
Date: 2026-05-12

## PROTOCOL: FIRST REAL MICRO-TRANSACTION
1. Ensure wallets are funded (Base Sepolia ETH + USDC).
2. Deploy latest code to Railway.
3. Run `npm run x402:preflight-real-microtx` and require full GREEN.
4. Export `MOCK_FACILITATOR=false` (in prod terminal).
5. Run `npx tsx scripts/x402/execute-first-real-microtx.ts`.
6. Run `npx tsx scripts/x402/capture-patent-evidence.ts`.
7. Verify `docs/patent/X402_EVIDENCE_PAYLOAD.md` looks correct.
