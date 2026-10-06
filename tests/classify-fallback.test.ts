/**
 * THE FALLBACK (src/classify/free-votes.ts). Sean, 2026-10-05: "we need automated fallback for
 * graceful degradation", then the same evening: "we should never be choosing to say not checked
 * ... when there are so many options".
 *
 * A slot whose voter gave NO ANSWER passes to the next model in VOTER_POOL that the canary has
 * seen answer right, of a different family from the other slot, free before paid, inside the
 * route's deadline. A slot whose voter ANSWERED keeps its answer. These tests pin both halves.
 * The hosts are stubbed: nothing here reaches a provider.
 */
const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import {
  __resetVoteCooldowns,
  activeVoters,
  BUDGET_PER_MIN,
  castVote,
  classifyByFreeVotes,
  CROSS_FAMILY_VOTERS,
  DAILY_CALLS,
  DEFAULT_VOTERS,
  FAILURE_COOL_MS,
  MIN_ATTEMPT_MS,
  modelFamily,
  nextStandIn,
  noAnswer,
  parsePool,
  poolFor,
  standbyVoters,
  VOTE_MAX_TOKENS,
  VOTER_POOL,
  WORKERS_AI_MODEL,
  type VoteOutcome,
  type Voter,
} from '../src/classify/free-votes';
import * as health from '../src/classify/vote-health';
import { PROVIDER_URLS } from '../src/egress/provider-hosts';
import { classifyTextWithPath } from '../src/routes/classify';

const FAKE = 'test-key-not-real';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENV = {
  GROQ_API_KEY: FAKE,
  CEREBRAS_API_KEY: FAKE,
  OPENROUTER_API_KEY: FAKE,
  MISTRAL_API_KEY: FAKE,
  TOGETHER_API_KEY: FAKE,
  FIREWORKS_API_KEY: FAKE,
  CLOUDFLARE_WORKERS_AI_TOKEN: FAKE,
  CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
} as NodeJS.ProcessEnv;
const PAID = { ...ENV, SEAN_PAID_LOOP: 'paid classify' } as NodeJS.ProcessEnv;

const [GROQ_120B, CEREBRAS_QWEN] = CROSS_FAMILY_VOTERS as [Voter, Voter];
const GROQ_20B: Voter = { provider: 'groq', model: 'openai/gpt-oss-20b' };
const GROQ_QWEN: Voter = { provider: 'groq', model: 'qwen/qwen3.8-27b' };
const OR_GEMMA: Voter = { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' };
const OR_NEMOTRON: Voter = { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' };
const MISTRAL: Voter = { provider: 'mistral', model: 'mistral-small-latest' };
const CF_LLAMA: Voter = { provider: 'workers-ai', model: WORKERS_AI_MODEL };
const key = (v: Voter) => `${v.provider}:${v.model}`;

const HOSTS: Record<string, string> = {
  [PROVIDER_URLS.groqChatCompletions]: 'groq',
  [PROVIDER_URLS.cerebrasChatCompletions]: 'cerebras',
  [PROVIDER_URLS.openrouterChatCompletions]: 'openrouter',
  [PROVIDER_URLS.mistralChatCompletions]: 'mistral',
  [PROVIDER_URLS.togetherChatCompletions]: 'together',
  [PROVIDER_URLS.fireworksChatCompletions]: 'fireworks',
  [PROVIDER_URLS.zaiChatCompletions]: 'zai',
  [`${PROVIDER_URLS.cloudflareApiOrigin}/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`]: 'workers-ai',
};

type Answer = { status?: number; content?: string; delayMs?: number };
type Call = { host: string; model: string; claim: string; body: Record<string, unknown> };

/** One stub for every host. `answer` sees which host and model was asked, and the claim. */
function hosts(answer: (c: Call) => Answer) {
  const calls: Call[] = [];
  const impl = jest.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const messages = body.messages as Array<{ content: string }>;
    const call: Call = { host: HOSTS[String(url)] ?? 'other', model: String(body.model), claim: messages[1]?.content ?? '', body };
    calls.push(call);
    const a = answer(call);
    if (a.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, a.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: a.content ?? '' } }] }), {
      status: a.status ?? 200,
    });
  });
  return { impl, calls };
}

const ids = (calls: Call[]) => calls.map((c) => `${c.host}:${c.model}`);

