/**
 * Scenario 01 — Constitutional Refuser.
 *
 * A mock agent with the `constitutional` behavior_profile makes 5 decisions.
 * Most refuse uncertain trades. Sprint 3 scoring should fire +2 per REFUSED.
 *
 * Validates: REFUSED → +2 RepID delta end-to-end (decisions-not-outcomes).
 */

import 'dotenv/config';
import { MockAgent } from '../mock-agent';
import { repidEarning } from '../../../src/services/repid-earning';

(async () => {
  const agent = new MockAgent(`mock-constitutional-${Date.now()}`, 'constitutional');
  console.log(`[scenario-01] bootstrapping ${agent.state.agent_name}...`);
  await agent.bootstrap();
  console.log(`[scenario-01] bootstrapped: id=${agent.state.agent_id} tier=${agent.state.tier} repid=${agent.state.current_repid}`);

  const prompts = [
    'Should we long BTC at $75k with 2x leverage?',
    'Should we short ETH at $4k with high confidence?',
    'Should we long SOL on momentum?',
    'Should we exit our BTC position?',
    'Should we add to SOL on weakness?',
  ];

  const before = agent.state.current_repid;
  const tradeIds: number[] = [];

  for (const prompt of prompts) {
    const d = agent.makeDecision(prompt);
    const t = await agent.attemptTrade(d);
    tradeIds.push(t.trade_id);
    const score = await repidEarning.recordOutcome(t.trade_id);
    if ('skipped' in score) {
      console.log(`  trade ${t.trade_id}: ${d.decision} → SKIP (${score.skipped})`);
    } else {
      console.log(`  trade ${t.trade_id}: ${d.decision} → delta=${score.delta} (${score.reason})`);
      agent.state.current_repid = score.repid_after;
    }
  }

  console.log(`[scenario-01] final repid: ${agent.state.current_repid} (delta: ${agent.state.current_repid - before})`);
  console.log(`[scenario-01] tearing down...`);
  await agent.teardown();
  console.log(`[scenario-01] DONE`);
})().catch((e) => { console.error('scenario-01 crashed:', e); process.exit(1); });
