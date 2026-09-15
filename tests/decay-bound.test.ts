/**
 * LOOP C9 — L5 bound entities do not silently rot. SYNTHETIC.
 * Env is set before require() because layers/decay imports db at load.
 */
describe('C9 bound-aware decay', () => {
  const NOW = new Date('2026-09-15T00:00:00.000Z');
  const AGO_180 = new Date(NOW.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();

  let applyBoundAwareDecay: typeof import('../src/identity/decay-bound').applyBoundAwareDecay;
  let idleDaysSince: typeof import('../src/identity/decay-bound').idleDaysSince;
  let whoWouldStopDecaying: typeof import('../src/identity/decay-bound').whoWouldStopDecaying;

  beforeAll(() => {
    process.env.LOCAL_MODE = 'true';
    process.env.LOCAL_STORE_PATH = ':memory:';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    jest.resetModules();
    ({ applyBoundAwareDecay, idleDaysSince, whoWouldStopDecaying } = require('../src/identity/decay-bound'));
  });

  it('bound agent, 180 days idle -> score unchanged, last_verified_action reflects the gap', () => {
    const r = applyBoundAwareDecay({
      agentId: '00000000-0000-4000-8000-0000000000d1',
      kind: 'ABT',
      currentRepid: 4000,
      activity30d: 0,
      lastVerifiedAction: AGO_180,
      now: NOW,
      mode: 'enforce',
    });
    expect(r.bound).toBe(true);
    expect(r.score_after).toBe(4000);
    expect(r.last_verified_action).toBe(AGO_180);
    expect(r.idle_days).toBe(180);
    expect(r.event?.type).toBe('DECAY_HELD_BOUND');
    expect(idleDaysSince(AGO_180, NOW)).toBe(180);
  });

  it('unclaimed DBT, 180 days idle -> score decayed, typed event written', () => {
    const r = applyBoundAwareDecay({
      agentId: '00000000-0000-4000-8000-0000000000d2',
      kind: 'DBT',
      currentRepid: 4000,
      activity30d: 0,
      lastVerifiedAction: AGO_180,
      now: NOW,
      mode: 'enforce',
    });
    expect(r.bound).toBe(false);
    expect(r.score_after).toBeLessThan(4000);
    expect(r.event?.type).toBe('DECAY_APPLIED');
    expect(r.event?.delta).toBeLessThan(0);
  });

  it('diff lists every currently-decaying agent who would stop under the new rule', () => {
    const roster = [
      { id: '00000000-0000-4000-8000-0000000000d3', kind: 'ABT' as const, would_remove: 40 },
      { id: '00000000-0000-4000-8000-0000000000d4', kind: 'DBT' as const, would_remove: 40 },
      { id: '00000000-0000-4000-8000-0000000000d5', kind: 'SBT' as const, would_remove: 0 },
    ];
    const stop = whoWouldStopDecaying(roster);
    expect(stop.map((s) => s.id)).toEqual(['00000000-0000-4000-8000-0000000000d3']);
  });
});
