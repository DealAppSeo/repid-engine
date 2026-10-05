/**
 * THE FALLBACK (src/classify/free-votes.ts, Sean 2026-10-05: "we need automated fallback for
 * graceful degradation"). A voter refused before any request hands its slot to a backup of the
 * same family, on a host the pair already uses, once the canary has seen that backup answer right.
 *
 * Measured the day it was built: five extension replies inside 8 seconds gave four stamps and one
 * Not checked, then five Not checked, all `abstains: {budget}` on Cerebras. These tests pin what
 * the fallback may and may not do. The hosts are stubbed: nothing here reaches a provider.
 */
const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import {
  __resetVoteCooldowns,
  activeVoters,
  backupsFor,
  BUDGET_PER_MIN,
  castVote,
  classifyByFreeVotes,
  CROSS_FAMILY_VOTERS,
  DEFAULT_VOTERS,
  modelFamily,
  standbyVoters,
  VOTER_BACKUPS,
  type Voter,
} from '../src/classify/free-votes';
import * as health from '../src/classify/vote-health';
import { classifyTextWithPath } from '../src/routes/classify';

const ENV = { GROQ_API_KEY: 'test-key-not-real', CEREBRAS_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv;
const [GROQ_120B, CEREBRAS_QWEN] = CROSS_FAMILY_VOTERS as [Voter, Voter];
const GROQ_20B: Voter = { provider: 'groq', model: 'openai/gpt-oss-20b' };
const GROQ_QWEN: Voter = { provider: 'groq', model: 'qwen/qwen3.8-27b' };
const key = (v: Voter) => `${v.provider}:${v.model}`;

type Answer = { status?: number; content?: string; delayMs?: number };
type Call = { host: 'groq' | 'cerebras' | 'other'; model: string; claim: string; body: Record<string, unknown> };

/** One stub for every host. `answer` sees which host and model was asked, and the claim. */
function hosts(answer: (c: Call) => Answer) {
  const calls: Call[] = [];
  const impl = jest.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const u = String(url);
    const messages = body.messages as Array<{ content: string }>;
    const call: Call = {
      host: u.includes('groq') ? 'groq' : u.includes('cerebras') ? 'cerebras' : 'other',
      model: String(body.model),
      claim: messages[1]?.content ?? '',
      body,
    };
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

describe('the backup table keeps the pair what it was', () => {
  it('every backup is the same family as the voter it replaces', () => {
    for (const [primary, backups] of Object.entries(VOTER_BACKUPS)) {
      const model = primary.slice(primary.indexOf(':') + 1);
      for (const b of backups) expect(modelFamily(b.model)).toBe(modelFamily(model));
    }
  });

  it('for the production pair: same family, a host the pair uses, never a voter of the pair', () => {
    expect(backupsFor(GROQ_120B, CROSS_FAMILY_VOTERS)).toEqual([GROQ_20B]);
    expect(backupsFor(CEREBRAS_QWEN, CROSS_FAMILY_VOTERS)).toEqual([GROQ_QWEN]);
    const hostsUsed = new Set(CROSS_FAMILY_VOTERS.map((v) => v.provider));
    for (const v of standbyVoters(ENV)) expect(hostsUsed.has(v.provider)).toBe(true);
  });

  it('Groq x2 (no Cerebras key) has no backup: gpt-oss-20b is already the second vote', () => {
    const env = { GROQ_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv;
    expect(activeVoters(env)).toBe(DEFAULT_VOTERS);
    expect(standbyVoters(env)).toEqual(DEFAULT_VOTERS);
  });

  it('CLASSIFY_FALLBACK=off: the standby list is the pair alone', () => {
    expect(standbyVoters({ ...ENV, CLASSIFY_FALLBACK: 'off' })).toEqual(CROSS_FAMILY_VOTERS);
    expect(standbyVoters({ ...ENV, CLASSIFY_FALLBACK: ' OFF ' })).toEqual(CROSS_FAMILY_VOTERS);
  });

  it('families read from ids', () => {
    expect(modelFamily('openai/gpt-oss-120b')).toBe('gpt-oss');
    expect(modelFamily('qwen-3.8-27b')).toBe('qwen');
    expect(modelFamily('qwen/qwen3.8-27b')).toBe('qwen');
    expect(modelFamily('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe('llama');
  });
});

describe('Cerebras over its budget: the same qwen on Groq stands in', () => {
  it('a both-TRUE claim passes, by two Groq models, instead of Not checked', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 2500, ENV);
    expect(out).toEqual({ label: 'pass', by: 'votes', voters: ['groq', 'groq'] });
    expect(h.calls.map((c) => `${c.host}:${c.model}`).sort()).toEqual([key(GROQ_120B), key(GROQ_QWEN)].sort());
    expect(h.calls.some((c) => c.host === 'cerebras')).toBe(false);
  });

  it('a both-FALSE claim is vetoed the same way', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    globalThis.fetch = hosts(() => ({ content: 'FALSE' })).impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('The Sun orbits the Earth.', 2500, ENV)).label).toBe('veto');
  });

  it('the backup carries the qwen reasoning switch, as the Cerebras call does', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 2500, ENV);
    expect(h.calls.find((c) => c.model === GROQ_QWEN.model)!.body.reasoning_effort).toBe('none');
  });

  it('the stats show the refused primary and the backup that answered', async () => {
    await canaryAllOk();
    await exhaust(CEREBRAS_QWEN);
    globalThis.fetch = hosts(() => ({ content: 'TRUE' })).impl as unknown as typeof fetch;
    await classifyTextWithPath('Paris is the capital of France.', 2500, ENV);
    const rows = health.classifyStats(ENV).voters;
    expect(rows.find((r) => r.voter === key(CEREBRAS_QWEN))!.abstains.budget).toBe(1);
    expect(rows.find((r) => r.voter === key(GROQ_QWEN))!.verdicts.TRUE).toBe(1);
  });
});

