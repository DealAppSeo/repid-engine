/**
 * S-R5 — family-aware quorum. Two hosts serving the SAME base model are ONE independent vote, so a
 * penalty needs >= 2 distinct FAMILIES, not 2 hosts. (a) familyOf model→family map; (b) the pipeline
 * quorum-gate counts families_used. Revertible via HAL_QUORUM_FAMILY_AWARE.
 */
import { familyOf } from '../src/hal/fact-check';

describe('familyOf model→family', () => {
  it('groq-Llama and cerebras-Llama are the SAME family', () => {
    expect(familyOf('llama-3.1-8b-instant')).toBe('llama');
    expect(familyOf('llama3.1-8b')).toBe('llama');
    expect(familyOf('llama-3.1-8b-instant')).toBe(familyOf('llama3.1-8b'));
  });
  it('distinct families map distinctly', () => {
    expect(familyOf('zai-glm-4.7')).toBe('glm');
    expect(familyOf('deepseek-chat')).toBe('deepseek');
    expect(familyOf('accounts/fireworks/models/kimi-k2p5')).toBe('kimi');
    expect(familyOf('gemini-2.0-flash')).toBe('gemini');
    expect(familyOf('mistral-small-latest')).toBe('mistral');
    expect(familyOf('qwen-plus')).toBe('qwen');
    expect(new Set(['glm', 'deepseek', 'kimi', 'gemini', 'mistral', 'qwen'].map(() => 0)).size).toBe(1);
  });
});

// --- pipeline quorum-gate uses families_used ---
(global as any).__pipAgentRow = null;
(global as any).__pipInsertCalls = [];
(global as any).__pipUpdateCalls = [];
jest.mock('../src/db', () => ({
  db: {
    from: (t: string) => {
      if (t === 'repid_agents') return { select: () => ({ eq: () => ({ single: async () => ({ data: (global as any).__pipAgentRow, error: (global as any).__pipAgentRow ? null : { message: 'nf' } }) }) }), update: (p: any) => ({ eq: () => { (global as any).__pipUpdateCalls.push(p); return Promise.resolve({ data: null, error: null }); } }) };
      if (t === 'repid_score_events') return { select: (_c?: string, o?: any) => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }) }) }), insert: (p: any) => ({ select: () => ({ single: async () => { (global as any).__pipInsertCalls.push(p); return { data: { id: 1 }, error: null }; } }) }) };
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    }, rpc: async () => ({ data: null, error: null }),
  },
}));
jest.mock('../src/hal/service', () => ({ halService: { evaluate: jest.fn() } }));
import { runScoreEvent } from '../src/scoring/pipeline';
import { halService } from '../src/hal/service';
const AGENT = '11111111-2222-4333-8444-555555555555';
const evalMock = halService.evaluate as jest.Mock;

describe('pipeline family-aware quorum-gate', () => {
  beforeEach(() => {
    (global as any).__pipAgentRow = { id: AGENT, current_repid: 1000, tier: 'ESTABLISHED', vesting_cliff_ends_at: null };
    (global as any).__pipInsertCalls = []; (global as any).__pipUpdateCalls = [];
    evalMock.mockReset(); process.env.HAL_STRICTNESS = '2';
    delete process.env.HAL_PENALTY_REQUIRES_QUORUM; delete process.env.HAL_QUORUM_FAMILY_AWARE; delete process.env.HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION;
  });
  afterAll(() => { delete process.env.HAL_STRICTNESS; });
  const run = () => runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: 'a', provider_used: 'deepinfra' });

  test('2 hosts but 1 FAMILY (groq+cerebras both Llama) → NO drain', async () => {
    evalMock.mockResolvedValue({ hal_score: 0.9, decision: 'vetoed', mode: 'fact-check', strictness: 2, signals: { providers_used: 2, families_used: 1, families: ['llama'] } });
    const r = await run();
    expect(r.repid_delta_applied).toBe(0);
    const ins = (global as any).__pipInsertCalls[0];
    expect(ins.metadata.quorum_met).toBe(false);
    expect(ins.metadata.quorum_families_used).toBe(1);
    expect(ins.metadata.suppressed_reason).toBe('quorum_unavailable');
  });

  test('2 distinct FAMILIES → penalty APPLIES with family evidence', async () => {
    evalMock.mockResolvedValue({ hal_score: 0.9, decision: 'vetoed', mode: 'fact-check', strictness: 2, signals: { providers_used: 2, families_used: 2, families: ['llama', 'deepseek'] } });
    const r = await run();
    expect(r.repid_delta_applied).toBe(-10);
    const ins = (global as any).__pipInsertCalls[0];
    expect(ins.metadata.quorum_met).toBe(true);
    expect(ins.metadata.quorum_families_used).toBe(2);
    expect(ins.metadata.quorum_families).toEqual(['llama', 'deepseek']);
  });

  test('family-aware OFF → reverts to host count (2 hosts → drain)', async () => {
    process.env.HAL_QUORUM_FAMILY_AWARE = 'false';
    evalMock.mockResolvedValue({ hal_score: 0.9, decision: 'vetoed', mode: 'fact-check', strictness: 2, signals: { providers_used: 2, families_used: 1, families: ['llama'] } });
    const r = await run();
    expect(r.repid_delta_applied).toBe(-10); // host count = 2 → quorum met
  });
});
