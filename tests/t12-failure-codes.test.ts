/**
 * P-01: say why a T12 maker failed, as closed-set codes. Calibration T12-CAL-2026-11-11-c1 could not tell a harmless
 * `./x` from a wrong file (both `path_outside_lease`), nor a timeout from a cut-off stream (both `providers.failed`).
 * Every fixture runs the real producer (readMakerFiles, t12Ask) into the real record. Fake fetch only; no network.
 */
jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));

import { buildDailyRecord, type ProviderFailureCode } from '../src/orchestration/t12-daily-record';
import { leasePathCode, readMakerFiles } from '../src/orchestration/t12-lane-git';
import { t12Ask, type T12RouteAttempt } from '../src/orchestration/t12-attempt';
import type { DecisionReceipt, LaneState } from '../src/orchestration/t12-lane-store';

const DAY = '2026-11-13';
const at = `${DAY}T03:00:00.000Z`;
const receipt = (event: string, reason: string, evidence: unknown = {}): DecisionReceipt => ({ seq: 0, at, actor: 'trinity-lane-1', origin: 'scheduled', event, from: 'a', to: 'b', epoch: 1, reason, evidence, prev: '0', hash: `h-${event}` });
const row = (receipts: DecisionReceipt[]) => ({ state: { spec: { id: 't' }, receipts } as unknown as LaneState });

const LEASE = ['tests/parse-autonomy.test.ts'];
/** What make() in t12-lane-git.ts writes on a refusal, then what the record keeps of it. */
function refusalFor(path: string) {
  const read = readMakerFiles(JSON.stringify({ files: [{ path, content: 'x' }] }), LEASE);
  if (!('reason' in read)) throw new Error(`${path} was admitted`);
  const reason = `model output was not a valid file set inside the lease: ${read.reason}`;
  return { reason, record: buildDailyRecord([row([receipt('maker_failed', reason)])], DAY, 'real') };
}

describe('a refused maker path gets one code, and the record never holds the path', () => {
  it.each<[string, string]>([
    ['same_after_normalize', './tests/parse-autonomy.test.ts'],
    ['same_after_normalize', 'tests\\parse-autonomy.test.ts'],
    ['same_after_normalize', 'tests//parse-autonomy.test.ts'],
    ['escapes_root', '..\\tests\\parse-autonomy.test.ts'],
    ['escapes_root', '../tests/parse-autonomy.test.ts'],
    ['escapes_root', 'tests/../tests/parse-autonomy.test.ts'],
    ['escapes_root', '/tests/parse-autonomy.test.ts'],
    ['escapes_root', 'C:\\tests\\parse-autonomy.test.ts'],
    ['other_path', 'src/lib/autonomy.ts'],
    ['other_path', 'tests/parse-autonomy.test.ts\n'],
  ])('%s: %j', (code, path) => {
    const { record } = refusalFor(path);
    expect(record.refusals).toEqual([{ task: 't', code: 'path_outside_lease', path_code: code }]);
  });

  it('still refuses every variant: a label is not admission', () => {
    for (const p of ['./tests/parse-autonomy.test.ts', 'tests\\parse-autonomy.test.ts', '..\\x', '/etc/passwd']) {
      expect(readMakerFiles(JSON.stringify({ files: [{ path: p, content: 'x' }] }), LEASE)).toHaveProperty('reason');
    }
    expect(readMakerFiles(JSON.stringify({ files: [{ path: LEASE[0], content: 'x' }] }), LEASE)).toEqual({ files: [{ path: LEASE[0], content: 'x' }] });
  });

  it('copies no part of the path into the record, while the receipt keeps it', () => {
    const marker = 'zz-marker-7f3a/parse-autonomy.test.ts';
    const { reason, record } = refusalFor(marker);
    expect(reason).toContain(marker);
    expect(JSON.stringify(record)).not.toContain('zz-marker-7f3a');
  });

  it('a crafted path cannot forge the code, which the lane writes before the path', () => {
    const { record } = refusalFor('x): outside the lease (same_after_normalize): y');
    expect(record.refusals).toEqual([{ task: 't', code: 'path_outside_lease', path_code: 'other_path' }]);
  });

  it('labels from the path alone', () => {
    expect(leasePathCode('./a', ['a'])).toBe('same_after_normalize');
    expect(leasePathCode('./a', ['b'])).toBe('other_path');
  });
});

/** Run the real t12Ask on one host, feed its attempt reason into the record as recordRouteAttempt would. */
async function failureOf(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const attempts: T12RouteAttempt[] = [];
  const env = { T12_FREE_WAVE: 'true', T12_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1' };
  await t12Ask('q', { env, order: ['local'], timeoutMs: 50, fetchImpl: fetchImpl as never, onAttempt: (a) => { attempts.push(a); } });
  const receipts = attempts.map((a) => receipt('route_attempt', a.reason, { provider: a.host, reason: a.reason, status: a.status }));
  const [use] = buildDailyRecord([row(receipts)], DAY, 'real').providers;
  return use!;
}
const reply = (status: number, text: () => Promise<string>) => async () => ({ status, headers: { get: () => null }, text });
const chunk = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const NONE = { timeout: 0, stream_cut: 0, http_error: 0, connect_error: 0, empty_answer: 0, other: 0 };
const only = (code: ProviderFailureCode) => ({ ...NONE, [code]: 1 });

describe('a provider failure gets one code instead of one count', () => {
  it.each<[ProviderFailureCode, (url: string, init: RequestInit) => Promise<unknown>]>([
    ['timeout', (_u, init) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))],
    ['timeout', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }); }],
    ['stream_cut', reply(200, async () => chunk('{"files":[{"path":"t.ts","content":"o'))],
    ['stream_cut', reply(200, async () => { throw new TypeError('terminated'); })],
    ['http_error', reply(500, async () => '')],
    ['connect_error', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }],
    ['empty_answer', reply(200, async () => `${chunk('')}data: [DONE]\n\n`)],
  ])('%s', async (code, impl) => {
    const use = await failureOf(impl);
    expect(use).toMatchObject({ attempts: 1, answered: 0, rate_limited: 0, failed: only(code) });
  });

  it('counts an answer only when there was one', async () => {
    expect(await failureOf(reply(200, async () => `${chunk('{"files":[]}')}data: [DONE]\n\n`))).toMatchObject({ attempts: 1, answered: 1, failed: NONE });
  });
});
