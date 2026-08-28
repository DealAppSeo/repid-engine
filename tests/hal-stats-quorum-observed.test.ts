/**
 * The public quorum count must be what ANSWERED, not what was configured (2026-08-28).
 *
 * MEASURED, on the live service, and it was a false claim on a public surface.
 * `GET /api/v1/hal/stats` reported:
 *
 *     quorum_providers: 6, quorum_families: 6,
 *     quorum_family_names: [openai, glm, deepseek, gemini, mistral, qwen]
 *
 * while a live `/hal/evaluate` on the SAME service answered with four families and reported
 * glm's provider failing every call against a model its vendor had archived eleven days
 * earlier. The consumer renders this number as "N families cross-examine every claim", so the
 * site was advertising verification that was not happening.
 *
 * The cause was one word: it counted `buildFactCheckProviders().length` — the set we ASK — as
 * though it were the set that ANSWERS. For most systems that is a cosmetic drift. For this one
 * it is the differentiator being overstated on the page that sells it.
 *
 * WHY A QUIET WINDOW MUST NOT READ AS ZERO. Nobody calling HAL for an hour is not the same as
 * nothing working, and reporting 0 families then would be the identical error pointed the
 * other way. So an absent measurement falls back to the configured set and labels itself
 * `basis: 'configured'` — the reader is told which of the two they are looking at, every time.
 *
 * These tests exercise the response shape through the real route with the ledger mocked,
 * because the property worth pinning is the ARITHMETIC — which providers get counted — and
 * that is exactly what a refactor would quietly get wrong again.
 */
import express from 'express';
import request from 'supertest';

const ledgerRows: Array<{ provider: string; status: string }> = [];
let ledgerError: unknown = null;

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'llm_call_log') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          limit: () => Promise.resolve({ data: ledgerRows, error: ledgerError }),
        };
        return chain;
      }
      // Every other table this route counts — return empty rather than throwing, so the
      // quorum block is what these tests are actually measuring.
      const c: any = {
        select: () => c,
        eq: () => c,
        gte: () => c,
        order: () => c,
        limit: () => Promise.resolve({ data: [], error: null, count: 0 }),
        then: (r: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(r),
      };
      return c;
    },
  },
}));

// Four configured providers spanning four distinct families, so "configured" and "answering"
// can differ by a knowable amount.
jest.mock('../src/hal/fact-check', () => ({
  buildFactCheckProviders: () => [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm', family: 'openai' },
    { name: 'cerebras', endpoint: 'x', apiKey: 'k', model: 'm', family: 'glm' },
    { name: 'gemini', endpoint: 'x', apiKey: 'k', model: 'm', family: 'gemini' },
    { name: 'mistral', endpoint: 'x', apiKey: 'k', model: 'm', family: 'mistral' },
  ],
  auditFamilyIndependence: (cfgs: Array<{ family: string }>) => ({
    families: [...new Set(cfgs.map((c) => c.family))],
  }),
}));

import halStatsRouter from '../src/routes/hal-stats';

const app = express();
app.use('/api/v1', halStatsRouter);

const getStats = async () => (await request(app).get('/api/v1/hal/stats')).body;

beforeEach(() => {
  ledgerRows.length = 0;
  ledgerError = null;
});

describe('the headline count is what answered', () => {
  it('THE REGRESSION: a configured provider that never answered is not counted', async () => {
    // Exactly the production shape: cerebras asked repeatedly, never succeeded.
    ledgerRows.push(
      { provider: 'groq', status: 'success' },
      { provider: 'gemini', status: 'success' },
      { provider: 'mistral', status: 'success' },
      { provider: 'cerebras', status: 'failed' },
      { provider: 'cerebras', status: 'failed' },
    );
    const b = await getStats();
    expect(b.quorum_providers).toBe(3);
    expect(b.quorum_families).toBe(3);
    expect(b.quorum_family_names).not.toContain('glm');
    expect(b.quorum_health.basis).toBe('measured');
    expect(b.quorum_health.configured_providers).toBe(4);
    expect(b.quorum_health.answering_providers).toBe(3);
  });

  it('names the silent one, so the gap is actionable and not merely visible', async () => {
    ledgerRows.push(
      { provider: 'groq', status: 'success' },
      { provider: 'cerebras', status: 'failed' },
      { provider: 'cerebras', status: 'failed' },
    );
    const b = await getStats();
    const silent = b.quorum_health.not_answering;
    expect(silent.map((s: { provider: string }) => s.provider)).toContain('cerebras');
    expect(silent.find((s: { provider: string }) => s.provider === 'cerebras').calls_failed).toBe(2);
  });

  it('a provider that answered even once counts, since one voice is one voice', async () => {
    ledgerRows.push(
      { provider: 'groq', status: 'success' },
      { provider: 'cerebras', status: 'failed' },
      { provider: 'cerebras', status: 'success' },
    );
    const b = await getStats();
    expect(b.quorum_providers).toBe(2);
    expect(b.quorum_family_names).toContain('glm');
  });
});

describe('a quiet window is NOT zero families', () => {
  it('THE OTHER DIRECTION: no calls falls back to configured and says so', async () => {
    // Nobody called HAL in the window. Reporting 0 would be the same lie inverted — and it is
    // the failure a naive "just count successes" fix introduces.
    const b = await getStats();
    expect(b.quorum_providers).toBe(4);
    expect(b.quorum_families).toBe(4);
    expect(b.quorum_health.basis).toBe('configured');
    expect(b.quorum_health.note).toMatch(/NOT a measurement/i);
  });

  it('only failures in the window also falls back rather than claiming zero', async () => {
    ledgerRows.push({ provider: 'cerebras', status: 'failed' });
    const b = await getStats();
    expect(b.quorum_health.basis).toBe('configured');
    expect(b.quorum_providers).toBeGreaterThan(0);
  });

  it('a ledger read error does not silently become a measurement', async () => {
    ledgerError = { message: 'db down' };
    const b = await getStats();
    expect(b.quorum_health.basis).toBe('configured');
  });
});

describe('the reader can always tell which number they are holding', () => {
  it('basis is always present, and is one of the two honest values', async () => {
    ledgerRows.push({ provider: 'groq', status: 'success' });
    const measured = await getStats();
    ledgerRows.length = 0;
    const fallback = await getStats();
    expect(['measured', 'configured']).toContain(measured.quorum_health.basis);
    expect(['measured', 'configured']).toContain(fallback.quorum_health.basis);
    expect(measured.quorum_health.basis).not.toBe(fallback.quorum_health.basis);
  });
});
