/**
 * HAL fact-check call attribution — llm_call_log.agent_id (2026-08-28).
 *
 * WHY THIS EXISTS, MEASURED NOT ASSUMED. Rows tagged 'hal_fact_check' are ~99.8% of
 * `llm_call_log`, and effectively none of them carry an agent_id, because this was the one
 * high-volume call site that never passed an agent. The two sites that DO pass one —
 * pcp_validation and the router — are a rounding error by comparison. So "which agent burned
 * this latency / this spend" was unanswerable for essentially the entire ledger, and RepID
 * weighting that depends on per-agent latency had nothing to read.
 *
 * ATTRIBUTION IS FORWARD-ONLY. No other table maps call_id or quorum_id back to an agent,
 * so the historical rows cannot be backfilled — that was established independently
 * before this change and is not a gap this test can close. What it can do is stop the
 * hole growing, and fail if anyone re-opens it.
 *
 * THE SECOND TEST IS THE LOAD-BEARING ONE. It pins that an ABSENT agent stays absent.
 * The tempting "fix" for a low attribution percentage is to stamp something — a session
 * id, a placeholder, the string 'unknown' — which would move the number to 100% while
 * making the column meaningless. A null here is the honest value, and the public
 * /hal/evaluate route (anonymous callers, no agent) must keep producing it.
 */

// Mock the DB so importing fact-check (→ billing/log-call → db → config) doesn't need live Supabase.
// The insert spy is what these tests read: it captures the exact row that would be written.
const inserted: any[] = [];
jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      insert: (row: any) => {
        inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

import { factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';

const AGENT = '11111111-2222-4333-8444-555555555555';

const pool: FactCheckProviderCfg[] = [
  { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b-instant' },
  { name: 'deepseek', endpoint: 'z', apiKey: 'k', model: 'deepseek-chat' },
];

/** Only the rows this feature is about — the quorum's own provider calls. */
const factCheckRows = () => inserted.filter((r) => r?.task_hint === 'hal_fact_check');

describe('fact-check stamps llm_call_log.agent_id', () => {
  const originalFetch = global.fetch;
  const saveOrder = process.env.HAL_QUORUM_COST_ORDERED;

  beforeEach(() => {
    inserted.length = 0;
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ verdict: 'TRUE', confidence: 90 }) } }],
      }),
    }));
    process.env.HAL_QUORUM_COST_ORDERED = 'false'; // call all providers, simpler assertions
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (saveOrder === undefined) delete process.env.HAL_QUORUM_COST_ORDERED;
    else process.env.HAL_QUORUM_COST_ORDERED = saveOrder;
  });

  it('every provider call in the quorum carries the agentId it was given', async () => {
    await factCheck('the sky is blue', pool, { agentId: AGENT });

    const rows = factCheckRows();
    expect(rows.length).toBeGreaterThan(0); // a zero-row scan would pass vacuously
    for (const row of rows) {
      expect(row.agent_id).toBe(AGENT);
    }
  });

  it('an ABSENT agentId stays absent — no placeholder is invented', async () => {
    // THE LOAD-BEARING ASSERTION. An honest null is what tells you the public endpoint
    // was the caller. A fabricated id would raise attributed_pct while destroying the
    // only thing the column is for.
    await factCheck('the sky is blue', pool);

    const rows = factCheckRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.agent_id).toBeUndefined();
    }
  });

  it('agent_id is stamped alongside quorum_id, not instead of it', async () => {
    // The two correlate different things — quorum_id groups one fact-check's provider
    // calls, agent_id says whose evaluation it was. Losing either while adding the other
    // would trade one blind spot for another.
    await factCheck('the sky is blue', pool, { agentId: AGENT });

    for (const row of factCheckRows()) {
      expect(row.agent_id).toBe(AGENT);
      expect(typeof row.quorum_id).toBe('string');
      expect(row.quorum_id.length).toBeGreaterThan(0);
    }
  });
});
