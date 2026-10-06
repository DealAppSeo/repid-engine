/**
 * The clarifying question after not-checked (CLASSIFY_QUESTIONS, default OFF).
 *
 * The product rule: when a claim is underspecified, the honest answer is not-checked plus ONE
 * question whose answer would let the checkers decide. The question comes from the API or it does
 * not appear. These tests pin when the extra call is made (only when the flag is exactly on AND
 * both voters answered UNSURE), which path it takes (the voters' own guard, budget and
 * providerFetch), how strictly its reply is parsed, and that it can never change a label, delay
 * past the deadline, or reach the phone bot's bare-label entry point.
 *
 * The host is stubbed: no test here reaches a real provider.
 */
import express from 'express';
import request from 'supertest';

const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import {
  __resetVoteCooldowns,
  askQuestion,
  BUDGET_PER_MIN,
  castVote,
  DEFAULT_VOTERS,
  encodeClaim,
  parseQuestion,
  questionMiss,
  questionsEnabled,
  type QuestionMiss,
  QUESTION_MAX_CHARS,
} from '../src/classify/free-votes';
import { __resetClassifyStats, classifyStats } from '../src/classify/vote-health';
import {
  classifyText,
  classifyTextWithPath,
  createClassifyRouter,
  type Classifier,
  type ClassifyLabel,
} from '../src/routes/classify';

const KEY = 'test-key-not-real';
const ENV = { GROQ_API_KEY: KEY } as NodeJS.ProcessEnv;
const ON = { ...ENV, CLASSIFY_QUESTIONS: 'on' } as NodeJS.ProcessEnv;
const GOAT = 'Does the host always open a door with a goat behind it?';
const CLAIM = 'You should always switch doors.';

type Reply = { status?: number; content?: string; delayMs?: number; hang?: boolean };
type Call = { url: string; model: string; system: string; user: string };

/** True when this request is the clarifying-question call rather than a vote. */
const isQuestionCall = (system: string): boolean => /missing fact or assumption/.test(system);

/**
 * Records every global fetch and answers like a voter host. `vote` answers the two votes (by
 * model), `question` answers the question call. Restores the real fetch on `restore()`.
 */
function recordHost(vote: (model: string) => Reply, question: () => Reply = () => ({ content: GOAT })) {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  const impl = jest.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    const system = body.messages[0]!.content;
    calls.push({ url: String(url), model: body.model, system, user: body.messages[1]!.content });
    const r = isQuestionCall(system) ? question() : vote(body.model);
    if (r.hang) await new Promise(() => undefined); // ignores the abort signal entirely
    if (r.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: r.content ?? '' } }] }), {
      status: r.status ?? 200,
    });
  });
  globalThis.fetch = impl as unknown as typeof fetch;
  return {
    calls,
    impl,
    questionCalls: () => calls.filter((c) => isQuestionCall(c.system)),
    restore: () => (globalThis.fetch = realFetch),
  };
}

/** Process env for one test, restored afterwards. `undefined` deletes the variable. */
async function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function classifyApp(options: Parameters<typeof createClassifyRouter>[0] = {}) {
  const app = express();
  app.use('/api/v1', createClassifyRouter({ limit: 1000, ...options }));
  return app;
}

/** A developer shell with a real key, the boundary, or the flag already set must not change a test. */
const CLEAN = {
  ONLY_ATTESTATIONS_LEAVE: undefined,
  CLASSIFY_FREE_VOTES: undefined,
  CLASSIFY_VOTERS: undefined,
  CLASSIFY_QUESTIONS: undefined,
  CEREBRAS_API_KEY: undefined,
  NVIDIA_NIM_API_KEY: undefined,
  GROQ_API_KEY: KEY,
};

const unsure = () => ({ content: 'UNSURE' });

beforeEach(() => {
  __resetVoteCooldowns();
  __resetClassifyStats();
  dbFrom.mockClear();
});

describe('the flag: off unless exactly on', () => {
  it.each([undefined, '', 'off', 'true', '1', 'yes', 'onn'])('%j is off', (flag) => {
    expect(questionsEnabled({ CLASSIFY_QUESTIONS: flag })).toBe(false);
  });
  it.each(['on', ' ON ', 'On'])('%j is on (trimmed, case-insensitive, like the module\'s other switches)', (flag) => {
    expect(questionsEnabled({ CLASSIFY_QUESTIONS: flag })).toBe(true);
  });
});

