/**
 * Scenario 03 — Hallucinator (HAL signal test).
 *
 * A mock agent makes overconfident, factually-wrong claims. This scenario
 * does NOT invoke the production HAL classifier (which requires LLM provider
 * keys + the trinity-* runtime that's currently dead). Instead it stages a
 * fake hallucinated answer and writes a synthetic `hal_runner_results` row
 * to demonstrate the data path the real HAL pipeline will exercise.
 *
 * This scenario is a STAGED proxy. The actual classifier integration is
 * triggered by Phase 4 (`exercise-anfis.ts` / `exercise-graph-rag.ts`) or
 * by waking the swarm and letting the real HAL hook run.
 *
 * Validates: hal_runner_results write path works + ground_truth_is_hallucination
 * + was_caught + false_positive booleans round-trip.
 */

import 'dotenv/config';
import { MockAgent } from '../mock-agent';
import { getDb } from '../../liveness-probes/_shared';

(async () => {
  const agent = new MockAgent(`mock-hallucinator-${Date.now()}`, 'aggressive');
  await agent.bootstrap();
  console.log(`[scenario-03] bootstrapped ${agent.state.agent_name}`);

  const db = getDb();

  // Stage a hallucinated answer
  const synthetic = {
    run_id: `cc-sprint-9-scenario-03-${Date.now()}`,
    prompt_id: 'mock-hallucination-prompt-001',
    benchmark_source: 'cc-sprint-9-mock-scenario',
    gen_provider: 'mock',
    gen_model: 'mock-overconfident-v1',
    gen_latency_ms: 100,
    generated_answer: 'The Pythagorean Comma is exactly 1.0136500 (fabricated)', // wrong on purpose
    hal_mode: 'real',
    hal_threshold: 0.25,
    hal_score: 0.6, // above threshold → HAL should veto
    hal_vetoed: true,
    ground_truth_is_hallucination: true,  // it IS a hallucination
    was_caught: true,                     // HAL caught it (vetoed AND hallucination)
    false_positive: false,
    gen_failed: false,
    estimated_cost_usd: 0,
  };

  const { data, error } = await db.from('hal_runner_results').insert(synthetic).select('id').single();
  if (error) {
    console.error(`  insert failed: ${error.message}`);
  } else {
    console.log(`  staged hal_runner_results.id=${(data as any).id}`);
    console.log(`  hal_vetoed=${synthetic.hal_vetoed} ground_truth=${synthetic.ground_truth_is_hallucination} was_caught=${synthetic.was_caught} (true_positive)`);
    // Cleanup
    await db.from('hal_runner_results').delete().eq('id', (data as any).id);
    console.log(`  cleaned up staged row`);
  }

  await agent.teardown();
  console.log(`[scenario-03] DONE`);
  console.log(`[scenario-03] NOTE: real HAL classifier invocation requires the swarm to be alive`);
  console.log(`[scenario-03]       OR for trinity-* providers to be configured in this env.`);
  console.log(`[scenario-03]       Phase 4's exercise-* scripts cover that path.`);
})().catch((e) => { console.error('scenario-03 crashed:', e); process.exit(1); });
