# True E2E: bind → stake → agent-to-agent transaction → RepID moves

**Test:** `tests/e2e/bind-stake-a2a-repid.test.ts` (runs in the default `npm test`; no live DB, no live chain).

This is the end-to-end proof Sean asked for: the whole trust chain in one deterministic test,
where the **last link is the one that matters** — an agent-to-agent transaction actually moves a
bound, staked agent's RepID score, by a known amount, for a verifiable reason.

## The chain it drives

```
human binds an agent        bindOwnerToAgent()            -> human_agent_bindings row
  → that human's builder stakes   depositStake() (simulated)   -> stake_deposits row (is_simulated)
    → the agent does an a2a service transaction   applyServiceSatisfiedDeltas(contract, 0.8)
      → and THAT transaction moves the agent's RepID   -> repid_score_events + repid_agents.current_repid
```

All four legs run against **one shared in-memory store**, so the agent whose score moves is provably
the same one the human bound and staked behind — not merely some agent that happened to transact.

## What it asserts (deterministic under default env)

- **Bind:** `bindOwnerToAgent` returns `ok`, and a `human_agent_bindings` row ties `provider-1`
  to `builder-1` (`owner_kind: builder`). (`trustedCaller: true` skips the wallet+key proofs — the
  documented test/operator path; the bind itself is still exercised.)
- **Stake:** `depositStake` returns `ok, is_simulated: true`, writing a `stake_deposits` row whose
  `deposit_tx_hash` begins `simulated:deposit:` (the flag-off path — no chain).
- **Separation:** after bind + stake, **no** RepID has moved (stake and RepID are separate ledgers).
- **Headline:** `applyServiceSatisfiedDeltas(contract-1, 0.8)` writes two `SERVICE_SATISFIED`
  events — **provider +24** (`round(30 × 0.8)`), **buyer +12** (`round(15 × 0.8)`) — and
  `repid_agents.current_repid` becomes **1024** (provider) and **1012** (buyer) from 1000.
- **Sim gate:** a second test flips the contract to `is_simulated` and proves the a2a event is still
  **recorded** (honest audit trail) but with **delta 0** and **no score moved**.

## Why this path (a correction worth keeping)

The a2a value-transfer that moves RepID **synchronously** is the **service-contract cascade**
(`applyServiceSatisfiedDeltas` → `applyValidationEvent`, `src/scoring/pipeline.ts`). It is **not**:

- the **x402 tip flow** (`deliverTip`) — that writes `repid_events` (a different table) as an async
  queue for an off-repo on-chain worker; it does not touch `current_repid` synchronously; and
- the **FIXED_DELTAS `updateRepId` engine** — no a2a transaction path calls it, and its positive
  self-report deltas are gated to 0 by default.

So "an a2a transaction moved a score" means a settled service contract, which is what this test drives.

## Real vs. mocked

- **Real (exercised):** the actual `bindOwnerToAgent`, `depositStake`, `applyServiceSatisfiedDeltas`,
  `applyValidationEvent`, the simulation gate, and the clamp/decay math — the real code under test.
- **Mocked:** only the Supabase client (`src/db`) via a compact in-memory store, and the chain
  (kept offline by the repo's existing jest `setupFiles`). The fire-and-forget proof-queue `fetch`
  is blocked by `tests/helpers/offline-prover.ts` and swallowed, exactly as in production tests.

## What it does NOT claim

It does not prove the **live** production DB or a **real** Base Sepolia transaction behaves this way —
that is a separate check against production (and real staking needs `STAKE_ESCROW_*` set; see
`docs/MULTI-TOKEN-ADVISORY.md` and the escrow-health endpoint). This proves the **engine logic** that
ties the four legs together is correct and connected, deterministically, in CI.