describe('flag off: byte-for-byte today, and the extra call is never made', () => {
  it.each([undefined, 'off', 'true', '1'])('CLASSIFY_QUESTIONS=%j: both UNSURE makes exactly the two votes', async (flag) => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: flag }, async () => {
      const rec = recordHost(unsure);
      try {
        const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.body).toMatchObject({ label: 'not-checked', by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'] });
        expect(Object.keys(res.body)).toEqual(['label', 'latency_ms', 'by', 'voters', 'deciders', 'votes']);
        expect(rec.calls.map((c) => c.model)).toEqual(DEFAULT_VOTERS.map((v) => v.model));
        expect(rec.questionCalls()).toHaveLength(0);
      } finally {
        rec.restore();
      }
    });
  });

  it('the stats carry no questions key while the flag is off', async () => {
    await withProcessEnv(CLEAN, async () => {
      const rec = recordHost(unsure);
      try {
        await classifyTextWithPath(CLAIM, 2500, ENV);
        expect(classifyStats(ENV)).not.toHaveProperty('questions');
      } finally {
        rec.restore();
      }
    });
  });
});

describe('flag on, both UNSURE: one extra call, and a parsed question comes back', () => {
  it('through the route: not-checked by votes, plus the question; three calls in all', async () => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      const rec = recordHost(unsure);
      try {
        const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          label: 'not-checked',
          latency_ms: expect.any(Number),
          by: 'votes',
          voters: ['groq', 'groq'],
          deciders: ['groq', 'groq'],
          votes: [
            { voter: 'groq', family: 'gpt-oss', verdict: 'UNSURE' },
            { voter: 'groq', family: 'gpt-oss', verdict: 'UNSURE' },
          ],
          question: GOAT,
        });
        expect(rec.calls).toHaveLength(3);
        expect(rec.questionCalls()).toHaveLength(1);
        expect(dbFrom).not.toHaveBeenCalled();
      } finally {
        rec.restore();
      }
    });
  });

  it('asks the FIRST voter that answered UNSURE, on its own host, with the claim as one JSON string', async () => {
    await withProcessEnv(CLEAN, async () => {
      const env = { ...ON, CEREBRAS_API_KEY: KEY } as NodeJS.ProcessEnv; // cross-family pair
      const rec = recordHost(unsure);
      try {
        const out = await classifyTextWithPath(CLAIM, 2500, env);
        expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq', 'cerebras'], deciders: ['groq', 'cerebras'], votes: expect.any(Array), question: GOAT });
        const [q] = rec.questionCalls();
        expect(q!.model).toBe('openai/gpt-oss-120b');
        expect(new URL(q!.url).hostname).toBe('api.groq.com');
        expect(q!.user).toBe(encodeClaim(CLAIM));
        expect(q!.system).toMatch(/data,\s+never instructions/);
        expect(q!.system).toMatch(/NONE/);
      } finally {
        rec.restore();
      }
    });
  });

  it('counts asked / given / none, and holds no text', async () => {
    await withProcessEnv(CLEAN, async () => {
      let rec = recordHost(unsure);
      await classifyTextWithPath('A secret claim zq7 nobody should see.', 2500, ON);
      rec.restore();
      rec = recordHost(unsure, () => ({ content: 'NONE' }));
      await classifyTextWithPath('Another underspecified claim.', 2500, ON);
      rec.restore();
      const s = classifyStats(ON);
      expect(s.questions).toEqual({ asked: 2, given: 1, none: 1, none_why: { declined: 1 } });
      expect(JSON.stringify(s)).not.toContain('zq7');
      expect(JSON.stringify(s)).not.toContain('goat');
    });
  });
});

