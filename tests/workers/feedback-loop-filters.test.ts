import { isEligibleForOnChainWrite, POLL_EVENT_FILTER_SQL } from '../../src/workers/feedback-loop-filters';

const REAL_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const REAL_TX = '0x9a7f3c2b1e4d5a6f7089abcdef0123456789abcdef0123456789abcdef012345';

describe('FeedbackLoopWorker defensive filters', () => {
  // 1. conductor-type → skipped
  it('skips non-agent (conductor) subject_type', () => {
    const r = isEligibleForOnChainWrite({ subject_type: 'conductor', subject_id: REAL_UUID, event_data: { tx_hash: REAL_TX } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('subject_type_not_agent');
  });

  // 2. non-uuid subject_id → skipped
  it('skips non-uuid subject_id', () => {
    const r = isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: 'conductor-orphan-123', event_data: { tx_hash: REAL_TX } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('subject_id_not_uuid');
  });

  // 3. is_simulated=true → skipped (handles both boolean and string forms)
  it('skips simulated events', () => {
    expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: REAL_UUID, event_data: { is_simulated: true, tx_hash: REAL_TX } }).reason).toBe('is_simulated');
    expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: REAL_UUID, event_data: { is_simulated: 'true', tx_hash: REAL_TX } }).reason).toBe('is_simulated');
  });

  // 4. mock tx_hash → skipped
  it('skips mock/placeholder tx hashes', () => {
    for (const tx of ['0xmock_abc', '0xabc123', '0x0000000000000000000000000000000000000000000000000000000000000000']) {
      const r = isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: REAL_UUID, event_data: { tx_hash: tx } });
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe('mock_tx_hash');
    }
  });

  // 5. drained_as_historical_mock=true → skipped
  it('skips events flagged drained_as_historical_mock', () => {
    const r = isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: REAL_UUID, event_data: { tx_hash: REAL_TX, drained_as_historical_mock: true } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('drained_historical_mock');
  });

  // 6. canonical event → picked up
  it('accepts a canonical agent event with a real-looking tx hash and no flags', () => {
    const r = isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: REAL_UUID, event_data: { tx_hash: REAL_TX, is_simulated: false } });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  // Guard: the SQL fragment stays in sync with the JS predicate (all 6 clauses present).
  it('SQL filter fragment contains all six guard clauses', () => {
    for (const frag of [
      "subject_type = 'agent'",
      'subject_id ~',
      "is_simulated', 'false') != 'true'",
      "tx_hash', '') !~ '^0x(mock|abc|0{8})'",
      "drained_as_historical_mock', 'false') != 'true'",
      "drained_as_orphaned_conductor_format', 'false') != 'true'",
    ]) {
      expect(POLL_EVENT_FILTER_SQL).toContain(frag);
    }
  });
});
