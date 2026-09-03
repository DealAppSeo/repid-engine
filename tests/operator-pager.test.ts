/**
 * The pager, and the four ways a pager lies.
 *
 * WHAT THIS IS FOR. Sean asked for one thing: when it fails, fail loud to him, and to nobody
 * else. Every assertion here is one of the ways that promise breaks.
 *
 *   it pages nobody          — unarmed, and nothing says so
 *   it pages everybody       — an agent's webhook learns the attester key is missing
 *   it pages too often       — 288 identical messages a day, so the channel gets muted
 *   it breaks what it watches— a pager throwing inside the anchor loop, on a money path
 *
 * The last is the one that matters most and is the easiest to get wrong: `markDegraded` is
 * SYNCHRONOUS, returns a value used inline, and is called from the anchor worker's batch loop.
 * A pager that can throw or block there converts "we noticed a problem" into a worse one.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const emitAuditEvent = jest.fn<(e: unknown) => Promise<void>>();
jest.mock('../src/services/audit-emit', () => ({ emitAuditEvent: (e: unknown) => emitAuditEvent(e) }));

const insert = jest.fn<(row: unknown) => Promise<{ error: unknown }>>();
const from = jest.fn((t: string) => ({ insert: (row: unknown) => insert({ __table: t, ...(row as object) }) }));
jest.mock('../src/db', () => ({ db: { from: (t: string) => from(t) } }));

import {
  pageOperator, pagerStatus, announcePagerStatus, _resetPagerCooldown, PAGE_COOLDOWN_MS,
} from '../src/services/operator-pager';

const flush = () => new Promise((r) => setImmediate(r));
const ENV = { ...process.env };

beforeEach(() => {
  _resetPagerCooldown();
  emitAuditEvent.mockReset().mockResolvedValue(undefined);
  insert.mockReset().mockResolvedValue({ error: null });
  from.mockClear();
  process.env['TELEGRAM_BOT_TOKEN'] = 'tok';
  process.env['TELEGRAM_OWNER_CHAT_ID'] = '123';
  global.fetch = jest.fn(async () => new Response('ok', { status: 200 })) as never;
});
afterEach(() => { process.env = { ...ENV }; });

describe('two channels, because one of them could not be armed', () => {
  // MEASURED 2026-09-02 → 09-03: the single-channel version shipped to production reporting
  // armed:false with both env vars unset, four checks over ten hours. A pager that cannot be
  // armed by the person who built it is not a pager. RECORD needs no secret; PUSH needs two.
  it('PUSH needs BOTH env vars — either alone wakes nobody', () => {
    delete process.env['TELEGRAM_OWNER_CHAT_ID'];
    const s = pagerStatus();
    expect(s.push_armed).toBe(false);
    expect(s.missing).toEqual(['TELEGRAM_OWNER_CHAT_ID']);
    // A token with no chat id is the trap: it LOOKS configured and delivers to nobody.
    expect(process.env['TELEGRAM_BOT_TOKEN']).toBeTruthy();
  });

  it('RECORD is armed regardless — the failure is never LOST', () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_OWNER_CHAT_ID'];
    const s = pagerStatus();
    expect(s.armed).toBe(true);                       // captured
    expect(s.push_armed).toBe(false);                 // but nobody woken
    expect(s.channels).toEqual({ record: 'ops_alerts', push: 'none' });
  });

  it('boot says RECORD ONLY — not "nothing is watching", which would be false', () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = announcePagerStatus();
    expect(s.push_armed).toBe(false);
    expect(warn.mock.calls[0]![0]).toMatch(/RECORD ONLY/);
    expect(warn.mock.calls[0]![0]).toMatch(/NOBODY WILL BE WOKEN/);
    warn.mockRestore();
  });

  it('with push unarmed the alert is still RECORDED, and the audit says which', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    pageOperator('eas-anchor', 'attester key missing');
    await flush();
    expect(from).toHaveBeenCalledWith('ops_alerts');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      alert_type: 'eas-anchor:attester key missing',
    }));
    // "recorded but not pushed" must not collapse into "dropped" — different states.
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ recorded: true, pushed: false, push_armed: false }),
    }));
  });

  it('a failed RECORD write is reported, not assumed successful', async () => {
    insert.mockResolvedValue({ error: { code: '42P01', message: 'relation does not exist' } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    pageOperator('proof-drain', 'canonical write rejected');
    await flush();
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ recorded: false }),
    }));
    err.mockRestore();
  });

  it('the dedupe key and the alert_type are the SAME string', async () => {
    // So a query grouping on alert_type counts CONDITIONS, not repetitions of one condition.
    pageOperator('hal', 'quorum not met');
    pageOperator('hal', 'quorum not met');
    await flush();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ alert_type: 'hal:quorum not met' }));
  });
});

describe('it reaches the owner chat and only the owner chat', () => {
  it('posts to Telegram with the configured chat id', async () => {
    pageOperator('eas-anchor', 'attester key missing', { worker: 'eas-anchor' });
    await flush();
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottok/sendMessage');
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe('123');
    expect(body.text).toMatch(/eas-anchor/);
    expect(body.text).toMatch(/attester key missing/);
  });

  it('never RESOLVES a recipient from the database', () => {
    // The separation Sean asked for, restated precisely. The first version of this test banned
    // the db import outright — a fine proxy while the module had no reason to touch Postgres,
    // and wrong the moment the RECORD channel started writing ops_alerts. Banning the import
    // would now block the only channel that can actually be armed without a secret. So it is
    // narrowed to the property that always mattered: the RECIPIENT comes from env and nowhere
    // else. Writing an alert row is not reading an address.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'services', 'operator-pager.ts'), 'utf8');
    expect(src).not.toMatch(/webhook_url|webhook_secret|repid_agents/);
    const tables = [...src.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m: string[]) => m[1]);
    expect([...new Set(tables)]).toEqual(['ops_alerts']);   // the ONLY table it may touch
    expect(src).toMatch(/process\.env\['TELEGRAM_OWNER_CHAT_ID'\]/);
  });
});

describe('it does not train you to ignore it', () => {
  it('dedupes an identical reason inside the cooldown', async () => {
    for (let i = 0; i < 5; i++) pageOperator('eas-anchor', 'attester key missing');
    await flush();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('distinct reasons page independently — one condition must not mask another', async () => {
    pageOperator('eas-anchor', 'attester key missing');
    pageOperator('proof-drain', 'canonical write rejected');
    await flush();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('the cooldown is long enough to matter on a 5-minute worker', () => {
    // A worker degrading every 5 min is 288 pages/day at zero cooldown. The window must be
    // comfortably longer than one cycle or the dedupe is decorative.
    expect(PAGE_COOLDOWN_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('it cannot break the thing it is watching', () => {
  it('returns synchronously and does not reject when Telegram throws', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network gone'); }) as never;
    expect(() => pageOperator('eas-anchor', 'boom')).not.toThrow();
    await flush();
    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ pushed: false, push_armed: true }) }),
    );
  });

  it('survives the audit sink itself failing', async () => {
    emitAuditEvent.mockRejectedValue(new Error('supabase down'));
    expect(() => pageOperator('hal', 'zero providers responded')).not.toThrow();
    await flush();
  });

  it('returns before the network call resolves — it never blocks a caller', () => {
    // FIRST DRAFT OF THIS TEST WAS WRONG and asserted nothing: it set a flag inside the Promise
    // executor, which runs SYNCHRONOUSLY at construction, so the flag was true no matter how the
    // code behaved. The property that actually matters is wall-clock: markDegraded is
    // synchronous and sits in the anchor loop, so a hung Telegram must not delay its return.
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as never; // never settles
    const t0 = Date.now();
    const returned = pageOperator('eas-anchor', 'telegram hung');
    const elapsed = Date.now() - t0;
    expect(returned).toBeUndefined();  // void, not a promise the caller could await by accident
    expect(elapsed).toBeLessThan(50);  // the 5s fetch timeout is never on the caller's clock
  });
});

/**
 * The three call sites, pinned. A pager wired to nothing is the failure it exists to prevent.
 */
