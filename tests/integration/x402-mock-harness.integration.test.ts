import { settleX402Payment } from '../../src/services/x402-real-settler';
import { db } from '../../src/db';
import { describeIfSchema } from '../helpers/describe-if-schema';
import crypto from 'crypto';
const uuidv4 = () => crypto.randomUUID();

describeIfSchema('X402 Mock Harness Extended Scenarios', () => {
  afterEach(() => {
    process.env.MOCK_FACILITATOR = 'true';
  });

  // 1. MOCK_FACILITATOR=false throws error.
  test('MOCK_FACILITATOR=false throws error', async () => {
    process.env.MOCK_FACILITATOR = 'false';
    const res = await settleX402Payment('agent1', 'agent2', 0.1, uuidv4());
    expect(res.error).toMatch(/MOCK_FACILITATOR is false/i);
  });

  // 2. amount > 1.0 throws amount governor error.
  test('amount > 1.0 throws amount governor error', async () => {
    const res = await settleX402Payment('agent1', 'agent2', 1.1, uuidv4());
    expect(res.error).toMatch(/Governor limit exceeded/i);
  });

  // 3. repid_config.cb_disable_x402_settlements = true throws circuit breaker error.
  test('cb_disable_x402_settlements = true throws circuit breaker error', async () => {
    // Set CB to true
    await db.from('repid_config').update({ value: 'true' }).eq('key', 'cb_disable_x402_settlements');
    
    const res = await settleX402Payment('agent1', 'agent2', 0.1, uuidv4());
    expect(res.error).toMatch(/Circuit breaker active/i);

    // Revert CB to false
    await db.from('repid_config').update({ value: 'false' }).eq('key', 'cb_disable_x402_settlements');
  });

  // 4. Duplicate idempotency key throws unique constraint error.
  test('Duplicate idempotency key throws unique constraint error', async () => {
    const betId = uuidv4();
    await settleX402Payment('agent1', 'agent2', 0.1, betId);
    
    const res = await settleX402Payment('agent1', 'agent2', 0.1, betId);
    expect(res.error).toMatch(/duplicate key value violates unique constraint/i);
  });

  // 5. Settlement failure increments settlement_attempt_count.
  test('Settlement failure increments settlement_attempt_count', async () => {
    // We expect the wrapper to record a failure
    const betId = uuidv4();
    await settleX402Payment('agent1', 'invalid_agent', 0.1, betId);
    
    const { data } = await db.from('x402_settlement_failures').select('attempt_count').order('created_at', { ascending: false }).limit(1).single();
    expect(data?.attempt_count).toBeGreaterThan(0);
  });

  // 6. Non-existent agent ID throws not-found error.
  test('Non-existent agent wallet throws not-found error', async () => {
    const res = await settleX402Payment('agent1', 'NON_EXISTENT_AGENT', 0.1, uuidv4());
    expect(res.error).toMatch(/not found|Cannot determine destination address/i);
  });
});
