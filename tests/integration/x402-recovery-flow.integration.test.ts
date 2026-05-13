import { processRecoveryQueue } from '../../src/services/x402-recovery-worker';
import { db } from '../../src/db';
import { x402Facilitator } from '../../src/services/x402-facilitator';

jest.mock('../../src/services/x402-facilitator', () => ({
  x402Facilitator: {
    settlePayment: jest.fn()
  }
}));

describe('x402-recovery-flow-integration', () => {
  let failureId: number;

  beforeAll(async () => {
    // Check circuit breaker, temporarily disable if it's tripped
    const { data: cbConfig } = await db.from('repid_config')
      .select('value')
      .eq('key', 'cb_disable_x402_settlements')
      .single();

    if (cbConfig?.value === 'true') {
      await db.from('repid_config').update({ value: 'false' }).eq('key', 'cb_disable_x402_settlements');
    }

    // Insert a test row in failures
    const inserted = await db.from('x402_settlement_failures').insert({
      direction: 'outbound',
      agent_id: 'daf7d609-d401-461c-bfd0-eff83fd1da8d',
      payment_payload_b64: 'test_payload',
      payment_requirements: [],
      attempt_count: 1,
      last_attempted_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago (eligible)
      idempotency_key: 'test_idem_key_recovery_int'
    }).select().single();

    if (inserted.error) {
      throw new Error(`Failed to insert test row: ${inserted.error.message}`);
    }
    failureId = inserted.data.id;
  });

  afterAll(async () => {
    // Clean up
    await db.from('x402_settlements').delete().eq('idempotency_key', 'test_idem_key_recovery_int');
    await db.from('x402_settlement_failures').delete().eq('id', failureId);
    await db.from('x402_recovery_worker_runs').delete().eq('dry_run', false).order('created_at', { ascending: false }).limit(1);
  });

  test('Full recovery flow', async () => {
    // Mock the facilitator to return SUCCESS
    (x402Facilitator.settlePayment as jest.Mock).mockResolvedValue({ txHash: '0x123abc' });

    const result = await processRecoveryQueue({ dryRun: false });

    // Assert worker result
    expect(result.rowsRecovered).toBeGreaterThanOrEqual(1);

    // Verify: failure row now has resolved_at set
    const { data: row } = await db.from('x402_settlement_failures').select('*').eq('id', failureId).single();
    expect(row.resolved_at).not.toBeNull();

    // Verify: settlement row exists with matching idempotency_key
    const { data: settlement } = await db.from('x402_settlements').select('*').eq('idempotency_key', 'test_idem_key_recovery_int').single();
    expect(settlement).not.toBeNull();

    // Verify: telemetry row shows rows_recovered
    const { data: telemetry } = await db.from('x402_recovery_worker_runs').select('*').order('created_at', { ascending: false }).limit(1).single();
    expect(telemetry).not.toBeNull();
    expect(telemetry.rows_recovered).toBeGreaterThanOrEqual(1);
  });
});