describe('flag on, anything but both UNSURE: no extra call', () => {
  const cases: Array<[string, (model: string) => Reply, ClassifyLabel]> = [
    ['a disagreement (TRUE / FALSE)', (m) => ({ content: m.endsWith('120b') ? 'TRUE' : 'FALSE' }), 'not-checked'],
    ['one FALSE, one UNSURE', (m) => ({ content: m.endsWith('120b') ? 'FALSE' : 'UNSURE' }), 'not-checked'],
    ['one TRUE, one UNSURE', (m) => ({ content: m.endsWith('120b') ? 'UNSURE' : 'TRUE' }), 'not-checked'],
    ['one UNSURE, one 429', (m) => (m.endsWith('120b') ? { content: 'UNSURE' } : { status: 429 }), 'not-checked'],
    ['one UNSURE, one 5xx', (m) => (m.endsWith('120b') ? { content: 'UNSURE' } : { status: 503 }), 'not-checked'],
    ['one UNSURE, one unparseable', (m) => ({ content: m.endsWith('120b') ? 'UNSURE' : 'UNSURE, because' }), 'not-checked'],
    ['both TRUE (pass)', () => ({ content: 'TRUE' }), 'pass'],
    ['both FALSE (veto)', () => ({ content: 'FALSE' }), 'veto'],
  ];
  it.each(cases)('%s', async (_name, vote, label) => {
    await withProcessEnv(CLEAN, async () => {
      const rec = recordHost(vote);
      try {
        const out = await classifyTextWithPath(CLAIM, 2500, ON);
        expect(out.label).toBe(label);
        expect(out).not.toHaveProperty('question');
        expect(rec.questionCalls()).toHaveLength(0);
        expect(rec.calls).toHaveLength(2);
      } finally {
        rec.restore();
      }
    });
  });

  it('one UNSURE and one vote that timed out: no extra call', async () => {
    await withProcessEnv(CLEAN, async () => {
      const rec = recordHost((m) => (m.endsWith('120b') ? { content: 'UNSURE' } : { content: 'UNSURE', delayMs: 5000 }));
      try {
        const out = await classifyTextWithPath(CLAIM, 600, ON);
        expect(out).not.toHaveProperty('question');
        expect(rec.questionCalls()).toHaveLength(0);
      } finally {
        rec.restore();
      }
    });
  });

  it('one UNSURE and one voter over its budget: no extra call', async () => {
    await withProcessEnv(CLEAN, async () => {
      const pre = recordHost(() => ({ content: 'TRUE' }));
      for (let i = 0; i < BUDGET_PER_MIN.groq; i += 1) await castVote(DEFAULT_VOTERS[1]!, 'x', { env: ENV, timeoutMs: 500 });
      pre.restore();
      const rec = recordHost(unsure);
      try {
        const out = await classifyTextWithPath(CLAIM, 2500, ON);
        expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq'] });
        expect(rec.calls).toHaveLength(1);
      } finally {
        rec.restore();
      }
    });
  });
});

