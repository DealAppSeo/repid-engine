/**
 * trust-receipt-writer.test.ts — the writer must NEVER throw; it returns the id on
 * success and null on failure, so a receipt write can't take a settlement down with it.
 */
import { writeTrustReceipt, TrustReceiptInput } from '../src/services/trust-receipt-writer';

const input = (): TrustReceiptInput => ({
  id: 'rcpt-test-1',
  action_class: 'durable_repid_move',
  subject_agent_id: 'agent-1',
  evidence_predicate_result: { settlement_confirmed: true },
  hal_evidence: { decision: 'clean' },
  gate_decision: 'ALLOW',
  gate_reasons: ['reward_authorized:settlement_sensors'],
  authorized_delta: 90,
  outcome: 'success',
});

const fakeDb = (impl: () => Promise<{ error: unknown }>) =>
  ({ from: () => ({ insert: impl }) } as any);

describe('writeTrustReceipt', () => {
  it('returns the receipt id on a clean insert', async () => {
    const id = await writeTrustReceipt(fakeDb(async () => ({ error: null })), input());
    expect(id).toBe('rcpt-test-1');
  });

  it('returns null (never throws) when the insert reports an error', async () => {
    const id = await writeTrustReceipt(fakeDb(async () => ({ error: { message: 'boom' } })), input());
    expect(id).toBeNull();
  });

  it('returns null (never throws) when the insert throws', async () => {
    const id = await writeTrustReceipt(fakeDb(async () => { throw new Error('network'); }), input());
    expect(id).toBeNull();
  });
});
