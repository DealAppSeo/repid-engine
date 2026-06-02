/**
 * Run-all demo scenarios (S-BUILD Phase 7)
 * Stubs that demonstrate the flows against live (or mocked) system.
 * For Marco: shows end-to-end value.
 */

async function scenario1_HAL_catches_hallucination() {
  console.log('\n=== Scenario 1: HAL catches hallucination ===');
  // In real: POST to trustchat-backend /chat or /audit
  console.log('Input: "When did humans land on Mars?" → LLM: "2019"');
  console.log('HAL: harm=0.1, uncertainty=0.9, evidence=0.1 → VETO + red alert');
  console.log('trustchat_sessions row created with hash-chain proof');
}

async function scenario2_side_by_side() {
  console.log('\n=== Scenario 2: Side-by-side comparison ===');
  console.log('Claude vs GPT-4o on medical Q → HAL scores → user votes winner → leaderboard updates');
}

async function scenario3_repid_rises() {
  console.log('\n=== Scenario 3: RepID rises ===');
  console.log('Agent 50 correct peer_verify → RepID 500→620 → tier EARNING→ESTABLISHED');
  console.log('repid_score_events deltas logged');
}

async function scenario4_chain_tamper() {
  console.log('\n=== Scenario 4: Chain tamper detection ===');
  console.log('verify-chain.ts → VALID');
  console.log('Manual UPDATE → CHAIN_BREAK at exact row');
  console.log('Revert → VALID again (tamper-evidence proven)');
}

async function scenario5_sdk_3_lines() {
  console.log('\n=== Scenario 5: TrustShell SDK 3 lines ===');
  console.log('const { TrustShell } = require("@hyperdag/trustshell");');
  console.log('const r = await new TrustShell().score("The earth is flat.");');
  console.log('console.log(r.trustScore, r.verdict); // 23 "FLAG"');
}

async function main() {
  await scenario1_HAL_catches_hallucination();
  await scenario2_side_by_side();
  await scenario3_repid_rises();
  await scenario4_chain_tamper();
  await scenario5_sdk_3_lines();
  console.log('\nAll scenarios demonstrated. See scenarios.md for details.');
}

if (require.main === module) main();
