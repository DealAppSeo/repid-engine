// Phase 2.10 — CrossValidationServiceHandler (P-003). PCP/judge/comma mocked.
const runPCP = jest.fn();
const runAdversarialJudge = jest.fn();
const checkPythagoreanComma = jest.fn();
jest.mock('../../src/services/pcp-validator', () => ({ runPCP: (...a: any[]) => runPCP(...a) }));
jest.mock('../../src/services/adversarial-judge', () => ({ runAdversarialJudge: (...a: any[]) => runAdversarialJudge(...a) }));
jest.mock('../../src/hal/cross-llm-client', () => ({ checkPythagoreanComma: (...a: any[]) => checkPythagoreanComma(...a) }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../../src/db', () => ({ db: {} }));

import { CrossValidationServiceHandler } from '../../src/services/cross-validation-service-handler';

const contract: any = {
  id: 'c1', provider_agent_id: 'p1', buyer_agent_id: 'buyer1', status: 'escrowed',
  payload: { content: 'claim text', claimer_provider: 'anthropic', title: 't' },
};

describe('CrossValidationServiceHandler (P-003)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Decision 2: judge receives synthetic taskData with metadata.provider', async () => {
    runPCP.mockResolvedValue({ score: 0.8, confidence: 0.8, validators: ['a', 'b', 'c'] });
    runAdversarialJudge.mockResolvedValue({ verdict: 'APPROVE', confidence: 0.9, critique: 'ok' });
    checkPythagoreanComma.mockReturnValue({ severity: 'none', comma_gap: 0.1, comma_veto: false });
    const out = await (new CrossValidationServiceHandler() as any).fulfill(contract);
    expect(runAdversarialJudge.mock.calls[0][0].metadata.provider).toBe('anthropic');
    expect(out.verdict).toBe('PASS');
    expect(out.patent_marker).toBe('P-003');
    expect(out.comma_veto).toBe(false);
    expect(out.comma_severity).toBe('none');
  });

  it('comma_veto true → VETO verdict', async () => {
    runPCP.mockResolvedValue({ score: 0.8, confidence: 0.8, validators: ['a', 'b', 'c'] });
    runAdversarialJudge.mockResolvedValue({ verdict: 'APPROVE', confidence: 0.9, critique: '' });
    checkPythagoreanComma.mockReturnValue({ severity: 'critical', comma_gap: 0.01, comma_veto: true });
    const out = await (new CrossValidationServiceHandler() as any).fulfill(contract);
    expect(out.verdict).toBe('VETO');
    expect(out.comma_veto).toBe(true);
  });

  it('Decision 5: < 3 validators → comma skipped, insufficient_validators', async () => {
    runPCP.mockResolvedValue({ score: 0.6, confidence: 0.6, validators: ['only-one'] });
    runAdversarialJudge.mockResolvedValue({ verdict: 'APPROVE', confidence: 0.7, critique: '' });
    const out = await (new CrossValidationServiceHandler() as any).fulfill(contract);
    expect(checkPythagoreanComma).not.toHaveBeenCalled();
    expect(out.comma_veto).toBeNull();
    expect(out.comma_gap).toBeNull();
    expect(out.comma_severity).toBe('insufficient_validators');
    expect((out.metadata as any).comma_layer_inactive).toBe(true);
    expect((out.metadata as any).validator_count).toBe(1);
    expect(out.verdict).toBe('PASS'); // PCP+judge only, comma inactive
    expect(out.patent_marker).toBe('P-003');
  });
});