describe('the seams are actually wired', () => {
  const read = (rel: string) =>
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', rel), 'utf8');

  it('markDegraded pages — one seam covering anchor, HAL, ZKP and x402', () => {
    // Wired HERE rather than at four call sites so a NEW degrade path pages for free instead of
    // being remembered. If this import goes, every subsystem silently stops paging at once.
    const src = read('src/lib/degraded.ts');
    expect(src).toContain("from '../services/operator-pager'");
    expect(src).toMatch(/pageOperator\(asPageSource\(tag\), reason\)/);
  });

  it("the tag map uses the tags callers ACTUALLY pass, not invented ones", () => {
    // The first draft guessed 'anchor'. The worker passes 'eas-anchor', so every anchor page
    // would have been mislabelled generic 'degraded' — the one subsystem this was built for.
    const src = read('src/lib/degraded.ts');
    for (const tag of ['eas-anchor', 'hal', 'zkp', 'x402']) expect(src).toContain(`'${tag}'`);
    // …and those are exactly the literals the call sites use.
    expect(read('src/workers/eas-anchor-worker.ts')).toContain("'eas-anchor'");
    expect(read('src/hal/service.ts')).toContain("'hal'");
    expect(read('src/zkp/plonky3-real.ts')).toContain("'zkp'");
    expect(read('src/services/x402-real-settler.ts')).toContain("'x402'");
  });

  it('the drain pages on a rejected canonical write — the 12-day failure', () => {
    const src = read('src/services/proof-drain-service.ts');
    expect(src).toMatch(/pageOperator\(\s*'proof-drain'/);
    // The dedupe key must NOT carry the agent or job id, or a systemic failure — which is what
    // this always is, firing on a type mismatch affecting every write — pages once per job.
    // (First draft sliced on exact whitespace and matched nothing, asserting emptiness happily.)
    const i = src.indexOf("'proof-drain'");
    const call = src.slice(i, i + 400);
    expect(call).toMatch(/agent_id: args\.agentId/);   // the ids live in the DETAIL payload
    const reason = call.slice(call.indexOf("'", call.indexOf('\n')), call.indexOf('{ pgcode'));
    expect(reason).not.toMatch(/\$\{/);                // …and never in the dedupe key
  });

  it('HAL pages on ITS OWN gate failing, not on a chosen provider count', () => {
    const src = read('src/hal/quorum-receipt-writer.ts');
    expect(src).toMatch(/if \(!quorumMet\)/);
    expect(src).toMatch(/pageOperator\(\s*'hal'/);
    // A literal floor above the measured normal range would page on healthy traffic.
    expect(src).not.toMatch(/providers_used\s*<\s*[3-9]/);
  });

  it('/health reports whether alerts are live', () => {
    expect(read('src/routes/health.ts')).toMatch(/operator_pager: pagerStatus\(\)/);
  });
});
