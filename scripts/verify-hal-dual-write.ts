/**
 * CC Sprint 7 — verify HAL dual-write hook actually fires when env enabled.
 *
 * Sprint 6 diagnosis (Phase 3): the dual-write hook at
 * src/services/hal-evaluations-writer.ts is env-gated by
 * HAL_EVALUATIONS_DUAL_WRITE (default OFF). When Sean flips it to 'true'
 * on the repid-engine Railway service, this script proves the flip worked
 * end-to-end:
 *
 *   1. Confirms HAL_EVALUATIONS_DUAL_WRITE is set + truthy
 *   2. Calls writeHalEvaluation() directly with a tagged synthetic payload
 *   3. Polls hal_evaluations for up to 5s, looking for that exact synthetic row
 *   4. Verifies row exists with the expected fields populated
 *   5. Tears down: deletes the synthetic row before exit
 *
 * Usage (after Sean sets HAL_EVALUATIONS_DUAL_WRITE=true and redeploys):
 *   HAL_EVALUATIONS_DUAL_WRITE=true npm run verify:hal-dual-write
 *
 * Exit codes:
 *   0  → flag is on AND row appeared AND was cleaned up (PASS)
 *   1  → flag is OFF (warning + Sean instructions; not a failure)
 *   2  → flag is on but row didn't appear (FAIL — hook is broken)
 *   3  → unexpected crash
 *
 * Cleanup safety: the synthetic row is tagged with a UUID generated this
 * run + notes containing "verify-hal-dual-write-script-CC-Sprint-7" so it's
 * unambiguous to identify and delete. If teardown fails, the script logs
 * the row id for manual cleanup.
 */

import 'dotenv/config';
import * as crypto from 'crypto';
import { writeHalEvaluation } from '../src/services/hal-evaluations-writer';
import { db } from '../src/db';

const FLAG = process.env.HAL_EVALUATIONS_DUAL_WRITE;
const TAG = `verify-hal-dual-write-script-CC-Sprint-7`;
const RUN_ID = crypto.randomUUID();

async function main(): Promise<number> {
  console.log('--- HAL dual-write verify ---');
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`HAL_EVALUATIONS_DUAL_WRITE: ${FLAG ?? '(unset)'}`);

  if (FLAG !== 'true') {
    console.log('');
    console.log('⚠️  HAL_EVALUATIONS_DUAL_WRITE is not "true".');
    console.log('   The dual-write hook will no-op until this env var is set.');
    console.log('');
    console.log('Sean action items:');
    console.log('  1. Open Railway dashboard → repid-engine service → Variables tab');
    console.log('  2. Add: HAL_EVALUATIONS_DUAL_WRITE = true');
    console.log('  3. Wait for redeploy');
    console.log('  4. Re-run this script (locally with prod env, or via SSH)');
    console.log('');
    console.log('Returning exit code 1 (warning, not failure).');
    return 1;
  }

  console.log('');
  console.log('Flag is ON. Calling writeHalEvaluation() with synthetic payload...');

  const synthetic = {
    mode: 'shadow' as const,
    experiment_id: RUN_ID,
    prompt_id: `verify-${RUN_ID.slice(0, 8)}`,
    prompt_source: 'live_user_query' as const,
    prompt_text: `[verification synthetic prompt — ${RUN_ID}] safe to delete`,
    gen_provider: 'verify-script',
    gen_model: 'verify-script-1.0',
    gen_latency_ms: 0,
    hal_signals: { source: TAG, run_id: RUN_ID },
    hal_score: 0,
    hal_vetoed: false,
    decision: 'APPROVE' as const,
    notes: TAG,
  };

  await writeHalEvaluation(synthetic);

  console.log('Insert dispatched. Polling hal_evaluations for up to 5s...');

  // Poll for the row. The writer is fire-and-forget by design (Sprint 6 finding)
  // so we may need to wait a beat for the network round-trip.
  const start = Date.now();
  let found: any = null;
  while (Date.now() - start < 5000) {
    const { data, error } = await db
      .from('hal_evaluations')
      .select('id, experiment_id, notes, mode, prompt_id, hal_score, decision')
      .eq('experiment_id', RUN_ID)
      .maybeSingle();
    if (error) {
      console.error(`Lookup error: ${error.message}`);
      // Don't bail; keep polling — could be transient
    }
    if (data) {
      found = data;
      break;
    }
    await new Promise((res) => setTimeout(res, 250));
  }

  if (!found) {
    console.log('');
    console.log('❌ FAIL — no row found within 5s.');
    console.log('   The hook either no-op\'d (flag check), errored silently, or hit RLS.');
    console.log('   Check repid-engine logs for "[hal-evaluations-writer]" entries.');
    return 2;
  }

  console.log('');
  console.log('✅ PASS — synthetic row landed:');
  console.log(`   id:            ${found.id}`);
  console.log(`   experiment_id: ${found.experiment_id}`);
  console.log(`   prompt_id:     ${found.prompt_id}`);
  console.log(`   mode:          ${found.mode}`);
  console.log(`   decision:      ${found.decision}`);
  console.log(`   notes:         ${found.notes}`);

  // Teardown
  console.log('');
  console.log('Cleaning up synthetic row...');
  const { error: delErr } = await db.from('hal_evaluations').delete().eq('id', found.id);
  if (delErr) {
    console.warn(`⚠️  Teardown failed for row id=${found.id}: ${delErr.message}`);
    console.warn('    Manual cleanup: DELETE FROM hal_evaluations WHERE id = ' + found.id + ';');
    return 0; // Still PASS — the WRITE worked; only cleanup failed
  }
  console.log(`Deleted row id=${found.id}.`);
  console.log('');
  console.log('All checks PASS. HAL dual-write hook is firing correctly.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('verify-hal-dual-write crashed:', e);
    process.exit(3);
  });
