/**
 * GAP 1 end-to-end: the REAL HAL quorum (`factCheck`) joined to the kernel post-gate through
 * `makeKernelHalCheck`, driven all the way to a kernel verdict.
 *
 * This is the half the two existing suites could not cover. kernel.test.ts hand-writes a
 * `HalEvidence` and asserts the gate; resilience.test.ts drives `factCheck` and asserts its
 * `decision` — but NOTHING ran a real factCheck result through the adapter into `runUnderKernel`. A
 * wrong adapter would satisfy both and FAIL OPEN here. So this suite:
 *   - runs the real factCheck (global.fetch mocked, the same technique resilience.test.ts uses — no
 *     network, deterministic) through the real adapter and the real gate, for each mapping;
 *   - proves a provider family going down leaves the post NOT_CHECKED, never ALLOW;
 *   - NON-VACUITY: injects a deliberately-wrong adapter and shows the gate ALLOWs a flagged post
 *     (fail open), then shows the real adapter DENYs the identical post — the only difference being
 *     the mapping, which is exactly the thing under test.
 *
 * NO LIVE NETWORK. global.fetch is mocked per provider, so the "quorum" is deterministic. The leg
 * that is therefore NOT covered here is a real cross-provider call over the wire; that is a
 * production check, not a unit one, and is called out in the PR as NOT_CHECKED.
 */
import { factCheck, type FactCheckProviderCfg } from '../../hal/fact-check';
import { makeKernelHalCheck, halEvidenceFromFactCheck } from '../hal-adapter';
import { defaultDeps } from '../../routes/kernel';
import { runUnderKernel } from '../gate';
import type { HalCheck, HalEvidence } from '../types';
import { harness, iso, postRequest, signedPolicy } from './fixtures';

const DELIVERABLE = 'The chemical symbol for gold is Au.';
const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

const TWO: FactCheckProviderCfg[] = [
  { name: 'groq', endpoint: 'http://groq.test', apiKey: 'k', model: 'm', timeoutMs: 2000, family: 'groq' },
  { name: 'cerebras', endpoint: 'http://cerebras.test', apiKey: 'k', model: 'm', timeoutMs: 2000, family: 'cerebras' },
];
const THREE: FactCheckProviderCfg[] = [
  ...TWO,
  { name: 'fireworks', endpoint: 'http://fireworks.test', apiKey: 'k', model: 'm', timeoutMs: 2000, family: 'fireworks' },
];

type Outcome = { kind: 'ok'; verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN'; confidence?: number } | { kind: 'down' };

function mockFetch(map: Record<string, Outcome>): void {
  (global as any).fetch = jest.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    const o = key ? map[key]! : ({ kind: 'down' } as Outcome);
    if (o.kind === 'down') throw new Error('ECONNREFUSED simulated provider down');
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: o.verdict, confidence: o.confidence ?? 90 }) } }] }),
    } as any;
  });
}

/** A kernel HalCheck backed by the REAL factCheck + the REAL adapter. */
function realHalCheck(providers: FactCheckProviderCfg[]): HalCheck {
  return makeKernelHalCheck({ providers, resolveDeliverable: () => DELIVERABLE });
}

async function runPost(halCheck: HalCheck, tool = jest.fn(async () => 'posted')) {
  const h = harness({ halCheck });
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso); // owner resolved + policy VERIFIED → HAL is consulted
  const out = await runUnderKernel(postRequest(), tool, h.deps);
  return { out, tool };
}

beforeAll(() => { process.env['HAL_QUORUM_COST_ORDERED'] = 'false'; }); // attempt every configured provider
afterEach(() => { jest.restoreAllMocks(); (global as any).fetch = undefined; });

