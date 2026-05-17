import { applyServiceFulfilledDeltas, applyServiceSatisfiedDeltas } from '../../src/services/validation-repid-delta';

jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn().mockResolvedValue({})
}));

describe('Service Deltas', () => {
  it('applies fulfilled deltas', async () => {
    await applyServiceFulfilledDeltas({
      id: 'c-1',
      service_id: 's-1',
      provider_agent_id: 'p-1',
      buyer_agent_id: 'b-1'
    });
  });

  it('applies satisfied deltas', async () => {
    await applyServiceSatisfiedDeltas({
      id: 'c-1',
      provider_agent_id: 'p-1',
      buyer_agent_id: 'b-1'
    }, 0.8);
  });
});