/** Right on both canary claims, and TRUE on anything else. */
const truthful = (c: Call): Answer => ({ content: c.claim.includes(health.CANARY_FALSE) ? 'FALSE' : 'TRUE' });

/** Canary every standby voter with right answers, then clear budgets so the test starts fresh. */
async function canaryAllOk(env: NodeJS.ProcessEnv = ENV) {
  await health.runCanary({ env, fetchImpl: hosts(truthful).impl, timeoutMs: 500 });
  __resetVoteCooldowns();
}

/** Spend a voter's whole per-minute budget, so its next vote is refused `budget` with no request. */
async function exhaust(v: Voter) {
  const { impl } = hosts(() => ({ content: 'TRUE' }));
  for (let i = 0; i < BUDGET_PER_MIN[v.provider]; i += 1) await castVote(v, 'x', { env: ENV, fetchImpl: impl, timeoutMs: 500 });
  expect(await castVote(v, 'x', { env: ENV, fetchImpl: impl, timeoutMs: 500 })).toEqual({ kind: 'abstain', reason: 'budget' });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  __resetVoteCooldowns();
  health.__resetClassifyStats();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the pool', () => {
  it('free before paid, and "free" means free', () => {
    const firstPaid = VOTER_POOL.findIndex((v) => v.paid);
    expect(firstPaid).toBeGreaterThan(0);
    expect(VOTER_POOL.slice(firstPaid).every((v) => v.paid)).toBe(true);
    for (const v of VOTER_POOL) {
      // Hosts with no free tier on this account are paid; an OpenRouter model is free only as `:free`.
      if (['mistral', 'together', 'fireworks'].includes(v.provider)) expect(v.paid).toBe(true);
      if (v.provider === 'openrouter') expect(Boolean(v.paid)).toBe(!v.model.endsWith(':free'));
    }
  });

  it('never a host whose terms or contract keep it out', () => {
    for (const v of VOTER_POOL) expect(['nvidia-nim', 'zai']).not.toContain(v.provider);
  });

  it('Cloudflare Workers AI is the third family: free, and the only Llama (Sean and Grok, 2026-10-06)', () => {
    const cf = VOTER_POOL.filter((v) => v.provider === 'workers-ai');
    expect(cf).toEqual([CF_LLAMA]);
    expect(VOTER_POOL.filter((v) => modelFamily(v.model) === 'llama')).toEqual([CF_LLAMA]);
    // A third family: neither of the pair's.
    for (const v of CROSS_FAMILY_VOTERS) expect(modelFamily(v.model)).not.toBe('llama');
    expect(poolFor(ENV).map(key)).toContain(key(CF_LLAMA));
  });

  it('paid models only with the paid switch on (Sean, 2026-09-10: SEAN_PAID_LOOP)', () => {
    expect(poolFor(ENV).some((v) => v.provider === 'mistral')).toBe(false);
    expect(poolFor({ ...ENV, SEAN_PAID_LOOP: 'hold' }).some((v) => v.provider === 'mistral')).toBe(false);
    expect(poolFor(PAID).some((v) => v.provider === 'mistral')).toBe(true);
    expect(poolFor(PAID)).toHaveLength(VOTER_POOL.length);
  });

  it('the standby list is the pair, then the pool; CLASSIFY_FALLBACK=off is the pair alone', () => {
    const standby = standbyVoters(ENV);
    expect(standby.slice(0, 2)).toEqual(CROSS_FAMILY_VOTERS);
    expect(new Set(standby.map(key)).size).toBe(standby.length);
    expect(standby.map(key)).toEqual(expect.arrayContaining(poolFor(ENV).map(key)));
    expect(standbyVoters({ ...ENV, CLASSIFY_FALLBACK: 'off' })).toEqual(CROSS_FAMILY_VOTERS);
    expect(standbyVoters({ ...ENV, CLASSIFY_FALLBACK: ' OFF ' })).toEqual(CROSS_FAMILY_VOTERS);
  });

  it('Groq x2 (no Cerebras key) still has the pair it had', () => {
    expect(activeVoters({ GROQ_API_KEY: FAKE } as NodeJS.ProcessEnv)).toBe(DEFAULT_VOTERS);
  });

  it('families read from ids', () => {
    expect(modelFamily('openai/gpt-oss-120b')).toBe('gpt-oss');
    expect(modelFamily('accounts/fireworks/models/gpt-oss-120b')).toBe('gpt-oss');
    expect(modelFamily('qwen-3.8-27b')).toBe('qwen');
    expect(modelFamily('qwen/qwen3.8-27b')).toBe('qwen');
    expect(modelFamily('qwen/qwen-2.5-72b-instruct')).toBe('qwen');
    expect(modelFamily('google/gemma-4-31b-it:free')).toBe('gemma');
    expect(modelFamily('gemma-4-31b')).toBe('gemma');
    expect(modelFamily('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe('nemotron');
    expect(modelFamily('glm-4.5-flash')).toBe('glm');
    expect(modelFamily('mistral-small-latest')).toBe('mistral');
    expect(modelFamily('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe('llama');
  });
});

describe('CLASSIFY_POOL: the pool without a deploy, under the same rules', () => {
  it('replaces the order and the members', () => {
    const env = { ...ENV, CLASSIFY_POOL: 'openrouter:google/gemma-4-31b-it:free, groq:openai/gpt-oss-20b' };
    expect(poolFor(env)).toEqual([OR_GEMMA, GROQ_20B]);
  });

  it('anything not provably free is paid, and waits for the paid switch', () => {
    const pool = parsePool('groq:openai/gpt-oss-120b,zai:glm-4.5-flash,zai:glm-5-turbo,openrouter:qwen/qwen-2.5-72b-instruct,mistral:mistral-small-latest,cerebras:qwen-3.8-27b,cerebras:gemma-4-31b')!;
    const paid = Object.fromEntries(pool.map((v) => [key(v), Boolean(v.paid)]));
    expect(paid).toEqual({
      'groq:openai/gpt-oss-120b': false,
      'zai:glm-4.5-flash': false,
      'zai:glm-5-turbo': true,
      'openrouter:qwen/qwen-2.5-72b-instruct': true,
      'mistral:mistral-small-latest': true,
      'cerebras:qwen-3.8-27b': false,
      'cerebras:gemma-4-31b': true,
    });
    const listed = { ...ENV, CLASSIFY_POOL: 'mistral:mistral-small-latest,zai:glm-4.5-flash' };
    expect(poolFor(listed)).toEqual([{ provider: 'zai', model: 'glm-4.5-flash' }]);
    expect(poolFor({ ...listed, SEAN_PAID_LOOP: 'on' })).toHaveLength(2);
  });

  it('drops unknown providers, empty models and repeats; unset or blank is the default pool', () => {
    expect(parsePool('nope:x,groq:,:y,groq:openai/gpt-oss-20b,groq:openai/gpt-oss-20b')).toEqual([GROQ_20B]);
    expect(parsePool(undefined)).toBeNull();
    expect(parsePool('  ')).toBeNull();
    expect(poolFor({ ...ENV, CLASSIFY_POOL: ' ' })).toEqual(poolFor(ENV));
  });

  it('a listed stand-in is still used only after the canary has seen it answer right', async () => {
    const env = { ...ENV, ZAI_API_KEY: FAKE, CLASSIFY_POOL: 'zai:glm-4.5-flash' };
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 5000, env)).label).toBe('not-checked');
    expect(h.calls.some((c) => c.host === 'zai')).toBe(false);
    await canaryAllOk(env);
    await exhaust(CEREBRAS_QWEN);
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect(await classifyTextWithPath('Paris is the capital of France.', 5000, env)).toMatchObject({
      label: 'pass',
      deciders: ['groq', 'zai'],
    });
  });
});

