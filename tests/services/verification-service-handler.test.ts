// Phase 2.10 — VerificationServiceHandler (P-001). runPCP mocked.
const runPCP = jest.fn();
jest.mock('../../src/services/pcp-validator', () => ({ runPCP: (...a: any[]) => runPCP(...a) }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../../src/db', () => ({ db: {} }));

import { VerificationServiceHandler } from '../../src/services/verification-service-handler';

const contract: any = {
  id: 'c1', provider_agent_id: 'p1', buyer_agent_id: 'buyer1', status: 'escrowed',
  payload: { content: 'The capital of France is Paris.', criteria: ['accuracy'], title: 't' },
};

describe('VerificationServiceHandler', () => {
  it('shapes synthetic taskData (claimed_by=buyer) and emits P-001 PASS', async () => {
    runPCP.mockResolvedValue({ score: 0.9, confidence: 0.8, validators: ['a', 'b', 'c'] });
    const out = await (new VerificationServiceHandler() as any).fulfill(contract);
    const passed = runPCP.mock.calls[0][0];
    expect(passed.claimed_by).toBe('buyer1');
    expect(passed.result).toBe('The capital of France is Paris.');
    expect(out.verdict).toBe('PASS');
    expect(out.confidence).toBe(0.8);
    expect(out.validator_count).toBe(3);
    expect(out.patent_marker).toBe('P-001');
  });

  it('confidence < 0.5 → FAIL (honest verdict, no escalation)', async () => {
    runPCP.mockResolvedValue({ score: 0.1, confidence: 0.2, validators: [] });
    const out = await (new VerificationServiceHandler() as any).fulfill(contract);
    expect(out.verdict).toBe('FAIL');
    expect(out.patent_marker).toBe('P-001');
  });
});
