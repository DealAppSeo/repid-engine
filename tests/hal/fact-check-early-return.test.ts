jest.mock('../../src/billing/log-call', () => ({
  logLlmCall: jest.fn(async () => undefined),
}));

jest.mock('../../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: jest.fn(async () => ({
    verdict: 'no_match',
    corroborating: [],
    contradicting: [],
    reason: 'mocked',
    degraded: false,
  })),
}));

import { factCheck, type FactCheckProviderCfg } from '../../src/hal/fact-check';

type Plan = {
  delayMs?: number;
  verdict?: 'TRUE' | 'FALSE' | 'UNCERTAIN';
  confidence?: number;
  reject?: string;
};

const PROVIDERS: FactCheckProviderCfg[] = [
  { name: 'groq-fast', endpoint: 'http://x/groq', apiKey: 'k1', model: 'groq-model', family: 'openai', tier: 'free' },
  { name: 'cerebras-fast', endpoint: 'http://x/cerebras', apiKey: 'k2', model: 'cerebras-model', family: 'qwen', tier: 'free' },
  { name: 'zai-slow', endpoint: 'http://x/zai', apiKey: 'k3', model: 'zai-model', family: 'glm', tier: 'free' },
];

const originalFetch = global.fetch;
let plans: Record<string, Plan> = {};

async function snapshot<T>(promise: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
  let done = false;
  let value!: T;
  void promise.then((resolved) => {
    done = true;
    value = resolved;
  });
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  return done ? { done: true, value } : { done: false };
}

beforeEach(() => {
  jest.useFakeTimers();
  plans = {};
  (global as any).fetch = jest.fn(async (_url: string, init: any) => {
    const model = JSON.parse(init.body).model as string;
    const plan = plans[model];
    if (!plan) throw new Error(`missing plan for ${model}`);
    return await new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (plan.reject) {
          reject(new Error(plan.reject));
          return;
        }
        resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ verdict: plan.verdict ?? 'UNCERTAIN', confidence: plan.confidence ?? 50 }) } }],
          }),
        } as any);
      };
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal?.aborted) return onAbort();
      init.signal?.addEventListener('abort', onAbort, { once: true });
      if ((plan.delayMs ?? 0) > 0) timer = setTimeout(finish, plan.delayMs);
      else finish();
    });
  });
});

afterEach(async () => {
  await jest.runOnlyPendingTimersAsync();
  jest.useRealTimers();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('factCheck early return', () => {
  test('two fast TRUE families return before a delayed third TRUE and mark the late voter NOT_CHECKED', async () => {
    plans = {
      'groq-model': { verdict: 'TRUE', confidence: 95 },
      'cerebras-model': { verdict: 'TRUE', confidence: 94 },
      'zai-model': { delayMs: 5000, verdict: 'TRUE', confidence: 93 },
    };

    const pending = factCheck('Paris is the capital of France.', PROVIDERS, { earlyReturnOnAgreement: true });
    const settled = await snapshot(pending);
    expect(settled.done).toBe(true);
    if (!settled.done) return;

    expect(settled.value.providers_used).toBe(2);
    expect(settled.value.families_used).toBe(2);
    expect(settled.value.degraded).toBe(false);
    expect(settled.value.verdicts.find((v) => v.provider === 'zai-slow')).toMatchObject({
      verdict: 'UNCERTAIN',
      counted: false,
      note: 'NOT_CHECKED: late after 2-family agreement',
    });
    expect(settled.value.provider_health?.late).toEqual([
      { name: 'zai-slow', note: 'NOT_CHECKED: late after 2-family agreement' },
    ]);
  });

  test('two fast FALSE families return before a delayed third FALSE and mark the late voter NOT_CHECKED', async () => {
    plans = {
      'groq-model': { verdict: 'FALSE', confidence: 95 },
      'cerebras-model': { verdict: 'FALSE', confidence: 94 },
      'zai-model': { delayMs: 5000, verdict: 'FALSE', confidence: 93 },
    };

    const pending = factCheck('The Mona Lisa was painted by Picasso.', PROVIDERS, { earlyReturnOnAgreement: true });
    const settled = await snapshot(pending);
    expect(settled.done).toBe(true);
    if (!settled.done) return;

    expect(settled.value.providers_used).toBe(2);
    expect(settled.value.families_used).toBe(2);
    expect(settled.value.decision).toBe('vetoed');
    expect(settled.value.verdicts.find((v) => v.provider === 'zai-slow')?.note).toBe('NOT_CHECKED: late after 2-family agreement');
  });

  test('a fast TRUE/FALSE split waits for the slow third family', async () => {
    plans = {
      'groq-model': { verdict: 'TRUE', confidence: 95 },
      'cerebras-model': { verdict: 'FALSE', confidence: 94 },
      'zai-model': { delayMs: 5000, verdict: 'TRUE', confidence: 93 },
    };

    const pending = factCheck('A contested claim.', PROVIDERS, { earlyReturnOnAgreement: true });
    expect((await snapshot(pending)).done).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.providers_used).toBe(3);
    expect(result.families_used).toBe(3);
    expect(result.verdicts.every((v) => v.counted !== false)).toBe(true);
  });

  test('only one family answering still waits for the rest and returns degraded', async () => {
    plans = {
      'groq-model': { verdict: 'TRUE', confidence: 95 },
      'cerebras-model': { delayMs: 5000, reject: 'network down' },
      'zai-model': { delayMs: 5000, reject: 'network down' },
    };

    const pending = factCheck('A degraded claim.', PROVIDERS, { earlyReturnOnAgreement: true });
    expect((await snapshot(pending)).done).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.providers_used).toBe(1);
    expect(result.families_used).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.provider_health?.failed).toHaveLength(2);
  });
});