describe('no answer passes the slot on; an answer never does', () => {
  const abstain = (reason: string, shape?: string) => ({ kind: 'abstain', reason, ...(shape ? { shape } : {}) }) as VoteOutcome;

  it.each(['budget', 'cooling', 'no_key', 'retired_model', 'rate_limited', 'http_error', 'timeout', 'network'])(
    '%s is no answer',
    (reason) => expect(noAnswer(abstain(reason))).toBe(true),
  );

  it('an empty reply, or reasoning cut off before the answer, is no answer', () => {
    expect(noAnswer(abstain('unparseable', 'empty'))).toBe(true);
    expect(noAnswer(abstain('unparseable', 'cut_off_reasoning'))).toBe(true);
  });

  it('TRUE, FALSE, UNSURE, and a reply with words in it are answers', () => {
    for (const verdict of ['TRUE', 'FALSE', 'UNSURE'] as const) expect(noAnswer({ kind: 'verdict', verdict })).toBe(false);
    for (const shape of ['verdict_with_text', 'several_verdicts', 'no_verdict']) {
      expect(noAnswer(abstain('unparseable', shape))).toBe(false);
    }
  });

  it('the data-locality boundary is not "no answer": under it, nothing may be sent anywhere', () => {
    expect(noAnswer(abstain('boundary'))).toBe(false);
  });
});

