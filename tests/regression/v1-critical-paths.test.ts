/**
 * V1 CRITICAL-PATH REGRESSION SUITE (CC1, 2026-05-24).
 *
 * After the live-USDC launch these invariants can NEVER regress. This suite is
 * deterministic and pure — NO real money, NO on-chain writes, NO DB/network — so
 * it is safe in CI as a pre-merge / pre-deploy gate.
 *
 * Scope = the gas-discipline + attestation-integrity guarantees (CC1-owned code).
 * Complementary, not duplicative:
 *   - escrow / cascade / 402-gate ........ tests/integration/* , tests/routes/v1/contracts.test.ts
 *   - double-fulfill ..................... tests/red-team/double-fulfill.test.ts
 *   - HAL min-quorum resilience .......... tests/hal/provider-failure/resilience.test.ts
 *   - is_simulated SQL/JS filter detail .. tests/workers/feedback-loop-filters.test.ts
 * This file adds the previously-UNTESTED sim-flag normalizer (utils/truthy.ts) and
 * codifies the consolidated "simulated/mock => never an on-chain write" invariant.
 */
import { isTruthyFlag, hasTruthySimFlag } from '../../src/utils/truthy';
import { isEligibleForOnChainWrite, MOCK_TX_RE, UUID_RE } from '../../src/workers/feedback-loop-filters';

const VALID_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626'; // shofet (shape only)

describe('V1 Critical Path Regression Suite', () => {
  // ── Gas-discipline: the is_simulated bypass guard (F-series, previously untested) ──
  describe('sim-flag normalizer (utils/truthy)', () => {
    it.each([true, 'true', 'True', 'TRUE', ' true ', 1, '1', 'yes', 'YES'])(
      'isTruthyFlag flags truthy variant %p', (v) => expect(isTruthyFlag(v)).toBe(true),
    );
    it.each([false, 'false', 'False', 0, '0', 'no', '', null, undefined, {}, 'maybe'])(
      'isTruthyFlag rejects non-truthy %p', (v) => expect(isTruthyFlag(v as unknown)).toBe(false),
    );

    it('hasTruthySimFlag catches top-level + string/number variants (F1/F2)', () => {
      expect(hasTruthySimFlag({ is_simulated: true })).toBe(true);
      expect(hasTruthySimFlag({ is_simulated: 'True' })).toBe(true);
      expect(hasTruthySimFlag({ is_simulated: 1 })).toBe(true);
      expect(hasTruthySimFlag({ is_simulated: 'yes' })).toBe(true);
    });
    it('hasTruthySimFlag catches nested/mislocated flag (F4)', () => {
      expect(hasTruthySimFlag({ metadata: { is_simulated: 'TRUE' } })).toBe(true);
      expect(hasTruthySimFlag({ a: { b: { is_simulated: 1 } } })).toBe(true);
    });
    it('hasTruthySimFlag does NOT false-positive on real (non-sim) events', () => {
      expect(hasTruthySimFlag({ is_simulated: false })).toBe(false);
      expect(hasTruthySimFlag({ is_simulated: 'false' })).toBe(false);
      expect(hasTruthySimFlag({ tx_hash: '0xreal', metadata: {} })).toBe(false);
      expect(hasTruthySimFlag(null)).toBe(false);
      expect(hasTruthySimFlag('not-an-object' as unknown)).toBe(false);
    });
  });

  // ── Attestation integrity: simulated / mock / orphaned => never an on-chain write ──
  describe('on-chain write eligibility (workers/feedback-loop-filters)', () => {
    it('a clean real agent event IS eligible', () => {
      expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: VALID_UUID, event_data: {} }))
        .toEqual({ eligible: true });
    });
    it.each(['true', 'True', 'TRUE', 1, '1', 'yes'])(
      'INVARIANT: is_simulated=%p is excluded (no sim->on-chain leak)',
      (sim) => expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: VALID_UUID, event_data: { is_simulated: sim } }))
        .toEqual({ eligible: false, reason: 'is_simulated' }),
    );
    it('nested/mislocated is_simulated is excluded', () => {
      expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: VALID_UUID, event_data: { metadata: { is_simulated: 'True' } } }))
        .toEqual({ eligible: false, reason: 'is_simulated' });
    });
    it.each(['0xmock_reput', '0xMOCK123', '0xabc000', '0xABCdef', '0x00000000ff'])(
      'INVARIANT: mock tx_hash %p is excluded',
      (tx) => expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: VALID_UUID, event_data: { tx_hash: tx } }))
        .toEqual({ eligible: false, reason: 'mock_tx_hash' }),
    );
    it('non-agent subject is excluded', () => {
      expect(isEligibleForOnChainWrite({ subject_type: 'contract', subject_id: VALID_UUID, event_data: {} }))
        .toEqual({ eligible: false, reason: 'subject_type_not_agent' });
    });
    it('non-UUID subject is excluded', () => {
      expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: 'attacker-controlled', event_data: {} }))
        .toEqual({ eligible: false, reason: 'subject_id_not_uuid' });
    });
    it.each([
      ['drained_as_historical_mock', 'drained_historical_mock'],
      ['drained_as_orphaned_conductor_format', 'drained_orphaned_conductor'],
    ])('drained flag %s is excluded', (flag, reason) => {
      expect(isEligibleForOnChainWrite({ subject_type: 'agent', subject_id: VALID_UUID, event_data: { [flag]: 'true' } }))
        .toEqual({ eligible: false, reason });
    });
  });

  // ── Pattern guards used by the SQL poll + JS re-check (keep them in lockstep) ──
  describe('pattern invariants', () => {
    it.each(['0xmock', '0xMOCK', '0xabc', '0xABC', '0x00000000'])('MOCK_TX_RE matches mock %p', (t) =>
      expect(MOCK_TX_RE.test(t)).toBe(true));
    it('MOCK_TX_RE does NOT match a real 32-byte tx hash', () =>
      expect(MOCK_TX_RE.test('0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a')).toBe(false));
    it('UUID_RE accepts a canonical uuid and rejects junk', () => {
      expect(UUID_RE.test(VALID_UUID)).toBe(true);
      expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(UUID_RE.test('not-a-uuid')).toBe(false);
    });
  });
});
