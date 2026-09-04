/**
 * A probe that could not run must never be graded.
 *
 * THE DEFECT. `sendToAgent` returned PROSE for three conditions in which no
 * model was ever consulted — no adapter routed, no API key configured, or the
 * completion threw — and that prose was handed straight to `evaluateResponse`.
 *
 * For an `expected: false` probe, `evaluateResponse` answers "correct" when the
 * response contains "no". `'No API key configured'.toLowerCase()` contains "no".
 * So a MISSING API KEY was graded as a correct answer. The empty string returned
 * on a thrown completion failed every probe, so a provider outage read as an
 * agent that had forgotten how to think.
 *
 * Neither is a capability measurement, and both fed a pass rate that gates
 * `repid_agents.lifecycle_status` and is asserted verbatim in a learning event.
 *
 * ON BLAST RADIUS, stated precisely because overstating it is its own error:
 * only 1 of the 9 declared probes is `expected: false`, and `runResumeChecks`
 * needs 0.8 to resume — so the fabricated pass could NOT on its own resume an
 * agent. That is an accident of the current test mix, not a guard. Add a second
 * negative probe and it can. The grading was wrong regardless, which is why it
 * is fixed at the source rather than left resting on a ratio.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  },
}));

jest.mock('../src/providers/router', () => ({
  routeRequest: async () => (globalThis as any).__capRoute,
}));

import { sendToAgent, evaluateResponse } from '../src/services/capability-assessment';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('capability probes: NOT_CHECKED is never graded', () => {
  it('the grader really does score the old sentinel as CORRECT (why null is required)', () => {
    // Not a hypothetical. This is the exact string `sendToAgent` used to return
    // when no API key was configured, and the exact probe polarity it met.
    expect(evaluateResponse('No API key configured', false)).toBe(true);
    // And the outage sentinel failed everything, including probes it should pass.
    expect(evaluateResponse('', true)).toBe(false);
  });

  it('returns null — not prose — when no adapter can be routed', async () => {
    (globalThis as any).__capRoute = { adapter: null };
    await expect(sendToAgent('trinity-x', 'Is the Earth round?', 'factual_verification')).resolves.toBeNull();
  });

  it('returns null when the adapter has no API key', async () => {
    (globalThis as any).__capRoute = { adapter: { name: 'openai', complete: async () => ({ answer: 'yes' }) } };
    delete process.env.OPENAI_API_KEY;
    await expect(sendToAgent('trinity-x', 'Is the Earth round?', 'factual_verification')).resolves.toBeNull();
  });

  it('returns null when the completion throws', async () => {
    (globalThis as any).__capRoute = {
      adapter: {
        name: 'openai',
        complete: async () => {
          throw new Error('provider 503');
        },
      },
    };
    process.env.OPENAI_API_KEY = 'sk-test';
    await expect(sendToAgent('trinity-x', 'Is the Earth round?', 'factual_verification')).resolves.toBeNull();
  });

  it('still returns the real answer when the probe actually runs', async () => {
    // The guard must not swallow working probes — otherwise nothing is ever
    // assessed and the gate is closed for the wrong reason.
    (globalThis as any).__capRoute = {
      adapter: { name: 'openai', complete: async () => ({ answer: 'Yes, the Earth is round.' }) },
    };
    process.env.OPENAI_API_KEY = 'sk-test';
    const r = await sendToAgent('trinity-x', 'Is the Earth round?', 'factual_verification');
    expect(r).toBe('Yes, the Earth is round.');
    expect(evaluateResponse(r as string, true)).toBe(true);
  });

  it('no sentinel string survives that the grader could score', async () => {
    // The property that matters, independent of which sentinels existed: every
    // not-checked path yields null, and null is not gradeable input.
    for (const route of [
      { adapter: null },
      { adapter: { name: 'openai', complete: async () => ({ answer: 'x' }) } }, // no key below
    ]) {
      (globalThis as any).__capRoute = route;
      delete process.env.OPENAI_API_KEY;
      const r = await sendToAgent('trinity-x', 'Did humans evolve from chimpanzees?', 'factual_verification');
      expect(r).toBeNull();
      expect(typeof r).not.toBe('string');
    }
  });
});
