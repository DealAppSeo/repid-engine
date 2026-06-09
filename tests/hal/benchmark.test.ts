/**
 * CC3 — external-benchmark ingestion + scoring. Validates the HaluEval/FEVER parsers and the
 * confusion-matrix math with an injected (deterministic) HAL evaluate fn — no network/providers.
 * The example records here exercise the PARSERS; they are not benchmark measurement data.
 */
import { normalizeHaluEval, normalizeFever, scoreBenchmark, type HalEvalLike } from '../../src/hal/benchmark';

describe('normalizeHaluEval', () => {
  it('QA record -> 2 items (right=non-halluc, hallucinated=halluc) with context', () => {
    const items = normalizeHaluEval({ knowledge: 'k', question: 'Who painted the Mona Lisa?', right_answer: 'Leonardo da Vinci', hallucinated_answer: 'Pablo Picasso' }, 0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ goldHallucination: false, statement: 'Leonardo da Vinci' });
    expect(items[1]).toMatchObject({ goldHallucination: true, statement: 'Pablo Picasso' });
    expect(items[0].context).toContain('Mona Lisa');
  });
  it('general record -> 1 item with yes/no gold', () => {
    expect(normalizeHaluEval({ user_query: 'q', chatgpt_response: 'r', hallucination: 'yes' }, 1)[0].goldHallucination).toBe(true);
    expect(normalizeHaluEval({ user_query: 'q', chatgpt_response: 'r', hallucination: 'No' }, 2)[0].goldHallucination).toBe(false);
  });
  it('unrecognized record -> dropped (empty)', () => {
    expect(normalizeHaluEval({ foo: 'bar' }, 3)).toHaveLength(0);
  });
});

describe('normalizeFever', () => {
  it('SUPPORTS -> non-halluc, REFUTES -> halluc, NEI -> dropped', () => {
    expect(normalizeFever({ claim: 'c', label: 'SUPPORTS' }, 0)[0].goldHallucination).toBe(false);
    expect(normalizeFever({ claim: 'c', label: 'REFUTES' }, 1)[0].goldHallucination).toBe(true);
    expect(normalizeFever({ claim: 'c', label: 'NOT ENOUGH INFO' }, 2)).toHaveLength(0);
  });
});

describe('scoreBenchmark', () => {
  it('computes confusion matrix + F1 (vetoed = predicted hallucination)', async () => {
    const items = [
      { id: 'a', dataset: 'fever' as const, statement: 'false claim', goldHallucination: true },  // should veto
      { id: 'b', dataset: 'fever' as const, statement: 'true claim', goldHallucination: false },   // should clean
      { id: 'c', dataset: 'fever' as const, statement: 'opinion', goldHallucination: false },       // flagged = not halluc
    ];
    // deterministic stand-in: 'false claim' -> vetoed, else clean/flagged
    const evaluate = async (text: string): Promise<HalEvalLike> =>
      text.includes('false') ? { decision: 'vetoed', hal_score: 0.9 }
      : text.includes('opinion') ? { decision: 'flagged', hal_score: 0.5 }
      : { decision: 'clean', hal_score: 0.1 };
    const s = await scoreBenchmark(items, evaluate);
    expect(s).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 2 });
    expect(s.precision).toBeCloseTo(1, 5);
    expect(s.recall).toBeCloseTo(1, 5);
    expect(s.f1).toBeCloseTo(1, 5);
  });

  it('a flagged opinion does NOT count as a hallucination prediction', async () => {
    const items = [{ id: 'x', dataset: 'halueval' as const, statement: 'subjective', goldHallucination: false }];
    const evaluate = async (): Promise<HalEvalLike> => ({ decision: 'flagged', hal_score: 0.5 });
    const s = await scoreBenchmark(items, evaluate);
    expect(s.tn).toBe(1); // flagged + gold non-halluc = true negative (correct)
    expect(s.fp).toBe(0);
  });
});
