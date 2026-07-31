#!/usr/bin/env node
/**
 * repid-asymmetry-sim.mjs — MIXED-PAIR test of asymmetric bound coupling.
 * Dependency-free, box-safe. Uses the SAME update math + defaults as
 * repid-bound-coupling-sim.mjs (kept in sync by hand — see the P block).
 *
 * QUESTION (Sean): does a GOOD OWNER lift a (bad) AGENT more than a GOOD AGENT lifts
 * a (bad) OWNER? i.e. is the accountability/lift asymmetric toward the principal?
 * Runs four fixed populations and measures lift + drag both directions.
 *
 * Every number below re-runs from THIS committed file. Command:
 *   node scripts/sim/repid-asymmetry-sim.mjs
 *   node scripts/sim/repid-asymmetry-sim.mjs --aua=0.03 --aau=0.01 --N=8000 --T=600
 */
function makeRng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const arg=Object.fromEntries(process.argv.slice(2).map(s=>{const[k,v]=s.replace(/^--/,'').split('=');return[k,v===undefined?true:v];}));
const num=(k,d)=>arg[k]!==undefined?+arg[k]:d;

const P={ N:num('N',8000), T:num('T',600), seed:num('seed',42), floor:100, cap:10000, start:1000,
  alpha_ua:num('aua',0.030), alpha_au:num('aau',0.010), couplePts:num('cp',180),
  kappa:num('kappa',0.9), mpow:num('mpow',1.4), lambda:num('lambda',0.75), d0:num('d0',0.020),
  workPts:num('work',55), decepCatch:num('catch',0.65), decepPenalty:num('pen',7), decepPayoff:num('payoff',0.6),
  leak:num('leak',0.0), noise:num('noise',0.15) };
const GOOD={q:0.90,o_true:0.90,o_claim:0.90,decep:0.00}; // altruist
const BAD ={q:0.65,o_true:0.10,o_claim:0.90,decep:0.45}; // deceiver
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const prosocial=(R,o)=>clamp((R-P.start)/P.start,-1,1)*o;

// run one fixed-strategy population (owner strat sO, agent strat sA); return mean final [Rh,Ra]
function run(sO,sA,seed){
  const rnd=makeRng(seed), N=P.N;
  const Rh=new Float64Array(N).fill(P.start), Ra=new Float64Array(N).fill(P.start);
  const oO=sO.o_true*(1-P.leak)+sO.o_claim*P.leak, oA=sA.o_true*(1-P.leak)+sA.o_claim*P.leak;
  const MO=1+P.kappa*Math.pow(oO,P.mpow), MA=1+P.kappa*Math.pow(oA,P.mpow);
  const dO=Math.max(0.002,P.d0*(1-P.lambda*oO)), dA=Math.max(0.002,P.d0*(1-P.lambda*oA));
  const work=(s,M)=>{let v=s.q+P.noise*(rnd()*2-1); if(rnd()<s.decep){v=rnd()<P.decepCatch?-P.decepPenalty:s.q+P.decepPayoff;} return v*P.workPts*M;};
  for(let t=0;t<P.T;t++) for(let i=0;i<N;i++){
    const proH=prosocial(Rh[i],oO), proA=prosocial(Ra[i],oA);
    const coupA=P.alpha_ua*proH*P.couplePts;   // owner -> agent (strong)
    const coupH=P.alpha_au*proA*P.couplePts;   // agent -> owner (weak)
    Rh[i]=clamp(Rh[i]+work(sO,MO)-dO*(Rh[i]-P.floor)+coupH,P.floor,P.cap);
    Ra[i]=clamp(Ra[i]+work(sA,MA)-dA*(Ra[i]-P.floor)+coupA,P.floor,P.cap);
  }
  let sh=0,sa=0; for(let i=0;i<N;i++){sh+=Rh[i];sa+=Ra[i];} return [sh/N,sa/N];
}
const seeds=[P.seed,P.seed+1,P.seed+2];
function avg(sO,sA){let h=0,a=0;for(const s of seeds){const[x,y]=run(sO,sA,s);h+=x/seeds.length;a+=y/seeds.length;}return{h,a};}

const GG=avg(GOOD,GOOD), GB=avg(GOOD,BAD), BG=avg(BAD,GOOD), BB=avg(BAD,BAD);
const liftToAgent = GB.a - BB.a;   // good owner lifts a BAD agent (vs bad owner)
const liftToOwner = BG.h - BB.h;   // good agent lifts a BAD owner (vs bad agent)
const dragOnAgent = GG.a - BG.a;   // BAD owner drags a good agent (vs good owner)
const dragOnOwner = GG.h - GB.h;   // BAD agent drags a good owner (vs good agent)

const f=x=>x.toFixed(0).padStart(6);
console.log(`\n=== BOUND-RepID asymmetry (mixed pairs)  N=${P.N} T=${P.T} seeds=${seeds.length}  aua=${P.alpha_ua} aau=${P.alpha_au} ===`);
console.log(`  scenario                 owner   agent`);
console.log(`  good-owner / good-agent ${f(GG.h)} ${f(GG.a)}`);
console.log(`  good-owner /  BAD-agent ${f(GB.h)} ${f(GB.a)}`);
console.log(`   BAD-owner / good-agent ${f(BG.h)} ${f(BG.a)}`);
console.log(`   BAD-owner /  BAD-agent ${f(BB.h)} ${f(BB.a)}`);
console.log(`\n  LIFT  a good OWNER -> its (bad) agent : +${liftToAgent.toFixed(0)}`);
console.log(`  LIFT  a good AGENT -> its (bad) owner : +${liftToOwner.toFixed(0)}`);
console.log(`  -> owner lifts agent MORE than agent lifts owner: ${liftToAgent>liftToOwner?'YES ✅':'NO ❌'} (ratio ${(liftToAgent/Math.max(1,liftToOwner)).toFixed(2)}x)`);
console.log(`\n  DRAG  a BAD OWNER -> its (good) agent : -${dragOnAgent.toFixed(0)}`);
console.log(`  DRAG  a BAD AGENT -> its (good) owner : -${dragOnOwner.toFixed(0)}`);
console.log(`  -> bad owner drags good agent MORE (accountability to principal): ${dragOnAgent>dragOnOwner?'YES ✅':'NO ❌'} (ratio ${(dragOnAgent/Math.max(1,dragOnOwner)).toFixed(2)}x)`);
console.log(`\nSWEEP-ASYM aua=${P.alpha_ua} aau=${P.alpha_au} liftAgent=${liftToAgent.toFixed(0)} liftOwner=${liftToOwner.toFixed(0)} dragAgent=${dragOnAgent.toFixed(0)} dragOwner=${dragOnOwner.toFixed(0)}\n`);
process.exit((liftToAgent>liftToOwner && dragOnAgent>dragOnOwner)?0:1);
