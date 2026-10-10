/**
 * Pipeline-level grounding root-currency tests (item 5/6 zero-callers gap).
 *
 * `computeGroundingSignal` accepts `current_memory_root` for currency checking,
 * but pipeline.ts had zero callers passing it. This file verifies the pipeline
 * now fetches the agent's committed root from `agent_memory_roots` and passes it,
 * producing `root_current:true/false/null` in `metadata.grounding` accordingly.
 *
 * The pure-function cases (stale replay, no root supplied, matching root) are
 * already covered in `hal-grounding-root-currency.test.ts`. These tests add the
 * integration layer: pipeline → DB fetch → computeGroundingSignal.
 */

(global as any)._api_key_versions_table_checked = true;

// Controllable test state
(global as any).__grcAgentRow = null;
(global as any).__grcMemoryRoot = null;    // null = no row; string = the root to return
(global as any).__grcMemoryRootError = false; // true = DB error on root fetch
(global as any).__grcInsertCalls = [] as unknown[];

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => {
      if (tableName === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: (global as any).__grcAgentRow ?? null,
                error: (global as any).__grcAgentRow ? null : { message: 'not found' },
              }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      if (tableName === 'agent_memory_roots') {
        const err = (global as any).__grcMemoryRootError;
        const root = (global as any).__grcMemoryRoot;
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () =>
                    err
                      ? { data: null, error: { message: 'db error' } }
                      : { data: root != null ? { root } : null, error: null },
                }),
              }),
            }),
          }),
        };
      }
      if (tableName === 'repid_score_events') {
        return {
          select: (_cols?: string, opts?: any) => {
            const isHead = !!(opts && opts.head);
            return {
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
                then: (resolve: (v: any) => void) =>
                  resolve({ data: null, error: null, count: isHead ? 0 : null }),
              }),
            };
          },
          insert: (payload: unknown) => ({
            select: () => ({
              single: async () => {
                (global as any).__grcInsertCalls.push(payload);
                return { data: { id: 99 }, error: null };
              },
            }),
          }),
        };
      }
      // Default no-op for trinity_agent_logs, hal_classifications, repid_proof_queue, etc.
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }), limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

import { ProofCarryingMemory, emitGroundedAnswer } from '../src/memory/proof-carrying-memory';
import { runScoreEvent } from '../src/scoring/pipeline';

const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const AGENT_ROW = {
  id: AGENT_ID,
  current_repid: 1000,
  tier: 'ESTABLISHED',
  vesting_cliff_ends_at: null,
  activity_30d: 5,
};

function makePCA() {
  const mem = new ProofCarryingMemory();
  const v = mem.add({ content: 'fact F1', source_id: 'src-1', source_repid: 1500, hal_verdict: 'clean', epoch: 1 });
  const pca = emitGroundedAnswer('citing F1', mem, [v]);
  return { mem, pca, currentRoot: mem.root() };
}

beforeEach(() => {
  (global as any).__grcAgentRow = null;
  (global as any).__grcMemoryRoot = null;
  (global as any).__grcMemoryRootError = false;
  (global as any).__grcInsertCalls = [];
});

describe('pipeline grounding root-currency wiring', () => {
  test('no PCA supplied → applicable:false, root_current:null regardless of stored root', async () => {
    (global as any).__grcAgentRow = AGENT_ROW;
    (global as any).__grcMemoryRoot = '0xdeadbeef';

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'hello',
      answer: 'world',
      provider_used: 'groq',
      tier_used: '0a',
      model_used: 'llama-3.1-8b-instant',
    });

    const inserted = (global as any).__grcInsertCalls[0] as any;
    expect(inserted?.metadata?.grounding?.applicable).toBe(false);
    expect(inserted?.metadata?.grounding?.root_current).toBeNull();
  });

  test('PCA root matches DB root → root_current:true', async () => {
    (global as any).__grcAgentRow = AGENT_ROW;
    const { pca, currentRoot } = makePCA();
    (global as any).__grcMemoryRoot = currentRoot; // DB returns the same root the PCA asserts

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'citing live fact',
      answer: 'answer',
      provider_used: 'groq',
      tier_used: '0a',
      model_used: 'llama-3.1-8b-instant',
      proof_carrying_answer: pca,
    });

    const inserted = (global as any).__grcInsertCalls[0] as any;
    const g = inserted?.metadata?.grounding;
    expect(g?.applicable).toBe(true);
    expect(g?.root_current).toBe(true);
    expect(g?.grounded).toBe(true);
  });

  test('PCA root is stale (DB root differs) → root_current:false, reason:ungrounded:stale_root', async () => {
    (global as any).__grcAgentRow = AGENT_ROW;
    const { pca, mem } = makePCA();
    // Advance the tree: add another entry so the root changes
    mem.add({ content: 'fact F2', source_id: 'src-2', source_repid: 1500, hal_verdict: 'clean', epoch: 2 });
    (global as any).__grcMemoryRoot = mem.root(); // DB has the NEW root, PCA asserts the old one

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'stale answer',
      answer: 'answer',
      provider_used: 'groq',
      tier_used: '0a',
      model_used: 'llama-3.1-8b-instant',
      proof_carrying_answer: pca,
    });

    const inserted = (global as any).__grcInsertCalls[0] as any;
    const g = inserted?.metadata?.grounding;
    expect(g?.applicable).toBe(true);
    expect(g?.root_current).toBe(false);
    expect(g?.reason).toBe('ungrounded:stale_root');
    expect(g?.would_abstain).toBe(true);
  });

  test('DB error on root fetch → graceful null, scoring unaffected (root_current:null)', async () => {
    (global as any).__grcAgentRow = AGENT_ROW;
    (global as any).__grcMemoryRootError = true;
    const { pca } = makePCA();

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'question',
      answer: 'answer',
      provider_used: 'groq',
      tier_used: '0a',
      model_used: 'llama-3.1-8b-instant',
      proof_carrying_answer: pca,
    });

    const inserted = (global as any).__grcInsertCalls[0] as any;
    const g = inserted?.metadata?.grounding;
    // DB error → root treated as null → root_current:null (honest not-checked)
    expect(g?.applicable).toBe(true);
    expect(g?.root_current).toBeNull();
    // Score event still written (scoring was not broken)
    expect(inserted?.agent_id).toBe(AGENT_ID);
  });
});
