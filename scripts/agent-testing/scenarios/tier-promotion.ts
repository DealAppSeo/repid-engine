import { Scenario, ScenarioContext, computeTier } from '../framework';

/**
 * Scenario 4 — tier promotion invariant.
 * Reads an agent's RepID via the public GET /api/v1/repid/:id and asserts the
 * reported tier is consistent with current_repid per the canonical thresholds.
 * This is the read-only, side-effect-free core of "tier advances as RepID
 * accumulates": whatever the score, the tier the system reports must match
 * compute_tier(current_repid). A mismatch means the trg_sync_tier invariant is
 * broken. (Driving an actual promotion needs many scored events + premium-ish
 * orchestration; this verifies the invariant the promotion relies on.)
 */
export const tierPromotion: Scenario = {
  name: 'tier-promotion',
  description: 'Assert reported tier matches compute_tier(current_repid) — the promotion invariant.',
  async run(ctx: ScenarioContext) {
    const agentId = process.env.TEST_AGENT_ID;
    if (!agentId) return { pass: false, skip: true, reason: 'set TEST_AGENT_ID (repid_agents UUID) to run' };

    const res = await ctx.http.get(`/api/v1/repid/${agentId}`);
    if (!res.ok) {
      return { pass: false, reason: `GET /api/v1/repid/${agentId} returned ${res.status}`, details: { body: res.body, err: res.error } };
    }
    const b = res.body ?? {};
    const repid = Number(b.current_repid ?? b.repid ?? b?.data?.current_repid);
    const tier = String(b.tier ?? b?.data?.tier ?? '').toUpperCase();
    if (!Number.isFinite(repid) || !tier) {
      return { pass: false, reason: 'response missing current_repid / tier', details: { body: res.body } };
    }
    const expected = computeTier(repid);
    const ok = tier === expected;
    return {
      pass: ok,
      reason: ok ? `tier invariant holds (repid=${repid} → ${tier})` : `tier mismatch: repid=${repid} → expected ${expected}, got ${tier}`,
      details: { repid, tier, expected },
    };
  },
};
