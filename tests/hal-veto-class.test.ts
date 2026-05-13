import { runScoreEvent } from '../src/scoring/pipeline';
import * as evaluateLib from '../src/hal/lib/evaluate';

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { id: 'agent-1', current_repid: 1000, tier: 'A', vesting_cliff_ends_at: null }, error: null }) }),
        _count: true,
        then: (resolve: any) => resolve({ data: null, error: null, count: 0 }),
      }),
      insert: (payload: any) => {
        (global as any).__pipInsertCalls.push(payload);
        const p = Promise.resolve({ data: { id: 1 }, error: null }) as any;
        p.select = () => ({ single: async () => ({ data: { id: 1 }, error: null }) });
        return p;
      },
      update: () => ({ eq: async () => ({ data: null, error: null }) })
    })
  }
}));

describe('veto_class assignments in pipeline', () => {
  beforeEach(() => {
    (global as any).__pipInsertCalls = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('FACTUAL_ERROR assigned when evidence_quality < 0.35', async () => {
    jest.spyOn(evaluateLib, 'evaluate').mockResolvedValueOnce({
      hal_score: 0.9,
      vetoed: true,
      signals: { evidence_quality: 0.2, agreement_score: 0.9 } as any,
      threshold: 0.25,
      formula: '',
      strictness: 4,
    });

    await runScoreEvent({ agent_id: 'agent-1', prompt: 'a', answer: 'b' });
    const insert = (global as any).__pipInsertCalls[0];
    expect(insert.veto_class).toBe('FACTUAL_ERROR');
  });

  test('BFT_CONTRADICTION assigned when agreement_score < 0.4', async () => {
    jest.spyOn(evaluateLib, 'evaluate').mockResolvedValueOnce({
      hal_score: 0.9,
      vetoed: true,
      signals: { evidence_quality: 0.8, agreement_score: 0.2 } as any,
      threshold: 0.25,
      formula: '',
      strictness: 4,
    });

    await runScoreEvent({ agent_id: 'agent-1', prompt: 'a', answer: 'b' });
    const insert = (global as any).__pipInsertCalls[0];
    expect(insert.veto_class).toBe('BFT_CONTRADICTION');
  });

  test('UNKNOWN assigned when neither threshold is crossed but decision is vetoed/flagged', async () => {
    jest.spyOn(evaluateLib, 'evaluate').mockResolvedValueOnce({
      hal_score: 0.5,
      vetoed: true,
      signals: { evidence_quality: 0.9, agreement_score: 0.9 } as any,
      threshold: 0.25,
      formula: '',
      strictness: 4,
    });

    await runScoreEvent({ agent_id: 'agent-1', prompt: 'a', answer: 'b' });
    const insert = (global as any).__pipInsertCalls.find((c: any) => 'veto_class' in c);
    expect(insert.veto_class).toBe('UNKNOWN');
  });

  test('veto_class is null when decision is clean', async () => {
    jest.spyOn(evaluateLib, 'evaluate').mockResolvedValueOnce({
      hal_score: 0.1,
      vetoed: false,
      signals: { evidence_quality: 0.9, agreement_score: 0.9 } as any,
      threshold: 0.25,
      formula: '',
      strictness: 4,
    });

    await runScoreEvent({ agent_id: 'agent-1', prompt: 'a', answer: 'b' });
    const insert = (global as any).__pipInsertCalls[0];
    expect(insert.veto_class).toBeNull();
  });
});
