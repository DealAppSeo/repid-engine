import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://qnnpjhlxljtqyigedwkb.supabase.co';
// Need a valid key, ideally from env. Assuming we have SUPABASE_SERVICE_ROLE_KEY or ANON_KEY
// but we might not in standard execution context unless loaded. We'll use the db module instead.
import { db } from '../src/db';

async function checkHealth() {
  const { data: dashboard, error: dashboardErr } = await db.from('x402_settlement_dashboard').select('*').single();
  
  if (dashboardErr) {
    console.error('Failed to read x402_settlement_dashboard:', dashboardErr.message);
    process.exit(1);
  }

  console.log('--- X402 SETTLEMENT DASHBOARD ---');
  console.log(`Total Settlements: ${dashboard.total_settlements}`);
  console.log(`Total Volume USDC: ${dashboard.total_volume_usdc}`);
  console.log(`Volume Last 1h USDC: ${dashboard.volume_last_1h_usdc}`);
  console.log(`Failed Attempts Last 1h: ${dashboard.failed_attempts_last_1h}`);
  console.log(`Circuit Breaker Tripped: ${dashboard.circuit_breaker_tripped}`);

  console.log('\n--- X402 RECOVERY WORKER STATUS ---');
  const { data: telemetry } = await db
    .from('x402_recovery_worker_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (telemetry) {
    console.log(`Last run time: ${telemetry.started_at}`);
    console.log(`Rows recovered: ${telemetry.rows_recovered}`);
    console.log(`Rows still failing: ${telemetry.rows_still_failing}`);
    console.log(`Rows abandoned: ${telemetry.rows_abandoned}`);
  } else {
    console.log('No recovery worker runs logged yet.');
  }

  const { count: unresolvedCount } = await db
    .from('x402_settlement_failures')
    .select('*', { count: 'exact', head: true })
    .is('resolved_at', null);

  const { count: abandonedCount } = await db
    .from('x402_settlement_failures')
    .select('*', { count: 'exact', head: true })
    .gte('attempt_count', 5)
    .is('resolved_at', null);

  console.log(`Unresolved failures currently in queue: ${unresolvedCount || 0}`);
  console.log(`Abandoned failures (attempt_count >= 5): ${abandonedCount || 0}`);

  console.log('\n--- X402 WAKEUP READINESS ---');
  console.log(`Circuit Breaker: ${dashboard.circuit_breaker_tripped}`);
  console.log(`Unresolved Failures: ${unresolvedCount || 0}`);
  try {
    const { runPreflight } = require('./x402/preflight-real-microtx');
    const checks = await runPreflight();
    const hasRed = checks.some((c: any) => c.status === 'RED');
    const hasAmber = checks.some((c: any) => c.status === 'AMBER');
    if (hasRed) {
      console.log('Preflight Checks Passed: No (RED found)');
    } else if (hasAmber) {
      console.log('Preflight Checks Passed: Warnings (AMBER found)');
    } else {
      console.log('Preflight Checks Passed: Yes (All GREEN)');
    }
  } catch (e: any) {
    console.log(`Preflight Checks Passed: Error (${e.message})`);
  }

  if (dashboard.circuit_breaker_tripped === 'true' || Number(abandonedCount) > 0) {
    console.error('\nHEALTH CHECK FAILED: Circuit breaker tripped OR abandoned failures exist.');
    process.exit(1);
  }

  console.log('\nHEALTH CHECK PASSED');
  process.exit(0);
}

checkHealth().catch(err => {
  console.error(err);
  process.exit(1);
});
