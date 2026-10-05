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
  questionsEnabled,
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
        expect(res.body).toMatchObject({ label: 'not-checked', by: 'votes', voters: ['groq', 'groq'] });
        expect(Object.keys(res.body)).toEqual(['label', 'latency_ms', 'by', 'voters']);
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
        expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq', 'cerebras'], question: GOAT });
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
      expect(s.questions).toEqual({ asked: 2, given: 1, none: 1 });
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

  const malformed: Array<[string, unknown]> = [
    ['no question mark', 'Does the host always open a goat door'],
    ['too long', `Does the host ${'always '.repeat(30)}open a goat door?`],
    ['too short', 'Which one?'.slice(1)],
    ['two lines', 'Does the host know?\nDoes the host always open a goat door?'],
    ['NONE', 'NONE'],
    ['None.', 'None.'],
    ['NONE plus a question', 'NONE. Does the host always open a goat door?'],
    ['an http URL', 'Is it the version at https://example.com/monty?'],
    ['a www host', 'Is it the version on www.example.org?'],
    ['a bare domain', 'Is it the version described on example.com?'],
    ['a script scheme', 'Is it javascript:alert(1) or not?'],
    ['an email', 'Should I ask host@example.com about the doors?'],
    ['markdown bold', 'Does the host **always** open a goat door?'],
    ['markdown code', 'Does `host.open()` always pick a goat?'],
    ['markdown link', 'Is it the [classic](x) version of the game?'],
    ['a heading', '# Does the host always open a goat door?'],
    ['a list item', '- Does the host always open a goat door?'],
    ['a verdict word', 'UNSURE: does the host always open a goat door?'],
    ['a verdict word mid-line', 'Is it TRUE that the host always opens a goat door?'],
    ['a lower-case verdict lead', 'false, unless: does the host know where the car is?'],
    ['a fullwidth verdict look-alike', '\uFF34\uFF32\uFF35\uFF25 if the host knows the car, does he?'],
    ['an invisible character', 'Does the host\u200B always open a goat door?'],
    ['not a string', 42],
    ['empty', ''],
  ];
  it.each(malformed)('%s: no question', (_name, raw) => {
    expect(parseQuestion(raw)).toBeNull();
  });

  it(`the length bound is ${QUESTION_MAX_CHARS} characters, inclusive`, () => {
    const fits = `${'a'.repeat(QUESTION_MAX_CHARS - 1)}?`;
    expect(parseQuestion(fits)).toBe(fits);
    expect(parseQuestion(`a${fits}`)).toBeNull();
  });

  it.each(malformed.filter(([, raw]) => typeof raw === 'string' && raw !== ''))(
    'through the route, %s: not-checked by votes, no question key, and the call still counts as asked',
    async (_name, raw) => {
      await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
        const rec = recordHost(unsure, () => ({ content: raw as string }));
        try {
          const res = await request(classifyApp()).post('/api/v1/classify').send({ text: CLAIM });
          expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'] });
          expect(rec.questionCalls()).toHaveLength(1);
          expect(classifyStats(ON).questions).toEqual({ asked: 1, given: 0, none: 1 });
        } finally {
          rec.restore();
        }
      });
    },
  );
});

describe('time: the question fits inside the deadline or does not happen', () => {
  const DEADLINE = 800;

  it.each([
    ['slower than the time left', { content: GOAT, delayMs: 5000 }],
    ['hung, ignoring the abort signal', { content: GOAT, hang: true }],
    ['a 429', { status: 429 }],
    ['a 5xx', { status: 500 }],
  ] as Array<[string, Reply]>)('a question call %s: no question, label unchanged, inside the deadline', async (_name, reply) => {
    await withProcessEnv({ ...CLEAN, CLASSIFY_QUESTIONS: 'on' }, async () => {
      const rec = recordHost(unsure, () => reply);
      try {
        const res = await request(classifyApp({ deadlineMs: DEADLINE })).post('/api/v1/classify').send({ text: CLAIM });
        expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'] });
        expect(res.body.latency_ms).toBeLessThan(DEADLINE);
        expect(rec.questionCalls()).toHaveLength(1);
        expect(classifyStats(ON).questions).toEqual({ asked: 1, given: 0, none: 1 });
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
        expect(res.body).toEqual({ label: 'not-checked', latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'] });
        expect(rec.questionCalls()).toHaveLength(0);
        expect(classifyStats(ON).questions).toEqual({ asked: 0, given: 0, none: 0 });
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
        expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq', 'groq'] });
        expect(rec.questionCalls()).toHaveLength(0);
        // Refused before any request: not asked.
        expect(classifyStats(ON).questions).toEqual({ asked: 0, given: 0, none: 0 });
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
          expect(res.body).toEqual({ label, latency_ms: expect.any(Number), by: 'votes', voters: ['groq', 'groq'] });
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
