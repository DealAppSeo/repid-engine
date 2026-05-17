// Phase 2.10 — two-agent service flow (structural invariants).
// The LIVE two-agent lifecycle (buyer→escrow→fulfil→satisfied + SERVICE_*
// deltas) requires working LLM keys and is exercised in Step 9 live
// verification (parks until keys validated). This file asserts the
// non-LLM wiring invariants so the suite stays green meanwhile.
jest.mock('../../src/db', () => ({ db: { rpc: jest.fn() } }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../../src/services/pcp-validator', () => ({ runPCP: jest.fn() }));
jest.mock('../../src/services/adversarial-judge', () => ({ runAdversarialJudge: jest.fn() }));
jest.mock('../../src/hal/cross-llm-client', () => ({ checkPythagoreanComma: jest.fn() }));

import { ServiceHandlerBase } from '../../src/services/service-handler-base';
import { VerificationServiceHandler } from '../../src/services/verification-service-handler';
import { CrossValidationServiceHandler } from '../../src/services/cross-validation-service-handler';
import { AnfisRoutingServiceHandler } from '../../src/services/anfis-routing-service-handler';

describe('Phase 2.10 two-agent service flow (structural)', () => {
  it('all three handlers extend the production base and expose processOne', () => {
    const handlers = [
      new VerificationServiceHandler(),
      new CrossValidationServiceHandler(),
      new AnfisRoutingServiceHandler(),
    ];
    for (const h of handlers) {
      expect(h).toBeInstanceOf(ServiceHandlerBase);
      expect(typeof (h as any).processOne).toBe('function');
      expect(typeof (h as any).process).toBe('function'); // Phase 2.11 compat shim
    }
  });

  it('serviceType values match the agent_services / endpoint contract', () => {
    expect((new VerificationServiceHandler() as any).serviceType).toBe('verification');
    expect((new CrossValidationServiceHandler() as any).serviceType).toBe('cross_validation');
    expect((new AnfisRoutingServiceHandler() as any).serviceType).toBe('anfis_routing');
  });
});