describe('a voter with no answer hands its slot on', () => {
  it.each([
    ['over its budget', 'budget'],
    ['answering 503', { status: 503 }],
    ['answering 429', { status: 429 }],
    ['answering empty', { content: '' }],
  ])('Cerebras %s: the free qwen on Groq stands in, and the claim passes', async (_why, cerebras) => {
    await canaryAllOk();
    if (cerebras === 'budget') await exhaust(CEREBRAS_QWEN);
    const h = hosts((c) => (c.host === 'cerebras' && cerebras !== 'budget' ? (cerebras as Answer) : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out).toMatchObject({ label: 'pass', by: 'votes', deciders: ['groq', 'groq'] });
    // `voters` is who received the text: Cerebras did, unless it was refused before any request.
    expect((out as { voters: string[] }).voters).toEqual(cerebras === 'budget' ? ['groq', 'groq'] : ['groq', 'cerebras', 'groq']);
    expect(ids(h.calls)).toContain(key(GROQ_QWEN));
  });

  it('a both-FALSE claim is vetoed the same way', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    globalThis.fetch = hosts(() => ({ content: 'FALSE' })).impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('The Sun orbits the Earth.', 5000, ENV)).label).toBe('veto');
  });

  it('a voter that times out hands its slot on, inside the time that is left', async () => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'cerebras' ? { delayMs: 2000 } : { content: 'TRUE' }));
    const started = Date.now();
    const r = await classifyByFreeVotes('Paris is the capital of France.', {
      env: ENV,
      fetchImpl: h.impl,
      timeoutMs: 300,
      budgetMs: 1500,
      backupReady: health.canaryOk,
    });
    expect(r.label).toBe('pass');
    expect(r.deciders.map(key)).toEqual([key(GROQ_120B), key(GROQ_QWEN)]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('when Groq and Cerebras are both down, Cloudflare’s Llama and an OpenRouter model decide', async () => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'groq' || c.host === 'cerebras' ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out).toMatchObject({ label: 'pass', by: 'votes', deciders: ['workers-ai', 'openrouter'] });
    const asked = ids(h.calls);
    expect(asked).toContain(key(CF_LLAMA));
    expect(asked).toContain(key(OR_GEMMA));
  });

  it('with Cloudflare down too, two OpenRouter models of two families decide', async () => {
    await canaryAllOk();
    const down = new Set(['groq', 'cerebras', 'workers-ai']);
    const h = hosts((c) => (down.has(c.host) ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out).toMatchObject({ label: 'pass', by: 'votes', deciders: ['openrouter', 'openrouter'] });
    const asked = ids(h.calls);
    expect(asked).toContain(key(OR_GEMMA));
    expect(asked).toContain(key(OR_NEMOTRON));
  });

  it('every OpenRouter call asks for upstreams that neither store nor train on the claim', async () => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'groq' || c.host === 'cerebras' ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    const or = h.calls.filter((c) => c.host === 'openrouter');
    expect(or.length).toBeGreaterThan(0);
    for (const c of or) expect(c.body.provider).toEqual({ data_collection: 'deny' });
  });
});

describe('never shopping for a verdict: a voter that answered keeps its answer', () => {
  it.each([
    ['UNSURE', { content: 'UNSURE' }],
    ['FALSE (a disagreement)', { content: 'FALSE' }],
    ['a reply with words in it', { content: 'TRUE, probably' }],
  ])('Cerebras answering %s: no stand-in is dialled, and the label is not-checked', async (_why, cerebras) => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'cerebras' ? cerebras : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out.label).toBe('not-checked');
    expect(ids(h.calls).sort()).toEqual([key(GROQ_120B), key(CEREBRAS_QWEN)].sort());
  });
});

