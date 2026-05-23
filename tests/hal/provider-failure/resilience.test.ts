/**
 * HAL provider-failure resilience (CC1 2026-05-23).
 *
 * Verifies the minimum-quorum gate added to factCheck: a veto/flag requires
 * >= 2 successful providers; a single surviving provider defaults to 'clean'
 * (degraded) so a lone verdict cannot fire a false veto. hal_score/agreement
 * math is unchanged at quorum >= 2. fact-check.ts imports nothing heavy, so we
 * mock global.fetch directly (no db/config/env needed).
 */
import { factCheck, type FactCheckProviderCfg } from '../../../src/hal/fact-check';

const PROVIDERS: FactCheckProviderCfg[] = [
  { name: 'groq', endpoint: 'http://groq.test', apiKey: 'k', model: 'm', timeoutMs: 2000 },
  { name: 'cerebras', endpoint: 'http://cerebras.test', apiKey: 'k', model: 'm', timeoutMs: 2000 },
  { name: 'fireworks', endpoint: 'http://fireworks.test', apiKey: 'k', model: 'm', timeoutMs: 2000 },
];

type Outcome = { kind: 'ok'; verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN'; confidence?: number } | { kind: '429' } | { kind: 'throw' };

/** Install a fetch mock that maps each provider endpoint to an outcome. */
function mockFetch(map: Record<string, Outcome>) {
  (global as any).fetch = jest.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    const o = key ? map[key]! : ({ kind: 'throw' } as Outcome);
    if (o.kind === 'throw') throw new Error('ECONNREFUSED simulated network failure');
    if (o.kind === '429') return { ok: false, status: 429, text: async () => 'Too Many Requests', json: async () => ({}) } as any;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: o.verdict, confidence: o.confidence ?? 90 }) } }] }),
    } as any;
  });
}

afterEach(() => { jest.restoreAllMocks(); (global as any).fetch = undefined; });

describe('HAL provider-failure resilience — minimum quorum gate', () => {
  test('3/3 succeed (all TRUE): full quorum, clean, behavior unchanged', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: 'ok', verdict: 'TRUE' }, fireworks: { kind: 'ok', verdict: 'TRUE' } });
    const r = await factCheck('The chemical symbol for gold is Au.', PROVIDERS);
    expect(r.providers_used).toBe(3);
    expect(r.quorum).toBe('full');
    expect(r.degraded).toBe(false);
    expect(r.decision).toBe('clean');
    expect(r.quorum_note).toBeUndefined();
    expect(r.provider_health?.succeeded).toBe(3);
    expect(r.provider_health?.failed).toHaveLength(0);
  });

  test('2/3 succeed (cerebras 429), both TRUE: partial quorum, clean, agreement over the 2', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: '429' }, fireworks: { kind: 'ok', verdict: 'TRUE' } });
    const r = await factCheck('Water boils at 100 C at sea level.', PROVIDERS);
    expect(r.providers_used).toBe(2);
    expect(r.quorum).toBe('partial');
    expect(r.degraded).toBe(false);
    expect(r.decision).toBe('clean');
    expect(r.quorum_note).toBeUndefined(); // gate does NOT fire at quorum>=2
    expect(r.provider_health?.failed).toEqual([{ name: 'cerebras', error: expect.stringContaining('429') }]);
  });

  test('2/3 succeed, one TRUE one FALSE: quorum>=2 → real signal preserved (gate does not interfere)', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE', confidence: 90 }, cerebras: { kind: 'ok', verdict: 'FALSE', confidence: 95 }, fireworks: { kind: 'throw' } });
    const r = await factCheck('Disputed claim.', PROVIDERS);
    expect(r.providers_used).toBe(2);
    expect(r.quorum).toBe('partial');
    expect(r.agreement).toBeLessThan(1); // disagreement
    expect(r.quorum_note).toBeUndefined(); // gate untouched at quorum 2 — decision governed by score
  });

  test('1/3 surviving says FALSE: low quorum → GATE downgrades would-be veto to clean', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'FALSE', confidence: 95 }, cerebras: { kind: '429' }, fireworks: { kind: '429' } });
    const r = await factCheck('The chemical symbol for gold is Pb.', PROVIDERS);
    expect(r.providers_used).toBe(1);
    expect(r.quorum).toBe('low');
    expect(r.degraded).toBe(true);
    expect(r.decision).toBe('clean'); // lone FALSE cannot veto
    expect(r.hal_score).toBeGreaterThanOrEqual(0.9); // raw score preserved for observability
    expect(r.quorum_note).toContain('Low quorum');
    expect(r.provider_health?.succeeded).toBe(1);
    expect(r.provider_health?.failed).toHaveLength(2);
  });

  test('1/3 surviving says TRUE: low quorum, clean (naturally), degraded', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: 'throw' }, fireworks: { kind: '429' } });
    const r = await factCheck('The Earth orbits the Sun.', PROVIDERS);
    expect(r.providers_used).toBe(1);
    expect(r.quorum).toBe('low');
    expect(r.degraded).toBe(true);
    expect(r.decision).toBe('clean');
  });

  test('0/3 respond (total outage): outage quorum, default neutral/flagged, degraded, no provider count', async () => {
    mockFetch({ groq: { kind: '429' }, cerebras: { kind: '429' }, fireworks: { kind: 'throw' } });
    const r = await factCheck('Anything.', PROVIDERS);
    expect(r.providers_used).toBe(0);
    expect(r.quorum).toBe('outage');
    expect(r.degraded).toBe(true);
    expect(r.provider_health?.succeeded).toBe(0);
    expect(r.provider_health?.failed).toHaveLength(3);
    // (caller falls back to extractor when providers_used===0)
  });

  test('FALSE content with only 1 provider via network throws: default clean (acceptable false-negative tradeoff)', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'FALSE', confidence: 99 }, cerebras: { kind: 'throw' }, fireworks: { kind: 'throw' } });
    const r = await factCheck('A blatantly false statement.', PROVIDERS);
    expect(r.decision).toBe('clean'); // better false-clean (caught downstream) than false-veto when degraded
    expect(r.quorum).toBe('low');
    expect(r.provider_health?.failed.map((f) => f.name).sort()).toEqual(['cerebras', 'fireworks']);
  });

  test('provider_health metadata flows: mixed results', async () => {
    mockFetch({ groq: { kind: 'ok', verdict: 'TRUE' }, cerebras: { kind: 'ok', verdict: 'TRUE' }, fireworks: { kind: '429' } });
    const r = await factCheck('Mixed.', PROVIDERS);
    expect(r.provider_health).toBeDefined();
    expect(r.provider_health!.attempted).toBe(3);
    expect(r.provider_health!.succeeded).toBe(2);
    expect(r.provider_health!.failed).toHaveLength(1);
    expect(r.quorum).toBe('partial');
  });
});
