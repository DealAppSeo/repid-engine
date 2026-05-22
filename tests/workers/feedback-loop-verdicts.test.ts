import { isEligibleForOnChainWrite, FilterableEvent } from '../../src/workers/feedback-loop-filters';

const REAL_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const REAL_TX = '0x9a7f3c2b1e4d5a6f7089abcdef0123456789abcdef0123456789abcdef012345';

// A row that passes all the morning defensive filters; we vary only the verdicts.
function base(verdict_x402: string, verdict_hal: string): FilterableEvent {
  return {
    subject_type: 'agent',
    subject_id: REAL_UUID,
    event_data: { tx_hash: REAL_TX, is_simulated: false },
    verdict_x402,
    verdict_hal,
  };
}

describe('FeedbackLoopWorker parallel-verdict gate (REQUIRE_DUAL_VERDICT)', () => {
  const prev = process.env.REQUIRE_DUAL_VERDICT;
  afterEach(() => {
    if (prev === undefined) delete process.env.REQUIRE_DUAL_VERDICT;
    else process.env.REQUIRE_DUAL_VERDICT = prev;
  });

  describe('flag ON — verdict-combination matrix', () => {
    beforeEach(() => { process.env.REQUIRE_DUAL_VERDICT = 'true'; });

    it('settled + pass → on-chain write allowed', () => {
      const r = isEligibleForOnChainWrite(base('settled', 'pass'));
      expect(r.eligible).toBe(true);
    });
    it('settled + fail → vetoed (HAL dissent), no on-chain write', () => {
      const r = isEligibleForOnChainWrite(base('settled', 'fail'));
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe('hal_not_pass');
    });
    it('rejected + pass → vetoed (x402 dissent), no on-chain write', () => {
      const r = isEligibleForOnChainWrite(base('rejected', 'pass'));
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe('x402_not_settled');
    });
    it('rejected + fail → vetoed (both dissent), no on-chain write', () => {
      const r = isEligibleForOnChainWrite(base('rejected', 'fail'));
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe('x402_not_settled');
    });
    it('pending verdicts → vetoed until both land', () => {
      expect(isEligibleForOnChainWrite(base('settled', 'pending')).reason).toBe('hal_not_pass');
      expect(isEligibleForOnChainWrite(base('pending', 'pass')).reason).toBe('x402_not_settled');
    });
  });

  describe('flag OFF (default) — backward compatible', () => {
    beforeEach(() => { delete process.env.REQUIRE_DUAL_VERDICT; });

    it('ignores verdicts when REQUIRE_DUAL_VERDICT is unset (existing behavior preserved)', () => {
      // Even a settled+fail row is eligible when the dual-verdict gate is off,
      // so merging this change cannot halt existing worker writes pre-rollout.
      expect(isEligibleForOnChainWrite(base('settled', 'fail')).eligible).toBe(true);
      expect(isEligibleForOnChainWrite(base('rejected', 'fail')).eligible).toBe(true);
    });
  });
});
