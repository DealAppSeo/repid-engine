/**
 * Unit tests for FactCheckServiceHandler — exercises the aggregation /
 * verdict-mapping logic without making real LLM calls (Groq is mocked).
 *
 * The DB layer is also mocked to a small validator pool so the test runs
 * without Supabase credentials.
 */

import type { ServiceContractRow } from '../src/types';

// Mock the validator pool DB call before importing the handler.
jest.mock('../src/db', () => {
  return {
    db: {
      from: jest.fn(() => ({
        select: jest.fn().mockResolvedValue({
          data: [
            { id: 'val-A-id', agent_name: 'val-A', current_repid: 2000 },
            { id: 'val-B-id', agent_name: 'val-B', current_repid: 1500 },
            { id: 'val-C-id', agent_name: 'val-C', current_repid: 1000 },
            { id: 'buyer-X', agent_name: 'buyer-X', current_repid: 800 },
            { id: 'provider-Y', agent_name: 'provider-Y', current_repid: 9000 },
          ],
          error: null,
        }),
      })),
    },
  };
});

// Mock selectWeightedValidators to deterministic ordering (test-only).
jest.mock('../src/services/pcp-validator', () => {
  const actual = jest.requireActual('../src/services/pcp-validator');
  return {
    ...actual,
    selectWeightedValidators: (agents: any[], count: number) =>
      agents.slice(0, count),
  };
});

const fetchMock = jest.fn();
// @ts-expect-error - global fetch shimmed for the unit test
global.fetch = fetchMock;

import { FactCheckServiceHandler } from '../src/services/fact-check-service-handler';

const baseContract = (claim: string): ServiceContractRow => ({
  id: 'contract-test-1',
  provider_agent_id: 'provider-Y',
  buyer_agent_id: 'buyer-X',
  payload: { claim },
  status: 'escrowed',
});

const groqResponse = (verdict: string, confidence: number, evidence = 'test') => ({
  ok: true,
  json: async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            fact_verdict: verdict,
            confidence,
            evidence,
          }),
        },
      },
    ],
  }),
});

describe('FactCheckServiceHandler', () => {
  const handler = new FactCheckServiceHandler();

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.GROQ_API_KEY = 'test-key';
  });

  it('returns verdict=PASS and fact_verdict=TRUE when all validators agree TRUE', async () => {
    fetchMock
      .mockResolvedValueOnce(groqResponse('TRUE', 0.9, 'definitively true'))
      .mockResolvedValueOnce(groqResponse('TRUE', 0.8, 'well-established'))
      .mockResolvedValueOnce(groqResponse('TRUE', 0.7, 'agreed'));

    const result = await (handler as any).fulfill(
      baseContract('Water boils at 100°C at sea level.')
    );

    expect(result.verdict).toBe('PASS');
    expect(result.fact_verdict).toBe('TRUE');
    expect(result.score).toBe(1);
    expect(result.live_validator_count).toBe(3);
    expect(result.tallies).toEqual({ TRUE: 3, FALSE: 0, AMBIGUOUS: 0 });
    expect(result.evidence_note).toContain('definitively true');
  });

  it('returns fact_verdict=FALSE when all validators agree FALSE', async () => {
    fetchMock
      .mockResolvedValueOnce(groqResponse('FALSE', 0.95, 'contradicts known science'))
      .mockResolvedValueOnce(groqResponse('FALSE', 0.9, 'physically impossible'))
      .mockResolvedValueOnce(groqResponse('FALSE', 0.85, 'no such evidence'));

    const result = await (handler as any).fulfill(
      baseContract('The sun orbits the earth.')
    );

    expect(result.verdict).toBe('PASS');
    expect(result.fact_verdict).toBe('FALSE');
    expect(result.tallies).toEqual({ TRUE: 0, FALSE: 3, AMBIGUOUS: 0 });
  });

  it('returns fact_verdict=AMBIGUOUS when validators split TRUE vs FALSE', async () => {
    fetchMock
      .mockResolvedValueOnce(groqResponse('TRUE', 0.6, 'one reading'))
      .mockResolvedValueOnce(groqResponse('FALSE', 0.6, 'another reading'))
      .mockResolvedValueOnce(groqResponse('AMBIGUOUS', 0.5, 'depends on definition'));

    const result = await (handler as any).fulfill(
      baseContract('A hot dog is a sandwich.')
    );

    // Tally: TRUE=1, FALSE=1, AMBIGUOUS=1 → 3-way tie collapses to AMBIGUOUS.
    expect(result.verdict).toBe('PASS');
    expect(result.fact_verdict).toBe('AMBIGUOUS');
  });

  it('returns verdict=FAIL when every validator call errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('groq down'))
      .mockRejectedValueOnce(new Error('groq down'))
      .mockRejectedValueOnce(new Error('groq down'));

    const result = await (handler as any).fulfill(baseContract('claim'));

    expect(result.verdict).toBe('FAIL');
    expect(result.fact_verdict).toBeNull();
    expect(result.live_validator_count).toBe(0);
  });

  it('throws on missing claim', async () => {
    await expect((handler as any).fulfill(baseContract(''))).rejects.toThrow(/non-empty/);
  });

  it('throws on missing GROQ_API_KEY', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(
      (handler as any).fulfill(baseContract('valid claim'))
    ).rejects.toThrow(/GROQ_API_KEY/);
  });

  it('breaks a 2-vs-1 tie in favor of the majority, not AMBIGUOUS', async () => {
    fetchMock
      .mockResolvedValueOnce(groqResponse('TRUE', 0.8, 'a'))
      .mockResolvedValueOnce(groqResponse('TRUE', 0.7, 'b'))
      .mockResolvedValueOnce(groqResponse('FALSE', 0.9, 'c'));

    const result = await (handler as any).fulfill(baseContract('claim'));
    expect(result.fact_verdict).toBe('TRUE');
    expect(result.score).toBeCloseTo(2 / 3, 5);
  });

  it('survives one validator returning an unparseable verdict', async () => {
    fetchMock
      .mockResolvedValueOnce(groqResponse('TRUE', 0.8, 'a'))
      .mockResolvedValueOnce(groqResponse('TRUE', 0.7, 'b'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'gibberish' } }] }),
      });

    const result = await (handler as any).fulfill(baseContract('claim'));
    // 2 live TRUE votes / 2 live = 1.0; ERROR vote excluded from score denom.
    expect(result.fact_verdict).toBe('TRUE');
    expect(result.live_validator_count).toBe(2);
    expect(result.score).toBe(1);
  });
});
