#!/usr/bin/env node
/**
 * repid-bound-coupling-sim.mjs — dependency-free Monte Carlo for the BOUND-RepID model.
 * Pure arithmetic (no npm / no deps) → box-safe + high-volume (10M+ updates in ~1s).
 *
 * THESIS UNDER TEST (Sean 2026-07-28): make the reputation-maximizing strategy the
 * PROSOCIAL one, and gaming/deception unprofitable — via:
 *   1. ASYMMETRIC human<->agent coupling: a good OWNER lifts their AGENT more than a good
 *      agent lifts the owner (alpha_ua > alpha_au). Accountability flows to the principal;
 *      an agent can't be a pure rep-farm for its owner.
 *   2. OTHER-ORIENTATION (O): measured from THIRD-PARTY verified benefit, NOT self-report.
 *      Higher O simultaneously RAISES the reward multiplier and LOWERS decay
 *      (altruists' reputation is stickier and compounds).
 *   3. ASYMMETRIC deception penalty: a caught lie costs many honest rounds.
 *
 * PASS = across seeds, mean final RepID orders altruist > honest-selfish > gamer > deceiver
 *        > free-rider, AND no gaming/deceptive strategy beats an honest one (gaming unprofitable).
 *
 * Run:  node scripts/sim/repid-bound-coupling-sim.mjs
 *       node scripts/sim/repid-bound-coupling-sim.mjs --N=20000 --T=800 --seed=7 --leak=0.3
 */

// deterministic RNG (mulberry32) — reproducible per seed
function makeRng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

const arg = Object.fromEntries(process.argv.slice(2).map(s=>{const[k,v]=s.replace(/^--/,'').split('=');return[k,v===undefined?true:v];}));
const num=(k,d)=>arg[k]!==undefined?+arg[k]:d;

const P = {
  N: num('N',10000), T: num('T',600), seed: num('seed',42),
  floor:100, cap:10000, start:1000,
  // ---- the tunable incentive knobs ----
  alpha_ua: num('aua',0.030),   // owner prosocial -> agent   (MUST be > alpha_au)
  alpha_au: num('aau',0.010),   // agent prosocial -> owner
  couplePts: num('cp',180),     // coupling points scale
  kappa: num('kappa',0.9),      // reward-multiplier gain from O
  mpow: num('mpow',1.4),        // multiplier exponent (convex → rewards HIGH O)
  lambda: num('lambda',0.75),   // decay reduction from O
  d0: num('d0',0.020),          // base decay rate
  workPts: num('work',55),      // base points for verified good work
  decepCatch: num('catch',0.65),// P(deception caught)
  decepPenalty: num('pen',7),   // caught lie costs pen× a good round (asymmetry)
  decepPayoff: num('payoff',0.6),// uncaught lie's short-term work boost (the temptation)
  leak: num('leak',0.0),        // 0 = O fully ground-truthed; >0 = self-claim leaks in (gaming surface)
  noise: num('noise',0.15),
};

// behavioral strategies. o_true = real other-orientation; o_claim = what they'd self-report.
const STRAT = {
  altruist:       {q:0.90, o_true:0.90, o_claim:0.90, decep:0.00},
  honest_selfish: {q:0.90, o_true:0.20, o_claim:0.25, decep:0.00},
  gamer:          {q:0.55, o_true:0.15, o_claim:0.95, decep:0.10}, // mediocre work + fakes high O
  soph_gamer:     {q:0.90, o_true:0.15, o_claim:0.95, decep:0.05}, // COMPETENT work + fakes high O — the real threat
  deceiver:       {q:0.65, o_true:0.10, o_claim:0.90, decep:0.45},
  free_rider:     {q:0.10, o_true:0.30, o_claim:0.40, decep:0.00},
};
const NAMES = Object.keys(STRAT);
const EXPECTED = ['altruist','honest_selfish','soph_gamer','gamer','free_rider','deceiver']; // desired order at LOW leak