describe('GAP 1: the real HAL quorum, mapped through the adapter, into the kernel post-gate', () => {
  it('clean + disjoint-family quorum → ALLOW, the post runs once, and the verdict is PROVISIONAL (never band-restoring)', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: 'ok', verdict: 'TRUE' } });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    const v = out.final_receipt!.verification;
    expect(v.status).toBe('VERIFIED');
    expect(v.verdict_label).toBe('PROVISIONAL'); // a vote never settles
    expect(v.settled_by).toBeNull();
    expect(v.counts_toward_band_restore).toBe(false); // a fact-check PASS cannot restore a band
  });

  it('one provider family DOWN (only one family answers) → NOT_CHECKED, the post never runs', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: 'down' } });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).toBe('NOT_CHECKED'); // factCheck 'abstain' (low quorum) → adapter ABSTAIN
    expect(out.verdict).not.toBe('ALLOW');
    expect(codes(out)).toContain('hal_abstained');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('vetoed → DENY(hal_vetoed), the post never runs', async () => {
    // 2 of 3 families judge it FALSE → hal_score over the veto threshold, no TRUE plurality.
    mockFetch({
      groq: { kind: 'ok', verdict: 'FALSE', confidence: 95 },
      cerebras: { kind: 'ok', verdict: 'FALSE', confidence: 95 },
      fireworks: { kind: 'ok', verdict: 'TRUE', confidence: 90 },
    });
    const { out, tool } = await runPost(realHalCheck(THREE));
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('hal_vetoed');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('flagged → DENY(hal_flagged): a flagged post is not cleared, and never runs', async () => {
    // 1 TRUE + 1 FALSE at tuned confidences → hal_score in [flag, veto): 'flagged', quorum met.
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE', confidence: 100 }, cerebras: { kind: 'ok', verdict: 'FALSE', confidence: 80 } });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('hal_flagged');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('a lone surviving provider that says FALSE is held at flagged → DENY, never ALLOW', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'FALSE', confidence: 99 }, cerebras: { kind: 'down' } });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).not.toBe('ALLOW');
    expect(['DENY', 'NOT_CHECKED']).toContain(out.verdict);
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('total provider outage → NOT_CHECKED, the post never runs', async () => {
    mockFetch({ groq: { kind: 'down' }, cerebras: { kind: 'down' } });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(tool).toHaveBeenCalledTimes(0);
  });
});

// ── NON-VACUITY: the gate CAN allow a post, and only the adapter stands between flagged and ALLOW ─
describe('(non-vacuity) a wrong adapter fails the gate OPEN; the real adapter holds it closed', () => {
  /** The exact fail-open bug: pass `flagged` (and any `clean`) through as PASS. */
  function wrongHalCheck(providers: FactCheckProviderCfg[]): HalCheck {
    return async (): Promise<HalEvidence> => {
      const r = await factCheck(DELIVERABLE, providers, {});
      const verdict: HalEvidence['verdict'] = r.decision === 'vetoed' ? 'VETO' : r.decision === 'abstain' ? 'ABSTAIN' : 'PASS';
      return { verdict, method: 'WRONG-ADAPTER', votes: [], settled_by: null, grounded: false, same_domain: false };
    };
  }

  const flagged = { groq: { kind: 'ok', verdict: 'TRUE', confidence: 100 }, cerebras: { kind: 'ok', verdict: 'FALSE', confidence: 80 } } as const;

  it('the WRONG adapter makes the kernel ALLOW a flagged post (proof the gate is not rigged to always deny)', async () => {
    mockFetch({ ...flagged });
    const { out, tool } = await runPost(wrongHalCheck(TWO));
    expect(out.verdict).toBe('ALLOW'); // FAIL OPEN — this is the bug the real adapter must prevent
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('...and the REAL adapter DENYs that identical flagged post', async () => {
    mockFetch({ ...flagged });
    const { out, tool } = await runPost(realHalCheck(TWO));
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('hal_flagged');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it("a WRONG adapter clears a total-outage 'flagged' to ALLOW; the real adapter reads NOT_CHECKED", async () => {
    // Both providers down → factCheck returns the neutral `decision:'flagged'` (0 providers). A
    // wrong mapper that treats flagged as a pass ALLOWs a post HAL could not check at all.
    const outage = { groq: { kind: 'down' }, cerebras: { kind: 'down' } } as const;
    mockFetch({ ...outage });
    const wrong = await runPost(wrongHalCheck(TWO), jest.fn(async () => 'posted'));
    expect(wrong.out.verdict).toBe('ALLOW'); // fail open: an outage treated as a pass
    mockFetch({ ...outage });
    const real = await runPost(realHalCheck(TWO), jest.fn(async () => 'posted'));
    expect(real.out.verdict).toBe('NOT_CHECKED'); // fail closed — degraded flag is not a flag, and not a pass
    expect(real.tool).toHaveBeenCalledTimes(0);
  });
});

// ── the production wiring: KERNEL_HAL_ENABLED, default OFF, no behavior change when off ───────────
describe('routes/kernel defaultDeps() honours KERNEL_HAL_ENABLED (default OFF)', () => {
  const saved = process.env['KERNEL_HAL_ENABLED'];
  afterEach(() => { if (saved === undefined) delete process.env['KERNEL_HAL_ENABLED']; else process.env['KERNEL_HAL_ENABLED'] = saved; });

  it('flag UNSET → halCheck is not wired, and a post reads NOT_CHECKED(hal_not_checked) — today\'s behavior', async () => {
    delete process.env['KERNEL_HAL_ENABLED'];
    const deps = defaultDeps();
    expect(deps.halCheck).toBeUndefined();
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(postRequest(), tool, { ...h.deps, halCheck: deps.halCheck });
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('hal_not_checked');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it("flag set to 'true' → halCheck IS wired (a function)", () => {
    process.env['KERNEL_HAL_ENABLED'] = 'true';
    expect(typeof defaultDeps().halCheck).toBe('function');
  });

  it('flag set to anything but true (e.g. "1", "yes", "on", "false") → OFF, halCheck unset', () => {
    for (const v of ['1', 'yes', 'on', 'false', '']) {
      process.env['KERNEL_HAL_ENABLED'] = v;
      expect(defaultDeps().halCheck).toBeUndefined();
    }
  });

  it("the flag is case/space-insensitive about 'true' only (' TRUE ' enables)", () => {
    process.env['KERNEL_HAL_ENABLED'] = ' TRUE ';
    expect(typeof defaultDeps().halCheck).toBe('function');
  });

  it('the wired halCheck, given a kernel request (which carries no content), ABSTAINs — never a pass', async () => {
    // The HTTP kernel request has only args_hash; with no deliverable the adapter must not pass.
    const hc = makeKernelHalCheck();
    const ev = await hc({
      agent: { agent_id: 'a', agent_name: 'n' }, tool: { name: 'social.post', class: 'post' },
      origin: 'Cli', args_hash: '0x' + '0'.repeat(64), amount_raw: null, payee: null, asset: null, chain_id: null,
    });
    expect(ev.verdict).toBe('ABSTAIN');
    expect(halEvidenceFromFactCheck).toBeDefined();
  });
});
