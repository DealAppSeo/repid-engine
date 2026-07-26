import {
  parseProofEnqueueMode,
  isChurnProofEvent,
  evaluateProofEnqueue,
  CHURN_PROOF_EVENT_TYPES,
  ProofEnqueueMode,
} from '../src/services/proof-enqueue-filter';

describe('proof-enqueue-filter (L2-style anti-churn, shadow-first)', () => {
  describe('parseProofEnqueueMode', () => {
    it('accepts the three canonical spellings', () => {
      expect(parseProofEnqueueMode('off')).toBe('off');
      expect(parseProofEnqueueMode('shadow')).toBe('shadow');
      expect(parseProofEnqueueMode('enforce')).toBe('enforce');
    });

    it('is case- and whitespace-insensitive', () => {
      expect(parseProofEnqueueMode('  OFF ')).toBe('off');
      expect(parseProofEnqueueMode('Enforce')).toBe('enforce');
      expect(parseProofEnqueueMode('\tShadow\n')).toBe('shadow');
    });

    it('defaults unknown/empty/undefined/null to shadow (never silently drops on a typo)', () => {
      expect(parseProofEnqueueMode(undefined)).toBe('shadow');
      expect(parseProofEnqueueMode(null)).toBe('shadow');
      expect(parseProofEnqueueMode('')).toBe('shadow');
      expect(parseProofEnqueueMode('   ')).toBe('shadow');
      expect(parseProofEnqueueMode('enforcen')).toBe('shadow');
      expect(parseProofEnqueueMode('true')).toBe('shadow');
    });
  });

  describe('isChurnProofEvent', () => {
    it('flags HAL_SCORE_EVENT as churn', () => {
      expect(isChurnProofEvent('HAL_SCORE_EVENT')).toBe(true);
      expect(isChurnProofEvent('  hal_score_event ')).toBe(true);
    });

    it('does NOT flag economic events', () => {
      for (const e of [
        'SERVICE_FULFILLED',
        'SERVICE_SATISFIED',
        'VALIDATOR_REWARD',
        'PREDICTION_RESOLVE',
        'VALIDATION_PASSED',
      ]) {
        expect(isChurnProofEvent(e)).toBe(false);
      }
    });

    it('is null/empty-safe', () => {
      expect(isChurnProofEvent(null)).toBe(false);
      expect(isChurnProofEvent(undefined)).toBe(false);
      expect(isChurnProofEvent('')).toBe(false);
    });

    it('only HAL_SCORE_EVENT is in the churn set today', () => {
      expect([...CHURN_PROOF_EVENT_TYPES]).toEqual(['HAL_SCORE_EVENT']);
    });
  });

  describe('evaluateProofEnqueue', () => {
    const churn = 'HAL_SCORE_EVENT';
    const economic = 'SERVICE_FULFILLED';

    it('off mode: never skips, never shadow-logs (byte-identical legacy)', () => {
      expect(evaluateProofEnqueue(churn, 'off')).toEqual({
        churn: true,
        skip: false,
        shadow: false,
        mode: 'off',
      });
      expect(evaluateProofEnqueue(economic, 'off')).toEqual({
        churn: false,
        skip: false,
        shadow: false,
        mode: 'off',
      });
    });

    it('shadow mode: churn shadow-logs but does NOT skip (observe before gating)', () => {
      const d = evaluateProofEnqueue(churn, 'shadow');
      expect(d.skip).toBe(false);
      expect(d.shadow).toBe(true);
      expect(d.churn).toBe(true);
    });

    it('enforce mode: churn skips, economic never skips', () => {
      expect(evaluateProofEnqueue(churn, 'enforce').skip).toBe(true);
      expect(evaluateProofEnqueue(economic, 'enforce').skip).toBe(false);
      // economic is never churn, never shadow, in any mode
      const modes: ProofEnqueueMode[] = ['off', 'shadow', 'enforce'];
      for (const m of modes) {
        const d = evaluateProofEnqueue(economic, m);
        expect(d.churn).toBe(false);
        expect(d.skip).toBe(false);
        expect(d.shadow).toBe(false);
      }
    });

    it('fail-safe: only churn events can ever produce skip=true', () => {
      // exhaustively, no economic/unknown event skips in any mode
      const modes: ProofEnqueueMode[] = ['off', 'shadow', 'enforce'];
      for (const m of modes) {
        expect(evaluateProofEnqueue('UNKNOWN_EVENT', m).skip).toBe(false);
        expect(evaluateProofEnqueue(null, m).skip).toBe(false);
      }
    });
  });
});
