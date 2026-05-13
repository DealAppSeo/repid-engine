/**
 * Scenario 02 — Aggressive Trader.
 *
 * A mock agent with `aggressive` profile EXECUTES most trades, gets mixed P&L.
 * Tests +5/+15/-3/-10/-20 scoring ladder by varying synthetic pnl.
 *
 * KNOWN LIMITATION (surfaced for Sean per RULE-8, NOT fixed by Sprint 9):
 *   trade_execution_log has a trg_sophia_trade_alert trigger that calls
 *   net.http_post() (requires the pg_net extension). This Supabase instance
 *   does not have pg_net installed, so EXECUTE-decision INSERTs fail with:
 *     "function net.http_post(...) does not exist"
 *   REFUSED-decision INSERTs (scenario-01) succeed because the trigger fires
 *   only on a subset of rows. Sean's fix: either install pg_net or recreate
 *   the trigger to use a different dispatch mechanism.
 *
 * Validates (when trigger is fixed): pnl-tier scoring branches in scoreTrade().
 * Today: gracefully reports the trigger gap without throwing.
 */

import 'dotenv/config';
import { MockAgent } from '../mock-agent';
import { repidEarning } from '../../../src/services/repid-earning';
import { db } from '../../../src/db';

(async () => {
  const agent = new MockAgent(`mock-aggressive-${Date.now()}`, 'aggressive');
  await agent.bootstrap();
  console.log(`[scenario-02] bootstrapped: ${agent.state.agent_name} repid=${agent.state.current_repid}`);

  // Manually craft trades with varying pnl_pct to exercise each scoring tier
  const pnlScenarios = [
    { pnl: 50, amount: 1000, expectedDelta: 15, label: '+5% profit' },   // > 2% profit → +15
    { pnl: 10, amount: 1000, expectedDelta: 5,  label: '+1% profit' },   // 0-2% profit → +5
    { pnl: -15, amount: 1000, expectedDelta: -3, label: '-1.5% loss' },  // small loss → -3
    { pnl: -30, amount: 1000, expectedDelta: -10, label: '-3% loss' },   // 2-5% loss → -10
    { pnl: -80, amount: 1000, expectedDelta: -20, label: '-8% loss' },   // > 5% loss → -20
  ];

  for (const s of pnlScenarios) {
    const { data, error } = await db.from('trade_execution_log').insert({
      agent_name: agent.state.agent_name, decision: 'EXECUTE', asset: 'BTC', pair: 'BTC/USD',
      action: 'BUY', amount_usd: s.amount, pnl_realized: s.pnl, execution_mode: 'paper',
      reason: `cc-sprint-9-mock: ${s.label}`,
    }).select('id').single();
    if (error || !data) {
      console.log(`  ${s.label}: INSERT FAILED — ${error?.message ?? 'no data'}`);
      continue;
    }
    const score = await repidEarning.recordOutcome((data as any).id);
    if ('skipped' in score) {
      console.log(`  ${s.label}: SKIPPED (${score.skipped})`);
    } else {
      const ok = score.delta === s.expectedDelta ? '✓' : '✗';
      console.log(`  ${s.label}: delta=${score.delta} (expected ${s.expectedDelta}) ${ok} reason=${score.reason}`);
    }
  }

  await agent.teardown();
  console.log(`[scenario-02] DONE`);
})().catch((e) => { console.error('scenario-02 crashed:', e); process.exit(1); });
