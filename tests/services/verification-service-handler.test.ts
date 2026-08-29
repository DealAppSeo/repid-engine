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
    runPCP.mockResolvedValue({ score: 0.9, confidence: 0.8, checked: true, validators: ['a', 'b', 'c'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 3 });
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
    // The validators list is non-empty on purpose. This case previously passed
    // `validators: []` with confidence 0.2 — a shape runPCP can no longer produce,
    // because confidence is now averaged over RESPONDERS. A real FAIL means peers
    // answered and were unconvinced; that is what this asserts.
    runPCP.mockResolvedValue({ score: 0.1, confidence: 0.2, checked: true, validators: ['a', 'b'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 2 });
    const out = await (new VerificationServiceHandler() as any).fulfill(contract);
    expect(out.verdict).toBe('FAIL');
    expect(out.patent_marker).toBe('P-001');
  });

  // THE REGRESSION THIS PINS. Break it by making fulfill() return a verdict when
  // `checked` is false and this goes red — which is the whole point, because that
  // is what shipped and it disputed twelve consecutive living-proof runs as
  // `provider_at_fault` for work no validator ever assessed.
  it('no validator answered → THROWS NOT_CHECKED, never a FAIL verdict', async () => {
    runPCP.mockResolvedValue({
      score: 0, confidence: 0, checked: false,
      validators: [], attemptedValidators: ['mock-a', 'mock-b', 'mock-c'],
      attemptedCount: 3, respondedCount: 0,
    });
    await expect((new VerificationServiceHandler() as any).fulfill(contract))
      .rejects.toThrow(/NOT_CHECKED/);
  });

  it('an unanswered check never blames the provider', async () => {
    runPCP.mockResolvedValue({
      score: 0, confidence: 0, checked: false,
      validators: [], attemptedValidators: ['mock-a'], attemptedCount: 1, respondedCount: 0,
    });
    let err: Error | undefined;
    try { await (new VerificationServiceHandler() as any).fulfill(contract); }
    catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not the provider's fault/);
    expect(err!.message).not.toMatch(/FAIL/);
  });
});
