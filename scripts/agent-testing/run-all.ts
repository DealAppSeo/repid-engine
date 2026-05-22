/**
 * Agent testing framework — CLI entry point.
 *   npx tsx scripts/agent-testing/run-all.ts            # run all scenarios
 *   npx tsx scripts/agent-testing/run-all.ts --strict   # exit 1 if any non-skipped scenario fails
 *
 * Env: REPID_API_URL (default deployed), REPID_API_KEY (auth scenarios),
 *      TEST_AGENT_ID / TEST_PROVIDER_AGENT_ID / TEST_REQUESTOR_AGENT_ID,
 *      one free-LLM key (CEREBRAS_API_KEY / GROQ_API_KEY / TOGETHER_API_KEY / HF_API_KEY).
 * Scenarios skip (not fail) when their preconditions are absent.
 */
import { makeContext, runScenario, Scenario } from './framework';
import { selectProvider } from './free-llm-router';
import { x402PaymentLoop } from './scenarios/x402-payment-loop';
import { halFilter } from './scenarios/hal-filter';
import { disputeResolution } from './scenarios/dispute-resolution';
import { tierPromotion } from './scenarios/tier-promotion';

const scenarios: Scenario[] = [x402PaymentLoop, halFilter, disputeResolution, tierPromotion];

async function main(): Promise<void> {
  const ctx = makeContext();
  const sel = selectProvider();
  console.log(`\n[agent-testing] engine : ${ctx.engineUrl}`);
  console.log(`[agent-testing] freeLLM: ${sel ? sel.provider.name : 'NONE — set CEREBRAS_API_KEY / GROQ_API_KEY / TOGETHER_API_KEY / HF_API_KEY'}`);
  console.log(`[agent-testing] apiKey : ${ctx.apiKey ? 'set' : 'absent (auth scenarios will skip)'}\n`);

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`> ${s.name} ... `);
    const r = await runScenario(s, ctx);
    results.push(r);
    const tag = r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    console.log(`${tag} (${r.durationMs}ms)${r.reason ? ' - ' + r.reason : ''}${r.error ? ' - ERROR: ' + r.error : ''}`);
  }

  const pass = results.filter((r) => r.pass && !r.skip).length;
  const fail = results.filter((r) => !r.pass && !r.skip).length;
  const skip = results.filter((r) => r.skip).length;
  console.log(`\n[agent-testing] summary: ${pass} pass / ${fail} fail / ${skip} skip (of ${results.length})`);

  // Skips (missing keys/preconditions) are never fatal; only real failures are, and only under --strict.
  const strict = process.argv.includes('--strict');
  process.exit(strict && fail > 0 ? 1 : 0);
}

main().catch((e: any) => {
  console.error('[agent-testing] FATAL:', e?.message ?? String(e));
  process.exit(1);
});
