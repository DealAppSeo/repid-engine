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

  // ANFIS advisory-consult hook overhead — flag OFF: must be inert (fired=false, 0 overhead).
  // KILL-SWITCH PROOF (V5): force the kill-switch OFF DETERMINISTICALLY before probing, so this asserts
  // inertness independent of test-key state. If .env.master already set ANFIS_DECISIONING_HOOK_ENABLED=true,
  // consult() would still return fired:false via the TEST-KEY gate — masking a hook that is actually ENABLED.
  // Deleting the flag makes hookEnabled() genuinely false, so fired:false PROVES the kill-switch produces
  // inertness, not merely a missing test key.
  delete process.env.ANFIS_DECISIONING_HOOK_ENABLED;
  const sample = { prompt: 'classify this short fact', taskHint: 'classify', testKey: 'x' };
  const offState = { enabled: hookEnabled(), ...measureHookOverhead(1000, sample) };

  // ASSERT OFF-state inertness via the kill-switch (do not merely measure it):
  //  - hookEnabled() MUST be false (the kill-switch is genuinely OFF, not a test-key miss)
  //  - the hook MUST NOT have fired, and MUST report enabled=false.
  if (hookEnabled() !== false || offState.enabled !== false || offState.fired !== false) {
    throw new Error(
      `[phase0] OFF-state kill-switch inertness assertion FAILED: ` +
        `hookEnabled()=${hookEnabled()}, offState.enabled=${offState.enabled}, offState.fired=${offState.fired}. ` +
        `With the kill-switch forced OFF the advisory hook must be provably inert (R3/R4).`
    );
  }

  // ANFIS advisory-consult hook overhead — flag ON with a non-prod test key (measure REAL local round-trip).
  process.env.ANFIS_DECISIONING_HOOK_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  process.env.ANFIS_HOOK_TEST_KEY = 'phase0-nonprod-test-key';
  const onSample = { ...sample, testKey: 'phase0-nonprod-test-key' };
  const onState = { enabled: hookEnabled(), ...measureHookOverhead(1000, onSample) };

  // ASSERT ON-state activation (symmetric to the OFF-state kill-switch check above):
  //  - the hook MUST report enabled=true, and MUST have fired when genuinely enabled.
  if (onState.enabled !== true || onState.fired !== true) {
    throw new Error(
      `[phase0] ON-state assertion FAILED: hook must fire when enabled ` +
        `(onState.enabled=${onState.enabled}, onState.fired=${onState.fired}). ` +
        `With the kill-switch ON and a non-prod test key the advisory hook must be provably active (R3/R4).`
    );
  }

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