function run(seed){
  const rnd = makeRng(seed);
  // each i is a HUMAN with one bound AGENT. Arrays: Rh/Ra = RepID; strat index per pair.
  const N=P.N;
  const Rh=new Float64Array(N).fill(P.start), Ra=new Float64Array(N).fill(P.start);
  const si=new Int8Array(N);              // strategy index of the pair (owner & agent share it)
  for(let i=0;i<N;i++) si[i]=Math.floor(rnd()*NAMES.length);

  const oMeasFor=(s)=> s.o_true*(1-P.leak) + s.o_claim*P.leak;   // ground-truth vs leaked self-claim
  const clamp=(x,a,b)=> x<a?a : x>b?b : x;
  const prosocial=(R,oMeas)=> clamp((R-P.start)/P.start,-1,1) * oMeas; // bad standing DRAGS (can be negative)

  for(let t=0;t<P.T;t++){
    for(let i=0;i<N;i++){
      const s=STRAT[NAMES[si[i]]];
      const oMeas=oMeasFor(s);
      const M=1+P.kappa*Math.pow(oMeas,P.mpow);
      const decay=Math.max(0.002, P.d0*(1-P.lambda*oMeas));
      // --- verified work outcome (shared shape for owner & agent, independent draws) ---
      const workOutcome=()=>{
        let v = s.q + P.noise*(rnd()*2-1);
        if(rnd()<s.decep){                       // attempted a lie this round
          if(rnd()<P.decepCatch) v = -P.decepPenalty; // caught → heavy asymmetric penalty
          else v = s.q + P.decepPayoff;               // uncaught → small illicit boost (the temptation)
        }
        return v;
      };
      const baseH=workOutcome()*P.workPts*M;
      const baseA=workOutcome()*P.workPts*M;
      // --- ASYMMETRIC bound coupling (computed on pre-update standings) ---
      const proH=prosocial(Rh[i],oMeas), proA=prosocial(Ra[i],oMeas);
      const coupA=P.alpha_ua*proH*P.couplePts;  // owner lifts agent (strong)
      const coupH=P.alpha_au*proA*P.couplePts;  // agent lifts owner (weak)
      // --- update ---
      Rh[i]=clamp(Rh[i]+baseH - decay*(Rh[i]-P.floor) + coupH, P.floor,P.cap);
      Ra[i]=clamp(Ra[i]+baseA - decay*(Ra[i]-P.floor) + coupA, P.floor,P.cap);
    }
  }
  // aggregate final RepID by strategy (agents & humans)
  const agg={}; for(const n of NAMES) agg[n]={h:0,a:0,c:0};
  for(let i=0;i<N;i++){const n=NAMES[si[i]];agg[n].h+=Rh[i];agg[n].a+=Ra[i];agg[n].c++;}
  const out={}; for(const n of NAMES) out[n]={human:agg[n].h/agg[n].c, agent:agg[n].a/agg[n].c, combined:(agg[n].h+agg[n].a)/(2*agg[n].c)};
  return out;
}

// ---- run across seeds, average, judge ----
const SEEDS=[P.seed,P.seed+1,P.seed+2,P.seed+3,P.seed+4];
const acc={}; for(const n of NAMES) acc[n]={human:0,agent:0,combined:0};
for(const sd of SEEDS){const r=run(sd);for(const n of NAMES){acc[n].human+=r[n].human/SEEDS.length;acc[n].agent+=r[n].agent/SEEDS.length;acc[n].combined+=r[n].combined/SEEDS.length;}}

const ranked=[...NAMES].sort((a,b)=>acc[b].combined-acc[a].combined);
const orderOK=JSON.stringify(ranked)===JSON.stringify(EXPECTED);
// gaming-unprofitable check: no gaming/deceptive strategy beats the WORST honest one
const honest=['altruist','honest_selfish'], gaming=['gamer','deceiver','soph_gamer'];
const worstHonest=Math.min(...honest.map(n=>acc[n].combined));
const bestGaming=Math.max(...gaming.map(n=>acc[n].combined));
const gamingUnprofitable=bestGaming<worstHonest;
// the KEY anti-gaming metric: does a COMPETENT gamer out-earn the honest_selfish agent?
const sg=acc['soph_gamer'].combined, hs=acc['honest_selfish'].combined;
const sophWins=sg>hs; // if YES, ground-truthing has failed at this leak

console.log(`\n=== BOUND-RepID coupling sim  (N=${P.N} pairs, T=${P.T} rounds, ${SEEDS.length} seeds) ===`);
console.log(`knobs: alpha_ua=${P.alpha_ua} alpha_au=${P.alpha_au} kappa=${P.kappa} lambda=${P.lambda} d0=${P.d0} pen=${P.decepPenalty} leak=${P.leak}`);
console.log(`\n  strategy        human    agent   combined`);
for(const n of ranked) console.log(`  ${n.padEnd(14)} ${acc[n].human.toFixed(0).padStart(6)} ${acc[n].agent.toFixed(0).padStart(8)} ${acc[n].combined.toFixed(0).padStart(9)}`);
console.log(`\n  ranking (best→worst): ${ranked.join(' > ')}`);
console.log(`  expected:             ${EXPECTED.join(' > ')}`);
console.log(`  ORDER MATCHES EXPECTED:      ${orderOK?'YES ✅':'NO ❌'}`);
console.log(`  GAMING UNPROFITABLE (best gaming ${bestGaming.toFixed(0)} < worst honest ${worstHonest.toFixed(0)}): ${gamingUnprofitable?'YES ✅':'NO ❌'}`);
console.log(`  COMPETENT-GAMER beats honest? (soph ${sg.toFixed(0)} vs honest_selfish ${hs.toFixed(0)}): ${sophWins?'YES ❌ ground-truthing FAILED':'NO ✅ ground-truthing HOLDS'}`);
console.log(`  asymmetry (owner->agent > agent->owner): ${P.alpha_ua>P.alpha_au?'YES ✅':'NO ❌'}`);
// machine-parseable one-liner for sweeps:
console.log(`SWEEP leak=${P.leak} order=${orderOK?1:0} sophWins=${sophWins?1:0} soph=${sg.toFixed(0)} honest=${hs.toFixed(0)}`);
process.exit(orderOK&&gamingUnprofitable&&!sophWins?0:1);