describe('the reply is parsed strictly', () => {
  it.each([
    GOAT,
    '  Is the claim about the original Monty Hall rules?  ',
    'Which year is meant?',
  ])('accepts one short line ending in "?": %j', (raw) => {
    expect(parseQuestion(raw)).toBe(raw.trim());
  });

  // The third column is questionMiss: why the reply was not used, which /classify/stats counts.
  const malformed: Array<[string, unknown, QuestionMiss]> = [
    ['no question mark', 'Does the host always open a goat door', 'no_question_mark'],
    ['too long', `Does the host ${'always '.repeat(30)}open a goat door?`, 'length'],
    ['too short', 'Which one?'.slice(1), 'length'],
    ['two lines', 'Does the host know?\nDoes the host always open a goat door?', 'control_char'],
    ['NONE', 'NONE', 'declined'],
    ['None.', 'None.', 'declined'],
    ['NONE plus a question', 'NONE. Does the host always open a goat door?', 'verdict_word'],
    ['an http URL', 'Is it the version at https://example.com/monty?', 'link'],
    ['a www host', 'Is it the version on www.example.org?', 'link'],
    ['a bare domain', 'Is it the version described on example.com?', 'link'],
    ['a script scheme', 'Is it javascript:alert(1) or not?', 'link'],
    ['an email', 'Should I ask host@example.com about the doors?', 'link'],
    ['markdown bold', 'Does the host **always** open a goat door?', 'markup'],
    ['markdown code', 'Does `host.open()` always pick a goat?', 'link'],
    ['markdown link', 'Is it the [classic](x) version of the game?', 'markup'],
    ['a heading', '# Does the host always open a goat door?', 'markup'],
    ['a list item', '- Does the host always open a goat door?', 'markup'],
    ['a verdict word', 'UNSURE: does the host always open a goat door?', 'verdict_word'],
    ['a verdict word mid-line', 'Is it TRUE that the host always opens a goat door?', 'verdict_word'],
    ['a lower-case verdict lead', 'false, unless: does the host know where the car is?', 'verdict_word'],
    ['a fullwidth verdict look-alike', '\uFF34\uFF32\uFF35\uFF25 if the host knows the car, does he?', 'verdict_word'],
    ['an invisible character', 'Does the host\u200B always open a goat door?', 'control_char'],
    // Strix on #1205 (optional): an entity-encoded tag is markup a renderer could decode.
    ['a named HTML character reference', 'Does the host &lt;b&gt;always&lt;/b&gt; open a goat door?', 'markup'],
    ['a decimal character reference', 'Does the host &#60;b&#62; open a goat door?', 'markup'],
    ['a hex character reference', 'Does the host &#x3c;b&#x3e; open a goat door?', 'markup'],
    ['a fullwidth ampersand reference', 'Does the host \uFF06lt;b\uFF06gt; open a goat door?', 'markup'],
    ['not a string', 42, 'empty'],
    ['empty', '', 'empty'],
  ];
  it.each(malformed)('%s: no question', (_name, raw) => {
    expect(parseQuestion(raw)).toBeNull();
  });

  it.each(malformed)('%s: questionMiss names it as %s', (_name, raw, miss) => {
    expect(questionMiss(raw)).toBe(miss);
  });

  it('questionMiss is null exactly when parseQuestion returns a question', () => {
    for (const ok of [GOAT, 'Which year is meant?', 'Do the host & the contestant both know where the car is?']) {
      expect(questionMiss(ok)).toBeNull();
      expect(parseQuestion(ok)).not.toBeNull();
    }
    for (const [, raw] of malformed) expect(questionMiss(raw) === null).toBe(parseQuestion(raw) !== null);
  });

  it('a bare ampersand in plain words is still a question', () => {
    const q = 'Do the host & the contestant both know where the car is?';
    expect(parseQuestion(q)).toBe(q);
  });

  it(`the length bound is ${QUESTION_MAX_CHARS} characters, inclusive`, () => {
    const fits = `${'a'.repeat(QUESTION_MAX_CHARS - 1)}?`;
    expect(parseQuestion(fits)).toBe(fits);
    expect(parseQuestion(`a${fits}`)).toBeNull();
  });

  it.each(malformed.filter(([, raw]) => typeof raw === 'string' && raw !== ''))(
    'through the route, %s: not-checked by votes, no question key, and the call still counts as asked',
    async (_name, raw, miss) => {
      await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
        const rec = recordHost(unsure, () => ({ content: raw as string }));
        try {
          const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
          expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'], votes: expect.any(Array) });
          expect(rec.questionCalls()).toHaveLength(1);
          expect(classifyStats(ON).questions).toEqual({ asked: 1, given: 0, none: 1, none_why: { [miss]: 1 } });
        } finally {
          rec.restore();
        }
      });
    },
  );
});

describe('none_why: why a question came back unusable, as counts', () => {
  // 2026-10-06 (BUS S37): production asked 5 questions and got 5 unusable replies, and nothing said
  // whether the model declined, ran out of tokens, or wrote something the parser rejects.
  it.each([
    ['an empty reply (the tokens went to reasoning)', '', 'empty'],
    ['reasoning cut off before the answer', '<think>The host policy matters and', 'cut_off_reasoning'],
    ['NONE', 'NONE', 'declined'],
  ])('%s is counted as %s, and the sum matches none', async (_name, content, why) => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      const rec = recordHost(unsure, () => ({ content }));
      try {
        await classifyTextWithPath(CLAIM, 2500, ON);
        await classifyTextWithPath(CLAIM, 2500, ON);
        const q = classifyStats(ON).questions!;
        expect(q).toEqual({ asked: 2, given: 0, none: 2, none_why: { [why]: 2 } });
        expect(JSON.stringify(q)).not.toContain('host policy');
      } finally {
        rec.restore();
      }
    });
  });

  it('is absent with the flag off, like the rest of the questions block', async () => {
    await withProcessEnv(CLEAN, async () => {
      expect(classifyStats(ENV).questions).toBeUndefined();
    });
  });
});