describe('two families, always', () => {
  it('a stand-in is never the other slot’s family', () => {
    const pool = poolFor(PAID);
    const all = () => true;
    for (const other of pool) {
      const asked = new Set([key(other)]);
      let next = nextStandIn(pool, other, asked, all);
      while (next) {
        expect(modelFamily(next.model)).not.toBe(modelFamily(other.model));
        asked.add(key(next));
        next = nextStandIn(pool, other, asked, all);
      }
    }
  });

  it('with only one family left in reach, the claim is not-checked rather than one family twice', async () => {
    await canaryAllOk();
    // Only the gpt-oss models answer; every other family is down.
    const h = hosts((c) => (modelFamily(c.model) === 'gpt-oss' ? { content: 'TRUE' } : { status: 503 }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 5000, ENV)).label).toBe('not-checked');
  });

  it('CLASSIFY_VOTERS naming the same voter twice cannot pass, even with both TRUE', async () => {
    const r = await classifyByFreeVotes('Paris is the capital of France.', {
      env: ENV,
      fetchImpl: hosts(() => ({ content: 'TRUE' })).impl,
      timeoutMs: 500,
      voters: [GROQ_120B, GROQ_120B],
    });
    expect(r.label).toBe('not-checked');
  });
});

describe('free first; paid only with the paid switch on', () => {
  const freeDown = (c: Call): Answer => (c.host === 'mistral' ? truthful(c) : { status: 503 });

  it('every free host down and the switch off: not-checked, and no paid host is dialled', async () => {
    await canaryAllOk();
    const h = hosts(freeDown);
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 5000, ENV)).label).toBe('not-checked');
    expect(h.calls.some((c) => c.host === 'mistral' || c.host === 'together' || c.host === 'fireworks')).toBe(false);
  });

  it('the switch on: a paid model may stand in', async () => {
    await canaryAllOk(PAID);
    // Only Groq's gpt-oss and Mistral answer: every free stand-in for the qwen slot is down.
    const h = hosts((c) =>
      c.host === 'mistral' || (c.host === 'groq' && modelFamily(c.model) === 'gpt-oss') ? { content: 'TRUE' } : { status: 503 },
    );
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, PAID);
    expect(out).toMatchObject({ label: 'pass', deciders: ['groq', 'mistral'] });
    expect(ids(h.calls)).toContain(key(MISTRAL));
  });
});

describe('a stand-in is used only once the canary has seen it answer right', () => {
  it('no canary yet: Cerebras over budget is Not checked, and no stand-in is dialled', async () => {
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq'] });
    expect(ids(h.calls)).toEqual([key(GROQ_120B)]);
  });

  it('a stand-in whose canary was wrong stays out, and the next one in the pool is tried', async () => {
    await health.runCanary({
      env: ENV,
      fetchImpl: hosts((c) => (c.model === GROQ_QWEN.model ? { content: 'TRUE' } : truthful(c))).impl,
      timeoutMs: 500,
    });
    __resetVoteCooldowns();
    expect(health.canaryOk(GROQ_QWEN)).toBe(false);
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    // The next in the pool after Groq's qwen is Cloudflare's Llama.
    expect(out).toMatchObject({ label: 'pass', deciders: ['groq', 'workers-ai'] });
    expect(ids(h.calls)).not.toContain(key(GROQ_QWEN));
  });

  it('the canary asks every stand-in, and the stats list them', async () => {
    const h = hosts(truthful);
    await health.runCanary({ env: ENV, fetchImpl: h.impl, timeoutMs: 500 });
    const standby = standbyVoters(ENV).map(key);
    expect(new Set(ids(h.calls))).toEqual(new Set(standby));
    const rows = health.classifyStats(ENV).voters.map((r) => r.voter);
    expect(rows.slice(0, 2)).toEqual(CROSS_FAMILY_VOTERS.map(key));
    expect(new Set(rows)).toEqual(new Set(standby));
  });

  it('CLASSIFY_FALLBACK=off: canary-ok stand-ins are still never used', async () => {
    const env = { ...ENV, CLASSIFY_FALLBACK: 'off' };
    await canaryAllOk(ENV);
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 5000, env)).label).toBe('not-checked');
    expect(ids(h.calls)).toEqual([key(GROQ_120B)]);
  });

  it('without backupReady (every caller but the route) the pair is exactly the pair', async () => {
    await exhaust(CEREBRAS_QWEN);
    const r = await classifyByFreeVotes('x', { env: ENV, fetchImpl: hosts(() => ({ content: 'TRUE' })).impl, timeoutMs: 500 });
    expect(r.label).toBe('not-checked');
    expect(r.attempts.map((t) => key(t.voter))).toEqual(CROSS_FAMILY_VOTERS.map(key));
  });
});

