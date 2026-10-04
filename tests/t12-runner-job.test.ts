/**
 * B21 — the first caller of t12Ask: a labelled-claims job on a loopback model in a free runner.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLAIMS, promptFor, readLoose, receiptMarkdown, runClaimsJob } from '../src/orchestration/t12-runner-job';
import { t12Ask, t12Target } from '../src/orchestration/t12-attempt';
import type { T12AskResult } from '../src/orchestration/t12-attempt';

const answered = (text: string, host = 'local'): T12AskResult => ({ outcome: 'answered', host, tried: [host], text });

describe('readLoose', () => {
  it.each([
    ['TRUE', 'TRUE'],
    ['false.', 'FALSE'],
    ['TRUE. Water is H2O.', 'TRUE'],
    ['**FALSE**', 'FALSE'],
  ])('%j → %s', (raw, want) => expect(readLoose(raw)).toBe(want));
  it.each(['I think so', 'The claim is TRUE', '', null])('unparseable: %j', (raw) =>
    expect(readLoose(raw as string | null)).toBeNull(),
  );
});

describe('runClaimsJob', () => {
  it('scores every claim and names the host on each', async () => {
    const r = await runClaimsJob(async (p) => answered(CLAIMS.find((c) => p.includes(c.claim))!.expected), {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'abc123',
      T12_LOCAL_MODEL: 'qwen2.5:1.5b',
    });
    expect(r).toMatchObject({ verdict: 'VERIFIED', answered: 6, correct: 6, total: 6, accuracy: 1 });
    expect(r.hosts).toEqual({ local: 6 });
    expect(r.runner).toBe('github-actions');
    expect(r.commit).toBe('abc123');
    expect(r.results.every((x) => x.host === 'local')).toBe(true);
  });

  it('nothing answered is NOT_CHECKED with accuracy null, never a 0', async () => {
    const r = await runClaimsJob(async () => ({ outcome: 'NOT_CHECKED', host: null, tried: ['local'], text: null }), {});
    expect(r.verdict).toBe('NOT_CHECKED');
    expect(r.accuracy).toBeNull();
    expect(r.answered).toBe(0);
  });

  it('an unparseable answer is not scored, and a wrong one counts as wrong', async () => {
    const replies = ['maybe', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE']; // c1 unparseable
    let i = 0;
    const r = await runClaimsJob(async () => answered(replies[i++]!), {});
    expect(r.answered).toBe(5);
    expect(r.results[0]!.correct).toBeNull();
    expect(r.correct).toBe(2); // c3, c5 right; c2, c4, c6 are FALSE claims answered TRUE
  });

  it('a 429 stops the job: no further claim is asked', async () => {
    const ask = jest.fn(async () => ({ outcome: 'rate_limited' as const, host: 'local', tried: ['local'], text: null }));
    const r = await runClaimsJob(ask, {});
    expect(ask).toHaveBeenCalledTimes(1);
    expect(r.results).toHaveLength(1);
  });

  it('a thrown ask is NOT_CHECKED for that claim, not a crash', async () => {
    const r = await runClaimsJob(async () => {
      throw new Error('boom');
    }, {});
    expect(r.verdict).toBe('NOT_CHECKED');
  });

  it('the prompt asks for one word and carries the claim', () => {
    expect(promptFor('X is Y.')).toMatch(/exactly one word, TRUE or FALSE/);
    expect(promptFor('X is Y.')).toContain('Claim: X is Y.');
  });

  it('the summary names the ruler, the model and each host', async () => {
    const r = await runClaimsJob(async () => answered('TRUE'), { T12_LOCAL_MODEL: 'm' });
    const md = receiptMarkdown(r);
    expect(md).toContain('t12-claims-v1');
    expect(md).toContain('`m`');
    expect(md).toContain('local ×6');
  });
});

describe('end to end through the real t12Ask, loopback stubbed', () => {
  it('the flag on with a loopback base answers from local and sends that host no key', async () => {
    const env = {
      T12_FREE_WAVE: 'true',
      T12_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
      T12_LOCAL_MODEL: 'qwen2.5:1.5b',
      GROQ_API_KEY: '',
    };
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return { status: 200, headers: null, text: async () => JSON.stringify({ choices: [{ message: { content: 'TRUE' } }] }) };
    };
    const r = await runClaimsJob((p) => t12Ask(p, { env, fetchImpl }), env);
    expect(r.hosts).toEqual({ local: 6 });
    expect(seen.every((s) => s.url === 'http://127.0.0.1:11434/v1/chat/completions' && s.auth === undefined)).toBe(true);
  });

  it('the flag off makes no call and the job is NOT_CHECKED', async () => {
    const fetchImpl = jest.fn();
    const r = await runClaimsJob((p) => t12Ask(p, { env: {}, fetchImpl }), {});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.verdict).toBe('NOT_CHECKED');
  });
});

describe('workflow guard', () => {
  const wf = readFileSync(path.join(__dirname, '..', '.github', 'workflows', 't12-loopback.yml'), 'utf8');
  it('is dispatch-only, read-only, passes no secret, and sets the flag only on the job step', () => {
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(wf).not.toMatch(/^\s*schedule:/m);
    expect(wf).not.toContain('secrets.');
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(wf).toContain("T12_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1'");
  });
});
