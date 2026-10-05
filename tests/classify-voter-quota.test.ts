/**
 * The vendor's own count of requests left today, per voter, on /classify/stats.
 *
 * 2026-10-05: paced eval runs stayed under Groq's 30 a minute and still spent its 1,000 requests a
 * day for openai/gpt-oss-120b by about 06:40Z. From then on every check was not-checked
 * (skip_rate 0.948) and the stats said only `cooling`. Groq reports the day's remainder on every
 * reply; these tests pin that it is read, shown, and never invented. The host is stubbed.
 */
const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import { __resetVoteCooldowns, castVote, DEFAULT_VOTERS, voterQuota, type Voter } from '../src/classify/free-votes';
import { __resetClassifyStats, classifyStats, recordVotes } from '../src/classify/vote-health';

const ENV = { GROQ_API_KEY: 'test-key-not-real', CEREBRAS_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv;
const GROQ = DEFAULT_VOTERS.find((v) => v.provider === 'groq')!;
const CEREBRAS: Voter = { provider: 'cerebras', model: 'qwen-3.8-27b' };
const key = (v: Voter) => `${v.provider}:${v.model}`;

function host(status: number, content: string, headers: Record<string, string>) {
  return jest.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers }),
  );
}

const GROQ_DAY = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '59',
  'x-ratelimit-reset-requests': '2m59.56s',
  // Groq's TPM headers are per MINUTE; they must not be read as the day.
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-tokens': '7990',
};

beforeEach(() => {
  __resetVoteCooldowns();
  __resetClassifyStats();
});

describe("Groq's requests-per-day headers", () => {
  it('a reply records limit, remaining and reset; the vote itself is unchanged', async () => {
    const out = await castVote(GROQ, 'Paris is in France.', { env: ENV, fetchImpl: host(200, 'TRUE', GROQ_DAY), timeoutMs: 500 });
    expect(out).toEqual({ kind: 'verdict', verdict: 'TRUE' });
    expect(voterQuota(key(GROQ))).toMatchObject({
      limit_requests_day: 1000,
      remaining_requests_day: 59,
      reset_requests_day: '2m59.56s',
    });
  });

  it('a 429 still records what is left, and still abstains rate_limited', async () => {
    const headers = { ...GROQ_DAY, 'x-ratelimit-remaining-requests': '0', 'retry-after': '30' };
    const out = await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(429, '', headers), timeoutMs: 500 });
    expect(out).toEqual({ kind: 'abstain', reason: 'rate_limited' });
    expect(voterQuota(key(GROQ))?.remaining_requests_day).toBe(0);
  });

  it('/classify/stats shows the reading under the voter', async () => {
    const out = await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(200, 'FALSE', GROQ_DAY), timeoutMs: 500 });
    recordVotes([GROQ], [out]);
    const row = classifyStats(ENV).voters.find((v) => v.voter === key(GROQ));
    expect(row?.quota).toMatchObject({ limit_requests_day: 1000, remaining_requests_day: 59 });
    expect(typeof row?.quota?.at).toBe('string');
  });
});

describe('not seen is not zero', () => {
  it('no call yet: quota is null on the stats row, never 0', () => {
    const row = classifyStats(ENV).voters.find((v) => v.voter === key(GROQ));
    expect(row).toBeDefined();
    expect(row!.quota).toBeNull();
  });

  it('a reply without the headers keeps the last reading rather than erasing it', async () => {
    await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(200, 'TRUE', GROQ_DAY), timeoutMs: 500 });
    await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(200, 'TRUE', {}), timeoutMs: 500 });
    expect(voterQuota(key(GROQ))?.remaining_requests_day).toBe(59);
  });

  it('a call refused before the wire (no key) reads nothing', async () => {
    const impl = host(200, 'TRUE', GROQ_DAY);
    await castVote(GROQ, 'x', { env: {}, fetchImpl: impl, timeoutMs: 500 });
    expect(impl).not.toHaveBeenCalled();
    expect(voterQuota(key(GROQ))).toBeNull();
  });
});

describe('only plain counts are kept', () => {
  it.each([
    ['-1', 'a negative'],
    ['1e9', 'an exponent'],
    ['59.5', 'a fraction'],
    ['<b>9</b>', 'markup'],
    ['', 'empty'],
  ])('remaining %j (%s) is null, not a number', async (raw) => {
    const headers = { ...GROQ_DAY, 'x-ratelimit-remaining-requests': raw };
    await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(200, 'TRUE', headers), timeoutMs: 500 });
    expect(voterQuota(key(GROQ))?.remaining_requests_day).toBeNull();
    expect(voterQuota(key(GROQ))?.limit_requests_day).toBe(1000);
  });

  it('a reset string that is not a plain duration is dropped', async () => {
    const headers = { ...GROQ_DAY, 'x-ratelimit-reset-requests': '2m <script>' };
    await castVote(GROQ, 'x', { env: ENV, fetchImpl: host(200, 'TRUE', headers), timeoutMs: 500 });
    expect(voterQuota(key(GROQ))?.reset_requests_day).toBeNull();
  });
});

describe('each provider reads its own names', () => {
  it("Cerebras reads the -day names, and does not read Groq's per-day names as its own", async () => {
    const groqStyle = host(200, 'TRUE', GROQ_DAY);
    await castVote(CEREBRAS, 'x', { env: ENV, fetchImpl: groqStyle, timeoutMs: 500 });
    expect(voterQuota(key(CEREBRAS))).toBeNull();

    const dayStyle = host(200, 'TRUE', {
      'x-ratelimit-limit-requests-day': '14400',
      'x-ratelimit-remaining-requests-day': '14000',
      'x-ratelimit-reset-requests-day': '33011.38',
    });
    await castVote(CEREBRAS, 'x', { env: ENV, fetchImpl: dayStyle, timeoutMs: 500 });
    expect(voterQuota(key(CEREBRAS))).toMatchObject({ limit_requests_day: 14400, remaining_requests_day: 14000 });
  });
});
