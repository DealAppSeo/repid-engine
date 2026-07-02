/**
 * Unit tests for the verify/red-team → ERC-8004 outbox bridge
 * (feat/verify-redteam-repid-erc8004).
 *
 * Covers:
 *   1. ONCHAIN_ELIGIBLE_EVENT_TYPES now includes the peer-verify + red-team
 *      event types (the worker filter surface).
 *   2. emitOnChainOutboxEvent is flag-gated (default OFF), validates the
 *      subject uuid, and writes an eligible repid_events row when ON.
 */

const insertMock = jest.fn();
const fromMock = jest.fn(() => ({ insert: insertMock }));

jest.mock('../src/db', () => ({
  db: { from: (...args: any[]) => fromMock(...args) },
}));

import {
  ONCHAIN_ELIGIBLE_EVENT_TYPES,
} from '../src/workers/feedback-loop-filters';
import { emitOnChainOutboxEvent, onchainOutboxEnabled } from '../src/services/onchain-outbox';

const GOOD_UUID = '11111111-2222-4333-8444-555555555555';

describe('ONCHAIN_ELIGIBLE_EVENT_TYPES (worker filter)', () => {
  it('keeps the original settlement event types', () => {
    expect(ONCHAIN_ELIGIBLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'x402_inbound_settled',
        'x402_outbound_settled',
        'service_fulfilled_settled',
      ])
    );
  });

  it('adds the peer-verify + red-team event types', () => {
    expect(ONCHAIN_ELIGIBLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'peer_verify_verified',
        'peer_verify_disputed',
        'redteam_good_catch',
        'redteam_lazy_subject',
        'redteam_frivolous_reject',
      ])
    );
  });
});

describe('emitOnChainOutboxEvent', () => {
  beforeEach(() => {
    insertMock.mockReset();
    fromMock.mockClear();
    insertMock.mockResolvedValue({ error: null });
    delete process.env.VERIFY_REDTEAM_ONCHAIN_OUTBOX;
  });

  it('is OFF by default (no insert, emitted:false)', async () => {
    expect(onchainOutboxEnabled()).toBe(false);
    const r = await emitOnChainOutboxEvent({
      subjectAgentId: GOOD_UUID,
      eventType: 'peer_verify_verified',
      reputationDelta: 3,
    });
    expect(r.emitted).toBe(false);
    expect(r.skippedReason).toBe('flag_off');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('writes an eligible repid_events row when flag ON', async () => {
    process.env.VERIFY_REDTEAM_ONCHAIN_OUTBOX = 'true';
    const r = await emitOnChainOutboxEvent({
      subjectAgentId: GOOD_UUID,
      eventType: 'redteam_good_catch',
      reputationDelta: 5,
      context: { challenge_id: 'adj-1', role: 'finder' },
    });
    expect(r.emitted).toBe(true);
    expect(fromMock).toHaveBeenCalledWith('repid_events');
    const row = insertMock.mock.calls[0]![0];
    expect(row.subject_id).toBe(GOOD_UUID);
    expect(row.subject_type).toBe('agent');
    expect(row.event_type).toBe('redteam_good_catch');
    expect(row.reputation_delta).toBe(5);
    // event_data must pass the worker eligibility filter (non-sim, non-mock hash)
    expect(row.event_data.is_simulated).toBe(false);
    expect(row.event_data.challenge_id).toBe('adj-1');
  });

  it('skips (no insert) when subject is not a uuid', async () => {
    process.env.VERIFY_REDTEAM_ONCHAIN_OUTBOX = 'true';
    const r = await emitOnChainOutboxEvent({
      subjectAgentId: 'trinity-mel',
      eventType: 'peer_verify_verified',
      reputationDelta: 3,
    });
    expect(r.emitted).toBe(false);
    expect(r.skippedReason).toBe('invalid_subject');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does not throw when the insert fails (returns emitted:false)', async () => {
    process.env.VERIFY_REDTEAM_ONCHAIN_OUTBOX = 'true';
    insertMock.mockResolvedValueOnce({ error: { message: 'boom' } });
    const r = await emitOnChainOutboxEvent({
      subjectAgentId: GOOD_UUID,
      eventType: 'peer_verify_disputed',
      reputationDelta: -2,
    });
    expect(r.emitted).toBe(false);
    expect(r.skippedReason).toBe('insert_failed');
  });
});