describe('time: the question fits inside the deadline or does not happen', () => {
  const DEADLINE = 800;

  // The last column is the none_why the stats must show. A slow reply races the route's deadline
  // against the call's own abort, which fire at the same moment, so either name is the right one.
  it.each([
    ['slower than the time left', { content: GOAT, delayMs: 5000 }, ['late', 'timeout']],
    ['hung, ignoring the abort signal', { content: GOAT, hang: true }, ['late']],
    ['a 429', { status: 429 }, ['rate_limited']],
    ['a 5xx', { status: 500 }, ['http_error']],
  ] as Array<[string, Reply, string[]]>)('a question call %s: no question, label unchanged, inside the deadline', async (_name, reply, why) => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      const rec = recordHost(unsure, () => reply);
      try {
        const res = await request(classifyApp({ deadlineMs: DEADLINE })).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'], votes: expect.any(Array) });
        expect(res.body.latency_ms).toBeLessThan(DEADLINE);
        expect(rec.questionCalls()).toHaveLength(1);
        const q = classifyStats(ON).questions!;
        expect({ asked: q.asked, given: q.given, none: q.none }).toEqual({ asked: 1, given: 0, none: 1 });
        expect(Object.values(q.none_why)).toEqual([1]);
        expect(why).toContain(Object.keys(q.none_why)[0]);
      } finally {
        rec.restore();
      }
    });
  });

  it('votes that leave too little time: the extra call is not made at all', async () => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      // 800 ms deadline, votes take ~450 ms: what is left after the headroom is under the minimum.
      const rec = recordHost(() => ({ content: 'UNSURE', delayMs: 450 }));
      try {
        const res = await request(classifyApp({ deadlineMs: DEADLINE })).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'], votes: expect.any(Array) });
        expect(rec.questionCalls()).toHaveLength(0);
        expect(classifyStats(ON).questions).toEqual({ asked: 0, given: 0, none: 0, none_why: {} });
      } finally {
        rec.restore();
      }
    });
  });

  it('the question call goes through the same budget as the votes: over budget, no request', async () => {
    await withProcessEnv(CLEAN, async () => {
      // Leave the first voter exactly one call: its vote spends it, so the question is refused.
      const pre = recordHost(() => ({ content: 'TRUE' }));
      for (let i = 0; i < BUDGET_PER_MIN.groq - 1; i += 1) await castVote(DEFAULT_VOTERS[0]!, 'x', { env: ENV, timeoutMs: 500 });
      pre.restore();
      const rec = recordHost(unsure);
      try {
        const out = await classifyTextWithPath(CLAIM, 2500, ON);
        expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'], votes: expect.any(Array) });
        expect(rec.questionCalls()).toHaveLength(0);
        // Refused before any request: not asked.
        expect(classifyStats(ON).questions).toEqual({ asked: 0, given: 0, none: 0, none_why: {} });
      } finally {
        rec.restore();
      }
    });
  });

  it('askQuestion never throws: a fetch that throws is an abstain', async () => {
    const boom = jest.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(askQuestion(DEFAULT_VOTERS[0]!, CLAIM, { env: ENV, fetchImpl: boom, timeoutMs: 500 })).resolves.toEqual({
      kind: 'abstain',
      reason: 'network',
    });
  });
});

describe('the data-locality boundary refuses the extra call exactly as it refuses votes', () => {
  it('askQuestion under the boundary abstains `boundary` and makes no request', async () => {
    await withProcessEnv({ ONLY_ATTESTATIONS_LEAVE: undefined }, async () => {
      const impl = jest.fn();
      const env = { ...ON, ONLY_ATTESTATIONS_LEAVE: 'true' } as NodeJS.ProcessEnv;
      expect(await askQuestion(DEFAULT_VOTERS[0]!, CLAIM, { env, fetchImpl: impl, timeoutMs: 500 })).toEqual({
        kind: 'abstain',
        reason: 'boundary',
      });
      expect(await castVote(DEFAULT_VOTERS[0]!, CLAIM, { env, fetchImpl: impl, timeoutMs: 500 })).toEqual({
        kind: 'abstain',
        reason: 'boundary',
      });
      expect(impl).not.toHaveBeenCalled();
    });
  });

  it('the route, boundary and flag both on: not-checked by skipped, and ZERO requests', async () => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on', ONLY_ATTESTATIONS_LEAVE: 'true' }, async () => {
      const rec = recordHost(unsure);
      try {
        const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'skipped' });
        expect(rec.calls).toHaveLength(0);
      } finally {
        rec.restore();
      }
    });
  });
});

