/**
 * OUTPUT_PATH: scripts/anfis-replay-phase0.ts
 *
 * Phase 0 runner for the ANFIS decisioning replay harness.
 * READ-ONLY over `llm_call_log`. Emits the per-call CSV to the sprint folder and prints a summary.
 * Also measures the LOCAL ANFIS advisory-consult hook overhead in BOTH states, and ASSERTS OFF-state
 * inertness (hard-fails if the hook fires when it must not). NOTE: the hook does NOT call LiteLLM in Phase 0 —
 * the measured overhead is the local ANFIS advisory forward pass, not a LiteLLM round-trip.
 *
 * Usage (from repo root, with real credentials loaded via .env.master):
 *   npx ts-node scripts/anfis-replay-phase0.ts
 *
 * NO WRITES to any table. The only side effect is writing the CSV file to disk.
 */

import './_load-env-master'; // MUST be first: loads real credentials before config.ts evaluates
import * as fs from 'fs';
import * as path from 'path';
import { runReplay, toCsv } from '../src/services/anfis-replay-harness';
import { measureHookOverhead, hookEnabled } from '../src/services/anfis-litellm-test-hook';

async function main() {
  const outDir = process.env.SPRINT_OUT_DIR || 'E:/dev/sprints/2026-07-05/decisioning-foundation';
  fs.mkdirSync(outDir, { recursive: true });

  const { rows, summary } = await runReplay(7);

  const csvPath = path.join(outDir, 'phase0-replay.csv');
  fs.writeFileSync(csvPath, toCsv(rows), 'utf8');

  // ANFIS advisory-consult hook overhead — flag OFF (default): must be inert (fired=false, 0 overhead).
  const sample = { prompt: 'classify this short fact', taskHint: 'classify', testKey: 'x' };
  const offState = { enabled: hookEnabled(), ...measureHookOverhead(1000, sample) };

  // ASSERT OFF-state inertness (do not merely measure it): hard-fail if the hook fired while disabled.
  if (offState.fired !== false) {
    throw new Error(
      `[phase0] OFF-state inertness assertion FAILED: hook fired while disabled (fired=${offState.fired}, ` +
        `enabled=${offState.enabled}). Advisory hook must be provably inert with the flag OFF (R3/R4).`
    );
  }

  // ANFIS advisory-consult hook overhead — flag ON with a non-prod test key (measure REAL local round-trip).
  process.env.ANFIS_DECISIONING_HOOK_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  process.env.ANFIS_HOOK_TEST_KEY = 'phase0-nonprod-test-key';
  const onSample = { ...sample, testKey: 'phase0-nonprod-test-key' };
  const onState = { enabled: hookEnabled(), ...measureHookOverhead(1000, onSample) };

  const report = {
    csvPath,
    ...summary,
    // Local ANFIS advisory-consult overhead (NOT LiteLLM — the hook does not call LiteLLM in Phase 0).
    anfisAdvisoryHookOff: offState,
    anfisAdvisoryHookOn: onState,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  // Machine-readable line for the report doc.
  const decisionDrowns =
    summary.decisionMsP95 < summary.actualLatencyMsP50
      ? `YES (decision p95 ${summary.decisionMsP95.toFixed(4)}ms << actual latency p50 ${summary.actualLatencyMsP50.toFixed(0)}ms)`
      : `NO (decision p95 ${summary.decisionMsP95.toFixed(4)}ms >= actual latency p50 ${summary.actualLatencyMsP50.toFixed(0)}ms)`;
  // eslint-disable-next-line no-console
  console.error(`[phase0] decision-drowns-in-LLM-latency: ${decisionDrowns}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[phase0] FAILED:', e?.stack ?? e);
  process.exit(1);
});