describe('learning who is down: the next claim skips straight past them', () => {
  it('after a 5xx, the next claim does not dial that voter again until it has cooled', async () => {
    await canaryAllOk();
    const first = hosts((c) => (c.host === 'cerebras' ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = first.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 5000, ENV)).label).toBe('pass');

    const second = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = second.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Water boils at 100 degrees Celsius at sea level.', 5000, ENV);
    expect(out).toMatchObject({ label: 'pass', voters: ['groq', 'groq'] });
    expect(ids(second.calls)).not.toContain(key(CEREBRAS_QWEN));
    expect(FAILURE_COOL_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('a vendor header saying none are left today refuses the voter before any request', async () => {
    const spent = jest.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'TRUE' } }] }), {
        status: 200,
        headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '0' },
      }),
    );
    expect(await castVote(GROQ_120B, 'x', { env: ENV, fetchImpl: spent, timeoutMs: 500 })).toEqual({ kind: 'verdict', verdict: 'TRUE' });
    expect(await castVote(GROQ_120B, 'x', { env: ENV, fetchImpl: spent, timeoutMs: 500 })).toEqual({ kind: 'abstain', reason: 'budget' });
    expect(spent).toHaveBeenCalledTimes(1);
  });
});

describe('inside the deadline', () => {
  it('with less than MIN_ATTEMPT_MS left, a slot stops instead of starting a stand-in it cannot finish', async () => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'cerebras' ? { delayMs: 2000 } : { content: 'TRUE' }));
    const r = await classifyByFreeVotes('Paris is the capital of France.', {
      env: ENV,
      fetchImpl: h.impl,
      timeoutMs: 300,
      budgetMs: 300 + MIN_ATTEMPT_MS - 50,
      backupReady: health.canaryOk,
    });
    expect(r.label).toBe('not-checked');
    expect(ids(h.calls).sort()).toEqual([key(GROQ_120B), key(CEREBRAS_QWEN)].sort());
  });

  it('the route answers inside its deadline even when every voter is slow', async () => {
    await canaryAllOk();
    globalThis.fetch = hosts(() => ({ delayMs: 10_000 })).impl as unknown as typeof fetch;
    const started = Date.now();
    const out = await classifyTextWithPath('Paris is the capital of France.', 1200, ENV);
    expect(out.label).toBe('not-checked');
    expect(Date.now() - started).toBeLessThan(1200);
  });
});

describe('host-specific request fields', () => {
  it('Z.ai is told not to think before a one-word verdict', async () => {
    const h = hosts(() => ({ content: 'TRUE' }));
    await castVote({ provider: 'zai', model: 'glm-4.5-flash' }, 'x', { env: { ZAI_API_KEY: FAKE }, fetchImpl: h.impl, timeoutMs: 500 });
    expect(h.calls[0]!.body.thinking).toEqual({ type: 'disabled' });
  });

  it('gpt-oss gets short reasoning on any host, by family', async () => {
    const h = hosts(() => ({ content: 'TRUE' }));
    await castVote({ provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b' }, 'x', {
      env: ENV,
      fetchImpl: h.impl,
      timeoutMs: 500,
    });
    expect(h.calls[0]!.body.reasoning_effort).toBe('low');
  });

  it('the stand-in qwen on Groq carries the qwen reasoning switch, as the Cerebras call does', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(h.calls.find((c) => c.model === GROQ_QWEN.model)!.body.reasoning_effort).toBe('none');
  });
});

describe('the stats show who gave no answer and who stood in', () => {
  it('Cerebras over budget, then the stand-in that answered', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    globalThis.fetch = hosts(() => ({ content: 'TRUE' })).impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    const rows = health.classifyStats(ENV).voters;
    expect(rows.find((r) => r.voter === key(CEREBRAS_QWEN))!.abstains.budget).toBe(1);
    expect(rows.find((r) => r.voter === key(GROQ_QWEN))!.verdicts.TRUE).toBe(1);
  });
});

