/**
 * The default pair is two model families, in every key configuration (2026-10-23, for the
 * repo-alignment sprint). Until then, with no Cerebras key the default was gpt-oss-120b and
 * gpt-oss-20b on Groq: one family. S47 already turned that pair's agreement into not-checked, so it
 * spent two calls on an answer that could never decide, and the README called the checks
 * "independent". Now the pair is always Groq gpt-oss + Cerebras qwen. Without a Cerebras key that
 * slot gives no answer: a canary-ready stand-in of another family takes it, or the label is
 * not-checked. Two families do not make two independent opinions (Kim et al., ICML 2025,
 * arXiv 2506.07962: errors correlate across families too), but one family is one opinion.
 * Hosts are stubbed: no test here reaches a real provider.
 */
import {
  __resetVoteCooldowns,
  activeVoters,
  classifyByFreeVotes,
  modelFamily,
  oneFamily,
  parseVoters,
  type Voter,
} from '../src/classify/free-votes';

const KEY = 'test-key-not-real';
const KEYSETS: Record<string, NodeJS.ProcessEnv> = {
  'no keys': {} as NodeJS.ProcessEnv,
  'Groq only': { GROQ_API_KEY: KEY } as NodeJS.ProcessEnv,
  'Cerebras only': { CEREBRAS_API_KEY: KEY } as NodeJS.ProcessEnv,
  'Groq and Cerebras': { GROQ_API_KEY: KEY, CEREBRAS_API_KEY: KEY } as NodeJS.ProcessEnv,
};

function twoFamilies(pair: readonly Voter[]): boolean {
  return pair.length === 2 && !oneFamily(pair[0]!, pair[1]!);
}

function stub(content: string) {
  const models: string[] = [];
  const impl = jest.fn(async (_url: unknown, init?: RequestInit) => {
    models.push(String((JSON.parse(String(init?.body)) as { model: unknown }).model));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  return { impl, models };
}

beforeEach(() => __resetVoteCooldowns());

describe('the default pair is two model families', () => {
  it.each(Object.keys(KEYSETS))('with %s', (name) => {
    expect(twoFamilies(activeVoters(KEYSETS[name]!))).toBe(true);
  });

  it.each([undefined, '', 'groq:a', 'anthropic:x,openai:y'])('a CLASSIFY_VOTERS of %j falls back to two families', (raw) => {
    expect(twoFamilies(parseVoters(raw))).toBe(true);
  });
});

describe('with no Cerebras key', () => {
  const env = KEYSETS['Groq only']!;

  it('spends no call on a same-family second vote, and answers not-checked', async () => {
    const { impl, models } = stub('TRUE');
    const r = await classifyByFreeVotes('Paris is the capital of France.', { env, fetchImpl: impl, timeoutMs: 500 });
    expect(r.label).toBe('not-checked');
    expect(models).toEqual(['openai/gpt-oss-120b']);
  });

  it('a canary-ready stand-in of another family takes the empty slot, so two families can decide', async () => {
    const { impl } = stub('TRUE');
    const r = await classifyByFreeVotes('Paris is the capital of France.', {
      env,
      fetchImpl: impl,
      timeoutMs: 500,
      budgetMs: 5000,
      backupReady: () => true,
    });
    expect(r.label).toBe('pass');
    expect(new Set(r.deciders.map((v) => modelFamily(v.model))).size).toBe(2);
  });
});
