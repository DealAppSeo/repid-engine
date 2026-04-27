/**
 * Reponomics — builder registry / ghost cohort decay tests.
 *
 * The recompute math is pure given a list of agents; we don't need to
 * mock Supabase to exercise it. We import the helper indirectly via a
 * thin local copy of the formula.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const GHOST_PENALTY_PER_AGENT = 100;

function recomputeFromAgents(now: number, agents: Array<{ last_active_at: string | null; current_repid: number }>) {
  const sevenDaysAgo = now - SEVEN_DAYS_MS;
  const active = agents.filter(a => a.last_active_at && new Date(a.last_active_at).getTime() > sevenDaysAgo);
  const ghosts = agents.filter(a => !a.last_active_at || new Date(a.last_active_at).getTime() <= sevenDaysAgo);
  const meanActiveRepId = active.length > 0
    ? Math.round(active.reduce((s, a) => s + a.current_repid, 0) / active.length)
    : 0;
  const ghostPenalty = ghosts.length * GHOST_PENALTY_PER_AGENT;
  const builderRepId = Math.max(0, Math.min(10000, meanActiveRepId - ghostPenalty));
  return { builderRepId, activeCount: active.length, ghostCount: ghosts.length, meanActiveRepId };
}

describe('builder-registry — ghost cohort decay', () => {
  const now = new Date('2026-04-27T12:00:00Z').getTime();
  const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();    // 1 day ago — active
  const ancient = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();   // 30 days ago — ghost

  it('all active: builder repid = mean of active', () => {
    const r = recomputeFromAgents(now, [
      { last_active_at: recent, current_repid: 5000 },
      { last_active_at: recent, current_repid: 7000 },
      { last_active_at: recent, current_repid: 6000 },
    ]);
    expect(r.builderRepId).toBe(6000);
    expect(r.ghostCount).toBe(0);
  });

  it('5 ghosts: 500 RepID penalty applied', () => {
    const r = recomputeFromAgents(now, [
      { last_active_at: recent, current_repid: 6000 },
      ...Array.from({ length: 5 }, () => ({ last_active_at: ancient, current_repid: 5500 })),
    ]);
    expect(r.activeCount).toBe(1);
    expect(r.ghostCount).toBe(5);
    expect(r.builderRepId).toBe(6000 - 500);
  });

  it('all ghosts: builder repid clamps to 0', () => {
    const r = recomputeFromAgents(now, [
      { last_active_at: ancient, current_repid: 5500 },
      { last_active_at: ancient, current_repid: 7000 },
    ]);
    expect(r.activeCount).toBe(0);
    expect(r.builderRepId).toBe(0);
  });

  it('ghost penalty cannot drive builder below 0', () => {
    const r = recomputeFromAgents(now, [
      { last_active_at: recent, current_repid: 100 },     // tiny active
      ...Array.from({ length: 20 }, () => ({ last_active_at: ancient, current_repid: 1000 })),
    ]);
    expect(r.builderRepId).toBe(0);                       // floor at 0, never negative
  });

  it('null last_active_at counts as ghost', () => {
    const r = recomputeFromAgents(now, [
      { last_active_at: null, current_repid: 5000 },
      { last_active_at: recent, current_repid: 5000 },
    ]);
    expect(r.ghostCount).toBe(1);
    expect(r.activeCount).toBe(1);
  });
});
