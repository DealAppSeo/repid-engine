/**
 * CodeQL #4 (js/polynomial-redos) and #111 (js/tainted-format-string) in src/routes/route.ts.
 */
import { format } from 'util';
import request from 'supertest';
import express from 'express';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockRejectedValue(new Error('db down')),
  },
}));

import { llmRouter, inferCategory } from '../../src/routes/route';

// The pre-fix function, kept as the oracle: the fix must not change any category.
function oldInferCategory(prompt: string, taskHint?: string): string {
  const s = (prompt + ' ' + (taskHint || '')).toLowerCase();
  if (/classif|yes\/no|true\/false|fact check|is this|simple fact/.test(s)) return 'factual';
  if (/code|bug|fix|function|typescript|python|implement/.test(s)) return 'code';
  if (/creative|story|poem|imagine|write a|generate.*tale/.test(s)) return 'creative';
  if (/math|calculate|equation|prove/.test(s)) return 'math';
  return 'general';
}

describe('inferCategory (CodeQL #4)', () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['Classify this review', undefined, 'factual'],
    ['Is this true?', undefined, 'factual'],
    ['Fix the bug in my TypeScript', undefined, 'code'],
    ['Write a poem about rain', undefined, 'creative'],
    ['Generate a fairy tale', undefined, 'creative'],
    ['GENERATE me a TALE', undefined, 'creative'],
    ['generatetale', undefined, 'creative'],
    ['generate', 'tale', 'creative'],
    ['tale first, then generate', undefined, 'general'],
    ['generate a list\nof every tale', undefined, 'general'],
    ['generate a list\r\nof every tale', undefined, 'general'],
    ['generate\u2028tale', undefined, 'general'],
    ['line one\ngenerate one tale', undefined, 'creative'],
    ['generate x\ngenerate a tale', undefined, 'creative'],
    ['Calculate 2+2', undefined, 'math'],
    ['hello there', undefined, 'general'],
  ];

  test.each(cases)('%j (hint %j) -> %s, same as before the fix', (prompt, hint, expected) => {
    expect(inferCategory(prompt, hint)).toBe(expected);
    expect(inferCategory(prompt, hint)).toBe(oldInferCategory(prompt, hint));
  });

  test('50k chars of repeated "generate" returns in under 50 ms', () => {
    const evil = 'generate'.repeat(6250);
    const t0 = performance.now();
    expect(inferCategory(evil)).toBe('general');
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('agent_id lookup failure log (CodeQL #111)', () => {
  const prevGate = process.env.AGENT_GATE_ENABLED;
  beforeAll(() => { process.env.AGENT_GATE_ENABLED = 'false'; });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.AGENT_GATE_ENABLED;
    else process.env.AGENT_GATE_ENABLED = prevGate;
  });

  test('a % sequence in agent_id is logged literally, not used as a format directive', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.use(llmRouter);

    const res = await request(app).post('/v1/llm/complete').send({ prompt: 'hi', agent_id: 'bot%s%d' });
    expect(res.status).toBe(401);

    const call = warn.mock.calls.find((c) => String(c[0]).startsWith('[route] Failed to resolve agent_id'));
    expect(call).toBeDefined();
    expect(call![0]).toBe('[route] Failed to resolve agent_id UUID for name "%s":');
    expect(format(...(call as [string, ...unknown[]]))).toBe(
      '[route] Failed to resolve agent_id UUID for name "bot%s%d": db down',
    );
    warn.mockRestore();
  });
});
