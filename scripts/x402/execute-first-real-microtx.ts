import { runPreflight } from './preflight-real-microtx';
import { settlePayment } from '../../src/services/x402-facilitator';
import { db } from '../../src/db';

async function executeFirstRealMicrotx() {
  console.log('Starting execution of FIRST REAL MICROTX...');

  // Gate 1: MOCK_FACILITATOR check
  if (process.env.MOCK_FACILITATOR !== 'true') {
    console.error('ABORT: MOCK_FACILITATOR must be true. No live executions permitted in this sprint.');
    process.exit(1);
  }

  // Gate 2: Preflight check
  console.log('\n--- Running Preflight Checks ---');
  const checks = await runPreflight();
  
  const hasRed = checks.some(c => c.status === 'RED');
  const hasAmber = checks.some(c => c.status === 'AMBER');

  if (hasRed || hasAmber) {
    console.error('\nABORT: Preflight returned RED or AMBER checks. Execution halted.');
    process.exit(1);
  }
  console.log('Preflight GREEN. Proceeding...');

  // Gate 3: 10-second countdown
  console.log('\n--- Final Warning ---');
  console.log('Initiating 10-second countdown. Press Ctrl+C to abort.');
  for (let i = 10; i > 0; i--) {
    console.log(`T-${i}...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('Executing settlement...');

  // Select target agent
  const { data: agent, error } = await db
    .from('repid_mvp_agents')
    .select('id, wallet_address')
    .limit(1)
    .single();

  if (error || !agent) {
    console.error('ABORT: Could not find target MVP agent.');
    process.exit(1);
  }

  // Execute settlement
  try {
    const result = await settlePayment(
      agent.wallet_address,
      1.0,
      'USDC',
      'first-real-microtx-patent-event'
    );

    console.log('\n--- SETTLEMENT SUCCESS ---');
    console.log(JSON.stringify(result, null, 2));
    
  } catch (err: any) {
    console.error('\n--- SETTLEMENT FAILED ---');
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  executeFirstRealMicrotx().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
