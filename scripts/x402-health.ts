import { db } from '../src/db';

async function main() {
  console.log('==================================================');
  console.log('               X402 HEALTH REPORT                 ');
  console.log('==================================================\n');

  try {
    const { data: dashboard, error } = await db.from('x402_settlement_dashboard').select('*').single();

    if (error) {
      console.log(`Error querying dashboard: ${error.message}`);
      process.exit(1);
    }

    console.log('[Governors]');
    console.log(`Max USDC per hour: ${dashboard?.max_usdc_per_agent_hour || 'Not Set'}`);
    console.log('');

    console.log('[Circuit Breakers]');
    console.log(`Master CB State: ${dashboard?.circuit_breaker_state}`);
    console.log('');

    console.log('[Recovery Queue]');
    console.log(`Pending Retries: ${dashboard?.failures_1h}`);
    console.log('');

    console.log('[1h Settlement Activity]');
    console.log(`Real Settlements: ${dashboard?.real_settlements_1h}`);
    console.log(`Simulated Settlements: ${dashboard?.simulated_settlements_1h}`);
    console.log(`Total USDC Volume: ${dashboard?.total_usdc_micros_1h}`);
    console.log('');

    console.log('[24h Settlement Activity]');
    console.log(`Real Settlements: ${dashboard?.real_settlements_24h}`);
    console.log(`Last Real Settlement: ${dashboard?.last_real_settlement_at || 'Never'}`);
    console.log('');

    if (dashboard?.circuit_breaker_state === 'true' || Number(dashboard?.failures_1h) >= 3) {
      process.exit(1);
    } else {
      process.exit(0);
    }

  } catch (err: any) {
    console.error('Failed to run health check:', err.message);
    process.exit(1);
  }
}

main();
