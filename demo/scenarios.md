# End-to-End Demo Scenarios (S-BUILD Phase 7)

For Marco review — proof the full stack works.

## Scenario 1: HAL catches a hallucination (TrustChat)
- User: "When did humans land on Mars?"
- LLM (confident): "2019"
- HAL: harm=0.1, uncertainty=0.9, evidence=0.1 → VETO
- UI: Red alert + "HAL flagged this as unreliable"
- Evidence: trustchat_sessions row with hal_flagged_hallucination=true + hash

## Scenario 2: Two AIs compared side-by-side
- User compares Claude vs GPT-4o on medical question
- HAL scores both
- Higher score wins user vote
- Leaderboard updates (via /api/v1/llm-trust)

## Scenario 3: Agent RepID rises from good work
- Agent completes 50 correct peer_verify tasks
- RepID 500 → 620
- Tier: EARNING → ESTABLISHED
- Logged in repid_score_events with deltas

## Scenario 4: Hash-chain detects tampering
- verify-chain.ts → VALID
- Manually UPDATE a row
- verify-chain.ts → CHAIN_BREAK at exact id
- Revert → back to VALID
- Proves tamper-evidence (S-AUD1)

## Scenario 5: TrustShell SDK in 3 lines
```ts
const { TrustShell } = require('@hyperdag/trustshell');
const shell = new TrustShell();
const r = await shell.score("The earth is flat.");
console.log(r.trustScore, r.verdict); // 23 "FLAG"
```

Run: npx ts-node demo/run-all-scenarios.ts