describe('Cloudflare Workers AI: a backup only once keyed and canaried, and free by the day', () => {
  const NO_CF = { ...ENV, CLOUDFLARE_WORKERS_AI_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined } as NodeJS.ProcessEnv;

  it('without its two variables the canary reads not-checked, and it is never dialled', async () => {
    await health.runCanary({ env: NO_CF, fetchImpl: hosts(truthful).impl, timeoutMs: 500 });
    __resetVoteCooldowns();
    expect(health.canaryOk(CF_LLAMA)).toBe(false);
    const row = health.classifyStats(NO_CF).voters.find((r) => r.voter === key(CF_LLAMA));
    expect(row?.canary.status).toBe('not-checked');
    // All of Groq down: with Cloudflare unkeyed, the gpt-oss slot has no Llama to hand to.
    const h = hosts((c) => (c.host === 'groq' ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 5000, NO_CF);
    expect(h.calls.some((c) => c.host === 'workers-ai')).toBe(false);
  });

  it('keyed and canaried: all of Groq down, the Llama stands in for the gpt-oss slot', async () => {
    await canaryAllOk();
    expect(health.canaryOk(CF_LLAMA)).toBe(true);
    const h = hosts((c) => (c.host === 'groq' ? { status: 503 } : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 5000, ENV);
    expect(out).toMatchObject({ label: 'pass', deciders: ['workers-ai', 'cerebras'] });
  });

  it('a Llama never stands in against a Llama, however the pool is written', () => {
    const groqLlama: Voter = { provider: 'groq', model: 'llama-3.3-70b-versatile' };
    const pool = parsePool(`groq:${groqLlama.model},workers-ai:${WORKERS_AI_MODEL},cerebras:qwen-3.8-27b`)!;
    // The other slot is a Llama, so both Llamas are skipped and the qwen is next.
    expect(nextStandIn(pool, CF_LLAMA, new Set([key(CF_LLAMA)]), () => true)).toEqual(CEREBRAS_QWEN);
    expect(nextStandIn(pool, groqLlama, new Set([key(groqLlama)]), () => true)).toEqual(CEREBRAS_QWEN);
  });

  it(`stops at ${DAILY_CALLS['workers-ai']} calls a UTC day, counted across its models, and starts again the next day`, async () => {
    const cap = DAILY_CALLS['workers-ai']!;
    expect(cap * 49).toBeLessThan(10_000); // worst-case neurons a vote, under the free day
    const day1 = Date.parse('2026-10-06T00:00:00Z');
    const other: Voter = { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' };
    const h = hosts(() => ({ content: 'TRUE' }));
    for (let i = 0; i < cap; i += 1) {
      // Spread a minute apart so only the daily count can refuse.
      const v = i % 2 ? other : CF_LLAMA;
      expect(await castVote(v, 'x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500, now: () => day1 + i * 60_000 })).toEqual({
        kind: 'verdict',
        verdict: 'TRUE',
      });
    }
    const late = day1 + cap * 60_000;
    expect(await castVote(CF_LLAMA, 'x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500, now: () => late })).toEqual({
      kind: 'abstain',
      reason: 'budget',
    });
    expect(h.calls).toHaveLength(cap);
    const day2 = Date.parse('2026-10-07T00:00:05Z');
    expect((await castVote(CF_LLAMA, 'x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500, now: () => day2 })).kind).toBe('verdict');
    // Groq has no daily count here: its vendor header does that job.
    expect(DAILY_CALLS.groq).toBeUndefined();
  });

  it('a vote asks for at most 16 tokens back; every other host keeps 400', async () => {
    expect(VOTE_MAX_TOKENS['workers-ai']).toBe(16);
    const h = hosts(() => ({ content: 'TRUE' }));
    await castVote(CF_LLAMA, 'x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500 });
    await castVote(GROQ_120B, 'x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500 });
    expect(h.calls.map((c) => c.body.max_tokens)).toEqual([16, 400]);
  });
});

it('the Groq 20b is never a stand-in for the 120b’s slot partner of the same family', () => {
  // The pair is gpt-oss + qwen; a gpt-oss stand-in for the qwen slot would make one family twice.
  const pool = poolFor(ENV);
  expect(nextStandIn(pool, GROQ_120B, new Set([key(GROQ_120B), key(CEREBRAS_QWEN)]), () => true)).toEqual(GROQ_QWEN);
  expect(nextStandIn(pool, CEREBRAS_QWEN, new Set([key(GROQ_120B), key(CEREBRAS_QWEN)]), () => true)).toEqual(GROQ_20B);
});
