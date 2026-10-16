/**
 * A2A RepID — collusion and Sybil vs honest work. MEASURE-ONLY: no database, no network, no writes.
 *
 *   SIM_SEED=12345 npx ts-node scripts/repid-sim/a2a-ring-sim.ts   (30 days, 2 ring trades per pair per day)
 *
 * REAL: the touchpoint constants the live writers apply (SERVICE_FULFILLED_DELTAS,
 * SERVICE_SATISFIED_DELTA_BASE, SERVICE_DISPUTE_DELTAS), the [10, 10000] clamp, the tier bands, and
 * the DB's counterparty rule (count_unique_counterparties counts distinct buyer AGENTS).
 * MODELLED: demand, deliverable quality, dispute rates and the attacker's trade volume (stated below).
 * NOT MODELLED: T3 SERVICE_OUTCOME. It cannot be written today: 'SERVICE_OUTCOME' is not in the
 * repid_score_events event_type CHECK, so the "largest weight" touchpoint never lands.
 *
 * The question: does honest delivery out-earn a ring of same-operator agents trading with each
 * other, or a provider buying from its own sock puppets? And what would an owner-distinct
 * counterparty rule (same operator => no RepID) change? The rule is a SHADOW counterfactual here.
 */
import { SERVICE_FULFILLED_DELTAS, SERVICE_SATISFIED_DELTA_BASE, SERVICE_DISPUTE_DELTAS } from '../../src/services/validation-repid-delta';
import { REPID_MIN, REPID_MAX } from '../../src/scoring/repid-deltas';

export interface Agent { name: string; operator: string; repid: number; buyers: Set<string>; buyerOperators: Set<string> }
export interface SimOpts { seed: number; days: number; ownerDistinctRule: boolean; ringTradesPerPairPerDay: number }

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (x: number) => Math.max(REPID_MIN, Math.min(REPID_MAX, Math.round(x)));
const tierOf = (r: number) => (r >= 8000 ? 'VETERAN' : r >= 5000 ? 'AUTONOMOUS' : r >= 1000 ? 'ESTABLISHED' : r >= 500 ? 'EARNING' : 'PROBATIONARY');
/** compute_tier(int, uuid): AUTONOMOUS/VETERAN need >= 2 distinct counterparties (agents, not operators). */
const gatedTier = (a: Agent, byOperator = false) => {
  const cp = byOperator ? a.buyerOperators.size : a.buyers.size;
  let t = tierOf(a.repid);
  if (t === 'VETERAN' && cp < 2) t = 'AUTONOMOUS';
  if (t === 'AUTONOMOUS' && cp < 2) t = 'ESTABLISHED';
  return t;
};

/** One settled contract: fulfilled always; satisfied when the rating is > 0 (otherwise payment voids); dispute optional. */
function trade(provider: Agent, buyer: Agent, s: number, disputed: boolean, opts: SimOpts) {
  provider.buyers.add(buyer.name);
  provider.buyerOperators.add(buyer.operator);
  if (opts.ownerDistinctRule && provider.operator === buyer.operator) return; // shadow counterfactual
  provider.repid = clamp(provider.repid + SERVICE_FULFILLED_DELTAS.provider);
  buyer.repid = clamp(buyer.repid + SERVICE_FULFILLED_DELTAS.buyer);
  if (disputed) {
    provider.repid = clamp(provider.repid + SERVICE_DISPUTE_DELTAS.provider_at_fault.provider);
    buyer.repid = clamp(buyer.repid + SERVICE_DISPUTE_DELTAS.provider_at_fault.buyer);
    return;
  }
  if (s > 0) {
    provider.repid = clamp(provider.repid + Math.round(SERVICE_SATISFIED_DELTA_BASE.provider * s));
    buyer.repid = clamp(buyer.repid + Math.round(SERVICE_SATISFIED_DELTA_BASE.buyer * s));
  }
}

const poisson = (rnd: () => number, lambda: number) => { let k = 0, p = 1; const L = Math.exp(-lambda); do { k++; p *= rnd(); } while (p > L); return k - 1; };
const rating = (rnd: () => number, pMet: number) => ((rnd() < pMet ? 1 : 0) + (rnd() < pMet ? 1 : 0)) / 2;

export function runA2ARingSim(opts: SimOpts) {
  const rnd = prng(opts.seed);
  const START = 1000;
  const mk = (name: string, operator: string): Agent => ({ name, operator, repid: START, buyers: new Set(), buyerOperators: new Set() });
  const honest = mk('honest', 'op-honest');
  const fabricator = mk('fabricator', 'op-fab');
  const ring = [mk('ring-a', 'op-ring'), mk('ring-b', 'op-ring'), mk('ring-c', 'op-ring')];
  const sybil = mk('sybil', 'op-sybil');
  const puppets = [mk('puppet-1', 'op-sybil'), mk('puppet-2', 'op-sybil')];
  const market = Array.from({ length: 20 }, (_, i) => mk(`buyer-${i}`, `op-buyer-${i}`));

  for (let d = 0; d < opts.days; d++) {
    // Honest and fabricating providers: real, demand-limited buyers (Poisson 1.5/day each).
    for (let k = poisson(rnd, 1.5); k > 0; k--) trade(honest, market[Math.floor(rnd() * market.length)]!, rating(rnd, 0.85), rnd() < 0.03, opts);
    for (let k = poisson(rnd, 1.5); k > 0; k--) trade(fabricator, market[Math.floor(rnd() * market.length)]!, rating(rnd, 0.3), rnd() < 0.25, opts);
    // Ring: every member sells to every other member N times a day, rates it perfect, never disputes.
    for (const p of ring) for (const b of ring) if (p !== b) for (let n = 0; n < opts.ringTradesPerPairPerDay; n++) trade(p, b, 1, false, opts);
    // Sybil: two sock puppets buy from the provider N times a day each.
    for (const b of puppets) for (let n = 0; n < opts.ringTradesPerPairPerDay; n++) trade(sybil, b, 1, false, opts);
  }
  const row = (a: Agent) => ({ agent: a.name, net: a.repid - START, final: a.repid, tier: gatedTier(a), tier_if_counterparties_by_operator: gatedTier(a, true) });
  const ringAvg = Math.round(ring.reduce((s, a) => s + a.repid - START, 0) / ring.length);
  return {
    seed: opts.seed, days: opts.days, ownerDistinctRule: opts.ownerDistinctRule, ringTradesPerPairPerDay: opts.ringTradesPerPairPerDay,
    honest: row(honest), fabricator: row(fabricator), ring_member: { ...row(ring[0]!), net_avg: ringAvg }, sybil_provider: row(sybil),
    honest_beats: { fabrication: honest.repid > fabricator.repid, collusion: honest.repid - START > ringAvg, sybil: honest.repid > sybil.repid },
  };
}

if (require.main === module) {
  const seed = Number(process.env.SIM_SEED ?? 12345);
  const days = Number(process.env.SIM_DAYS ?? 30);
  const n = Number(process.env.SIM_RING_TRADES ?? 2);
  for (const ownerDistinctRule of [false, true]) {
    console.log(JSON.stringify(runA2ARingSim({ seed, days, ownerDistinctRule, ringTradesPerPairPerDay: n })));
  }
}
