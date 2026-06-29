# RepID Score Reconciliation Proof

This document provides instructions and theoretical background on how to verify that all active agents in the Trinity Swarm have earned their reputation scores. 

## Theoretical Background

At Epoch 1 baseline reset (2026-06-26), the core agent reputation scores were reset to a baseline of `1000`. To verify the integrity of the ledger, any validator or skeptic can sequentially replay every score event since the Epoch 1 reset (or since Genesis for agents created after the reset) and verify that the replayed score matches the current score in the database.

Crucially, the database implements a tier-gating floor trigger (`trg_repid_earned_floor`) on updates to `repid_agents.current_repid`. This trigger clamps the agent's current reputation so that it cannot fall below the lower bound of their peak earned tier:
- Peak $\ge 8000 \implies$ Floor = $8000$
- Peak $\ge 5000 \implies$ Floor = $5000$
- Peak $\ge 1000 \implies$ Floor = $1000$
- Peak $\ge 500 \implies$ Floor = $500$
- Peak $< 500 \implies$ Floor = $0$

To perform an accurate replay, the validator must replicate this database floor trigger on each event.

## Verification Instructions

### 1. Run the Replay Script

To run the verification script and perform the sequential event replay across all agents in the database, execute:

```bash
npm run repid:replay
```

Or run it directly with `ts-node`:

```bash
npx ts-node scripts/reputation/replay-score-events.ts
```

For verbose output detailing step-by-step state changes:

```bash
npx ts-node scripts/reputation/replay-score-events.ts --verbose
```

### 2. Verify specific agent

To inspect a single agent's trace:

```bash
npx ts-node scripts/reputation/replay-score-events.ts --agent trinity-sophia --verbose
```

---

## Reconciliation Audit Results

The following table summarizes the replay output from the live database:

```
=== RepID Score Replay & Reconstruction Audit ===

| Agent Name                          | Core? |  Current | Replayed |    Delta | Reconciled |
|-------------------------------------|-------|----------|----------|----------|------------|
| trinity-apm                         | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-chesed                      | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-gcm                         | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-hdm                         | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-mel                         | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-nexus                       | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-orch                        | CORE  |     1005 |     1005 |        0 | YES        |
| trinity-shofet                      | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-sophia                      | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-torch                       | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-veritas                     | CORE  |     1000 |     1000 |        0 | YES        |
| trinity-w3c                         | CORE  |     1000 |     1000 |        0 | YES        |

=== AUDIT RESULTS SUMMARY ===
- Core Agents Reconciled: 12 / 12
- VERDICT: SUCCESS! All core Trinity agents are fully reconciled (0 delta drift).
```

### Key Findings
- **0 Delta Drift**: All 12 core agents are fully reconciled. The sequential clamp trigger exactly matches the database's live behavior.
- **Floor-Drained Integrity**: Core agents who were penalized for minor hallucinations or neutral events have had their scores preserved at the `1000` floor by the database tier trigger, preventing arbitrary score decay.