describe('the question never rides on anything but not-checked by votes', () => {
  it('a pass, a veto, arithmetic and skipped from the real classifier carry no question', async () => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      for (const [content, label] of [['TRUE', 'pass'], ['FALSE', 'veto']]) {
        const rec = recordHost(() => ({ content }));
        try {
          const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
          expect(res.body).toEqual({ label, latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'], deciders: ['groq', 'groq'], votes: expect.any(Array) });
        } finally {
          rec.restore();
        }
      }
      const sum = await request(classifyApp()).post('/api/v1/classify').send({ text: '2 + 2 = 5' });
      expect(sum.body).toEqual({ label: 'veto', latency_ms: expect.any(Number), by: 'arithmetic' });
    });
  });

  it('the route drops a question an injected classifier attaches anywhere else, or one that fails the parse', async () => {
    const odd: Array<[unknown, Record<string, unknown>]> = [
      [{ label: 'pass', by: 'votes', voters: ['groq'], question: GOAT }, { label: 'pass', by: 'votes', voters: ['groq'] }],
      [{ label: 'veto', by: 'votes', voters: ['groq'], question: GOAT }, { label: 'veto', by: 'votes', voters: ['groq'] }],
      [{ label: 'pass', by: 'arithmetic', question: GOAT }, { label: 'pass', by: 'arithmetic' }],
      [{ label: 'not-checked', by: 'skipped', question: GOAT }, { label: 'not-checked', by: 'skipped' }],
      [
        { label: 'not-checked', by: 'votes', voters: ['groq'], question: 'See https://example.com?' },
        { label: 'not-checked', by: 'votes', voters: ['groq'] },
      ],
      [{ label: 'not-checked', by: 'votes', voters: ['groq'], question: 7 }, { label: 'not-checked', by: 'votes', voters: ['groq'] }],
      [
        { label: 'not-checked', by: 'votes', voters: ['groq'], question: GOAT },
        { label: 'not-checked', by: 'votes', voters: ['groq'], question: GOAT },
      ],
    ];
    for (const [answer, want] of odd) {
      const res = await request(classifyApp({ classifier: (() => answer) as unknown as Classifier }))
        .post('/api/v1/classify')
        .send({ text: 'x' });
      expect(res.body).toEqual({ ...want, latency_ms: expect.any(Number) });
    }
  });

  it('a question cannot survive a deadline cut', async () => {
    const late: Classifier = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ label: 'not-checked', by: 'votes', voters: ['groq'], question: GOAT }), 200),
      );
    const res = await request(classifyApp({ classifier: late, deadlineMs: 30 })).post('/api/v1/classify').send({ text: 'x' });
    expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'deadline' });
  });
});

describe('classifyText (the phone bot) is unchanged', () => {
  it('keeps its bare-label signature', () => {
    const sig: (text: string, deadlineMs?: number, env?: NodeJS.ProcessEnv) => Promise<ClassifyLabel> = classifyText;
    expect(typeof sig).toBe('function');
  });

  it('flag on and both UNSURE: a bare not-checked, and it asks no question it cannot show', async () => {
    await withProcessEnv(CLEAN, async () => {
      const rec = recordHost(unsure);
      try {
        const label = await classifyText(CLAIM, 2500, ON);
        expect(label).toBe('not-checked');
        expect(rec.calls).toHaveLength(2);
        expect(rec.questionCalls()).toHaveLength(0);
      } finally {
        rec.restore();
      }
    });
  });
});

describe('a reasoning block is not the question', () => {
  it('reads the question after a closed <think> block, and none from a cut-off one', () => {
    expect(parseQuestion('<think>The host policy matters.</think>\nDoes the host always open a door with a goat?')).toBe(
      'Does the host always open a door with a goat?',
    );
    expect(parseQuestion('<think>The host policy matters and')).toBeNull();
    expect(parseQuestion('<think>Does the host always open a goat door?</think>')).toBeNull();
  });
});