describe('Groq gpt-oss-120b refused: gpt-oss-20b stands in', () => {
  it('after a 429 the 120b cools down, and the next claim is decided by 20b + qwen', async () => {
    await canaryAllOk();
    // The 429 itself was sent, so that claim stays not-checked; the next one falls back.
    const first = hosts((c) => (c.model === GROQ_120B.model ? { status: 429 } : { content: 'TRUE' }));
    globalThis.fetch = first.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 2500, ENV)).label).toBe('not-checked');
    expect(first.calls.some((c) => c.model === GROQ_20B.model)).toBe(false);

    const second = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = second.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Water boils at 100 degrees Celsius at sea level.', 2500, ENV);
    expect(out).toEqual({ label: 'pass', by: 'votes', voters: ['groq', 'cerebras'] });
    expect(second.calls.map((c) => c.model).sort()).toEqual([GROQ_20B.model, CEREBRAS_QWEN.model].sort());
  });
});

describe('never shopping for a verdict: a vote that was SENT is that slot’s answer', () => {
  it.each([
    ['UNSURE', { content: 'UNSURE' }],
    ['an unparseable answer', { content: 'TRUE, probably' }],
    ['a 5xx', { status: 503 }],
    ['a 429', { status: 429 }],
    ['a timeout', { delayMs: 2000 }],
  ])('Cerebras answering %s: no backup is dialled, and the label is not-checked', async (_why, cerebras) => {
    await canaryAllOk();
    const h = hosts((c) => (c.host === 'cerebras' ? cerebras : { content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 1500, ENV);
    expect(out.label).toBe('not-checked');
    expect(h.calls.some((c) => c.model === GROQ_QWEN.model)).toBe(false);
  });
});

describe('a backup is used only once the canary has seen it answer right', () => {
  it('no canary yet: Cerebras over budget is Not checked, and the backup is never dialled', async () => {
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    const out = await classifyTextWithPath('Paris is the capital of France.', 2500, ENV);
    expect(out).toEqual({ label: 'not-checked', by: 'votes', voters: ['groq'] });
    expect(h.calls.some((c) => c.model === GROQ_QWEN.model)).toBe(false);
  });

  it('a backup whose canary was wrong stays out', async () => {
    await health.runCanary({
      env: ENV,
      fetchImpl: hosts((c) => (c.model === GROQ_QWEN.model ? { content: 'TRUE' } : truthful(c))).impl,
      timeoutMs: 500,
    });
    __resetVoteCooldowns();
    expect(health.canaryOk(GROQ_QWEN)).toBe(false);
    expect(health.canaryOk(CEREBRAS_QWEN)).toBe(true);
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 2500, ENV)).label).toBe('not-checked');
    expect(h.calls.some((c) => c.model === GROQ_QWEN.model)).toBe(false);
  });

  it('the canary asks the backups too, and the stats list them', async () => {
    const h = hosts(truthful);
    await health.runCanary({ env: ENV, fetchImpl: h.impl, timeoutMs: 500 });
    expect(new Set(h.calls.map((c) => c.model))).toEqual(
      new Set([GROQ_120B.model, CEREBRAS_QWEN.model, GROQ_20B.model, GROQ_QWEN.model]),
    );
    const rows = health.classifyStats(ENV).voters.map((r) => r.voter);
    expect(rows.slice(0, 2)).toEqual(CROSS_FAMILY_VOTERS.map(key));
    expect(new Set(rows)).toEqual(new Set([GROQ_120B, CEREBRAS_QWEN, GROQ_20B, GROQ_QWEN].map(key)));
  });

  it('CLASSIFY_FALLBACK=off: canary-ok backups are still never used', async () => {
    const env = { ...ENV, CLASSIFY_FALLBACK: 'off' };
    await canaryAllOk(ENV);
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    globalThis.fetch = h.impl as unknown as typeof fetch;
    expect((await classifyTextWithPath('Paris is the capital of France.', 2500, env)).label).toBe('not-checked');
    expect(h.calls.some((c) => c.model === GROQ_QWEN.model)).toBe(false);
  });
});

describe('one model is never two votes', () => {
  it('CLASSIFY_VOTERS naming the same voter twice cannot pass, even with both TRUE', async () => {
    const same = [GROQ_120B, GROQ_120B];
    const r = await classifyByFreeVotes('Paris is the capital of France.', {
      env: ENV,
      fetchImpl: hosts(() => ({ content: 'TRUE' })).impl,
      timeoutMs: 500,
      voters: same,
    });
    expect(r.label).toBe('not-checked');
  });

  it('without backupReady (every caller but the route) the pair is exactly the pair', async () => {
    await exhaust(CEREBRAS_QWEN);
    const h = hosts(() => ({ content: 'TRUE' }));
    const r = await classifyByFreeVotes('x', { env: ENV, fetchImpl: h.impl, timeoutMs: 500 });
    expect(r.label).toBe('not-checked');
    expect(r.attempts.map((t) => key(t.voter))).toEqual(CROSS_FAMILY_VOTERS.map(key));
  });
});
