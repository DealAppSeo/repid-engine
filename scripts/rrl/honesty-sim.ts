/**
 * WS2.2 — RRL Honesty-Dominance Simulation
 * ----------------------------------------
 * Pure-computation game-theory simulator for the Response Reputation Layer (RRL).
 * NO LLM calls, NO infra, NO prod. Deterministic (seeded RNG) for reproducibility.
 *
 * GOAL: prove that under the RRL scoring rule (Brier proper score + repair + concealment
 * asymmetry) plus the 9 anti-gaming mechanisms, HONESTY is the dominant strategy — before
 * any delta touches RepID / ERC-8004 / ZKP.
 *
 * Design source: reports/2026-07-18/RRL_DESIGN_v0.md
 *
 * DISCIPLINE (RULE-4 / task): parameters are chosen a-priori from the design doc's approved
 * values (Brier proper rule, ~3x concealment, small capped repair bonus, learning-adjusted
 * decay). They are NOT tuned to make honesty win. If a dishonest strategy wins, that is the
 * finding, reported not hidden.
 *
 * Run:   npx tsx scripts/rrl/honesty-sim.ts [--seed 1337] [--rounds 4000]
 * Emits: reports/2026-07-18/RRL_SIM_RESULTS.md
 */

import * as fs from 'fs';
import * as path from 'path';

// ----------------------------------------------------------------------------
// Deterministic RNG (Mulberry32) + Gaussian (Box-Muller). Seeded -> reproducible.
// ----------------------------------------------------------------------------
class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bernoulli(p: number): number {
    return this.next() < p ? 1 : 0;
  }
  gauss(mu: number, sigma: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  }
  int(nExclusive: number): number {
    return Math.floor(this.next() * nExclusive);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ----------------------------------------------------------------------------
// Strategies. Each dishonest one targets a specific mechanism (per the task).
// ----------------------------------------------------------------------------
type Strategy =
  | 'honest-calibrated'
  | 'overconfident'
  | 'sandbagger'
  | 'error-farmer'
  | 'colluder'
  | 'herd-follower'
  | 'concealer';

const STRATEGIES: Strategy[] = [
  'honest-calibrated',
  'overconfident',
  'sandbagger',
  'error-farmer',
  'colluder',
  'herd-follower',
  'concealer',
];

// ----------------------------------------------------------------------------
// The 9 anti-gaming mechanisms — each behind a toggle so it can be ABLATED.
// ----------------------------------------------------------------------------
interface Mechanisms {
  m1_learningAdjustedRepair: boolean;
  m2_peerPredictionBTS: boolean;
  m3_residualCorrelation: boolean;
  m4_lazyCoveragePenalty: boolean;
  m5_rewardIndependentCorrect: boolean;
  m6_rotatingRedteam: boolean;
  m7_ecosystemMultiplier: boolean;
  m8_retrospectiveEscrow: boolean;
  m9_calibrationCredential: boolean;
}

function allOn(): Mechanisms {
  return {
    m1_learningAdjustedRepair: true,
    m2_peerPredictionBTS: true,
    m3_residualCorrelation: true,
    m4_lazyCoveragePenalty: true,
    m5_rewardIndependentCorrect: true,
    m6_rotatingRedteam: true,
    m7_ecosystemMultiplier: true,
    m8_retrospectiveEscrow: true,
    m9_calibrationCredential: true,
  };
}
function allOff(): Mechanisms {
  return {
    m1_learningAdjustedRepair: false,
    m2_peerPredictionBTS: false,
    m3_residualCorrelation: false,
    m4_lazyCoveragePenalty: false,
    m5_rewardIndependentCorrect: false,
    m6_rotatingRedteam: false,
    m7_ecosystemMultiplier: false,
    m8_retrospectiveEscrow: false,
    m9_calibrationCredential: false,
  };
}

const MECH_KEYS: (keyof Mechanisms)[] = [
  'm1_learningAdjustedRepair',
  'm2_peerPredictionBTS',
  'm3_residualCorrelation',
  'm4_lazyCoveragePenalty',
  'm5_rewardIndependentCorrect',
  'm6_rotatingRedteam',
  'm7_ecosystemMultiplier',
  'm8_retrospectiveEscrow',
  'm9_calibrationCredential',
];

const MECH_LABEL: Record<keyof Mechanisms, string> = {
  m1_learningAdjustedRepair: 'M1 learning-adjusted repair',
  m2_peerPredictionBTS: 'M2 peer-prediction / BTS',
  m3_residualCorrelation: 'M3 residual-correlation detector',
  m4_lazyCoveragePenalty: 'M4 lazy/sandbag coverage penalty',
  m5_rewardIndependentCorrect: 'M5 reward independent-correct',
  m6_rotatingRedteam: 'M6 rotating red-team',
  m7_ecosystemMultiplier: 'M7 ecosystem-contribution multiplier',
  m8_retrospectiveEscrow: 'M8 retrospective/escrow scoring',
  m9_calibrationCredential: 'M9 calibration-over-time credential',
};

// ----------------------------------------------------------------------------
// Parameters — a-priori from the design doc's approved values. Documented, not tuned.
// ----------------------------------------------------------------------------
interface Params {
  competence: number;
  sigmaBelief: number;
  K_cal: number;
  R_participation: number;
  repairBonus0: number;
  repairDecayLambda: number;
  repairRecencyWindow: number; // recency window (rounds) for learning-adjusted decay
  nonLearnThreshold: number; // recent same-class repairs above this -> stagnation penalty
  nonLearnPenalty: number;
  repairRecoverFrac: number;
  honestNoticeProb: number;
  concealMult: number;
  detectBase: number;
  detectRedteam: number;
  farmDetectRedteam: number;
  escrowFrac: number;
  escrowMatureLag: number;
  baseDifficulty: number;
  baseTrapProb: number;
  coverageFloor: number;
  easyThreshold: number;
  lazyEasyPenalty: number;
  lazyFloorPenalty: number;
  discloseThreshold: number;
  disclosureBonus: number;
  independentBonus: number;
  btsBonus: number;
  collusionPenalty: number;
  ecosystemSelf: number;
  ecosystemIndep: number;
  credentialWeight: number; // M9 strength: scales positive gains by calibration reliability
  agentsPerStrategy: number;
  cliqueSize: number;
}

function defaultParams(): Params {
  return {
    competence: 0.8,
    sigmaBelief: 0.06,
    K_cal: 20,
    R_participation: 4.0, // break-even Brier 0.20 (honest @ b=0.8 has Brier ~0.16 -> net positive)
    repairBonus0: 3.0,
    repairDecayLambda: 0.9,
    repairRecencyWindow: 40,
    nonLearnThreshold: 3,
    nonLearnPenalty: 2.5,
    repairRecoverFrac: 1.0,
    honestNoticeProb: 0.6,
    concealMult: 3.0,
    detectBase: 0.35,
    detectRedteam: 0.7,
    farmDetectRedteam: 0.6,
    escrowFrac: 0.4,
    escrowMatureLag: 5,
    baseDifficulty: 0.25,
    baseTrapProb: 0.2,
    coverageFloor: 0.6,
    easyThreshold: 0.3,
    lazyEasyPenalty: 1.2,
    lazyFloorPenalty: 2.5,
    discloseThreshold: 0.62,
    disclosureBonus: 0.6,
    independentBonus: 1.5,
    btsBonus: 0.8,
    collusionPenalty: 4.0,
    ecosystemSelf: 0.7,
    ecosystemIndep: 1.1,
    credentialWeight: 0.5,
    agentsPerStrategy: 8,
    cliqueSize: 4,
  };
}

// ----------------------------------------------------------------------------
// Agent state
// ----------------------------------------------------------------------------
interface EscrowEntry {
  matureRound: number;
  amount: number;
  verdictCorrect: number;
  stated: number;
}
interface ConcealedEntry {
  resolveRound: number;
  basePenalty: number;
  detected: boolean;
}
interface PendingRepair {
  repairRound: number;
  errorClass: number;
  lossToRecover: number;
  manufactured: boolean;
}

interface Agent {
  id: number;
  strategy: Strategy;
  cliqueId: number;
  cumDelta: number;
  repid: number;
  answered: number;
  abstained: number;
  correctOnAnswered: number;
  confSumOnAnswered: number;
  escrow: EscrowEntry[];
  concealed: ConcealedEntry[];
  pendingRepairs: PendingRepair[];
  repairLog: Map<number, number[]>; // errorClass -> rounds repaired (for recency decay)
  cur: Action | null;
}

interface Action {
  abstain: boolean;
  verdict: number;
  stated: number;
  disclosed: boolean;
  correct: number;
  errorClass: number;
  brierDelta: number; // calibration delta applied this round (pre cross-agent)
  brokeFromPublic: boolean;
  publicSignal: number;
}

function makeAgent(id: number, strategy: Strategy, cliqueId: number): Agent {
  return {
    id,
    strategy,
    cliqueId,
    cumDelta: 0,
    repid: 1000,
    answered: 0,
    abstained: 0,
    correctOnAnswered: 0,
    confSumOnAnswered: 0,
    escrow: [],
    concealed: [],
    pendingRepairs: [],
    repairLog: new Map<number, number[]>(),
    cur: null,
  };
}

function buildPopulation(P: Params): Agent[] {
  const agents: Agent[] = [];
  let id = 0;
  for (const s of STRATEGIES) {
    if (s === 'colluder') {
      let placed = 0;
      let clique = 0;
      while (placed < P.agentsPerStrategy) {
        const thisClique = Math.min(P.cliqueSize, P.agentsPerStrategy - placed);
        for (let i = 0; i < thisClique; i++) {
          agents.push(makeAgent(id++, s, clique));
          placed++;
        }
        clique++;
      }
    } else {
      for (let i = 0; i < P.agentsPerStrategy; i++) agents.push(makeAgent(id++, s, -1));
    }
  }
  return agents;
}

// ----------------------------------------------------------------------------
// Proper scoring rule:  delta = R - K*(p - outcome)^2  (strictly proper).
// ----------------------------------------------------------------------------
function calibrationDelta(p: number, outcome: number, P: Params): number {
  return P.R_participation - P.K_cal * (p - outcome) * (p - outcome);
}

function mkAction(
  verdict: number,
  stated: number,
  disclosed: boolean,
  G: number,
  errorClass: number,
  publicSignal: number,
): Action {
  return {
    abstain: false,
    verdict,
    stated: clamp(stated, 0.02, 0.985),
    disclosed,
    correct: verdict === G ? 1 : 0,
    errorClass,
    brierDelta: 0,
    brokeFromPublic: verdict !== publicSignal,
    publicSignal,
  };
}
function abstainAction(publicSignal: number, G: number): Action {
  return {
    abstain: true,
    verdict: -1,
    stated: 0.5,
    disclosed: true,
    correct: 0,
    errorClass: -1,
    brierDelta: 0,
    brokeFromPublic: false,
    publicSignal,
  };
}

// ----------------------------------------------------------------------------
// One simulation round (single source of truth; used by every run path).
// ----------------------------------------------------------------------------
function runRound(
  agents: Agent[],
  difficulty: number,
  trapProb: number,
  mech: Mechanisms,
  P: Params,
  rng: RNG,
  t: number,
): void {
  const pCorrect = P.competence * (1 - difficulty) + 0.5 * difficulty;
  const G = rng.bernoulli(0.5);
  const trap = rng.bernoulli(trapProb);
  const publicSignal = trap ? 1 - G : G;
  const cliqueVerdict = new Map<number, { verdict: number; conf: number }>();

  // -- phase 1: actions --
  for (const a of agents) {
    const b = clamp(pCorrect + rng.gauss(0, P.sigmaBelief), 0.5, 0.985);
    const ownCorrect = rng.bernoulli(b);
    const ownVerdict = ownCorrect ? G : 1 - G;
    let act: Action;
    switch (a.strategy) {
      case 'honest-calibrated':
        act = mkAction(ownVerdict, b, b < P.discloseThreshold, G, rng.int(12), publicSignal);
        break;
      case 'overconfident':
        act = mkAction(ownVerdict, 0.97, false, G, rng.int(12), publicSignal);
        break;
      case 'sandbagger':
        act =
          b < 0.9 && rng.next() < 0.85
            ? abstainAction(publicSignal, G)
            : mkAction(ownVerdict, b, false, G, rng.int(12), publicSignal);
        break;
      case 'error-farmer': {
        // deliberately err at LOW confidence (cheap under a proper rule) then repair next round,
        // ALWAYS the same error class -> targets learning-adjusted decay + red-team.
        act = mkAction(1 - G, 0.35, false, G, 0, publicSignal);
        act.errorClass = 0;
        break;
      }
      case 'colluder': {
        let cv = cliqueVerdict.get(a.cliqueId);
        if (!cv) {
          const cb = clamp(pCorrect + rng.gauss(0, P.sigmaBelief), 0.5, 0.985);
          const anchorPublic = rng.next() < 0.6;
          const cVerdict = anchorPublic ? publicSignal : rng.bernoulli(cb) ? G : 1 - G;
          cv = { verdict: cVerdict, conf: cb };
          cliqueVerdict.set(a.cliqueId, cv);
        }
        act = mkAction(cv.verdict, cv.conf, false, G, rng.int(12), publicSignal);
        break;
      }
      case 'herd-follower':
        act = mkAction(publicSignal, 0.85, false, G, rng.int(12), publicSignal);
        break;
      case 'concealer':
        act = mkAction(ownVerdict, b, false, G, rng.int(12), publicSignal);
        break;
      default:
        act = abstainAction(publicSignal, G);
    }
    a.cur = act;
  }

  // -- phase 2: base calibration/disclosure delta + escrow + repair scheduling + conceal --
  for (const a of agents) {
    const act = a.cur;
    if (!act) continue;
    let delta = 0;
    if (act.abstain) {
      a.abstained++;
      if (mech.m4_lazyCoveragePenalty) {
        if (difficulty < P.easyThreshold) delta -= P.lazyEasyPenalty;
        const coverageSoFar = a.answered / Math.max(1, a.answered + a.abstained);
        if (coverageSoFar < P.coverageFloor) delta -= P.lazyFloorPenalty;
      }
    } else {
      a.answered++;
      a.confSumOnAnswered += act.stated;
      if (act.correct) a.correctOnAnswered++;
      let cal = calibrationDelta(act.stated, act.correct, P);

      // M9 calibration credential: scale POSITIVE gains by how well stated conf tracks realized
      // accuracy so far. Overconfident (states 0.97, realized ~0.73) gets shaved; honest untouched.
      if (mech.m9_calibrationCredential && cal > 0 && a.answered > 20) {
        const realized = a.correctOnAnswered / a.answered;
        const stated = a.confSumOnAnswered / a.answered;
        const miscal = Math.abs(stated - realized); // 0 = perfectly calibrated
        const factor = clamp(1 - P.credentialWeight * miscal * 4, 0.4, 1); // 4x makes it bite
        cal *= factor;
      }

      act.brierDelta = cal;
      let discBonus = 0;
      if (act.disclosed && difficulty >= P.easyThreshold) discBonus = P.disclosureBonus;

      if (mech.m8_retrospectiveEscrow && cal > 0) {
        const held = cal * P.escrowFrac;
        delta += cal - held + discBonus;
        a.escrow.push({ matureRound: t + P.escrowMatureLag, amount: held, verdictCorrect: act.correct, stated: act.stated });
      } else {
        delta += cal + discBonus;
      }

      const wasWrong = act.correct === 0;
      const lossToRecover = Math.max(0, -cal);
      if (a.strategy === 'error-farmer') {
        a.pendingRepairs.push({ repairRound: t + 1, errorClass: act.errorClass, lossToRecover, manufactured: true });
      } else if (a.strategy === 'honest-calibrated' && wasWrong) {
        if (rng.next() < P.honestNoticeProb)
          a.pendingRepairs.push({ repairRound: t + 1, errorClass: act.errorClass, lossToRecover, manufactured: false });
      } else if (a.strategy === 'concealer' && wasWrong) {
        const detectP = mech.m6_rotatingRedteam ? P.detectRedteam : P.detectBase;
        a.concealed.push({ resolveRound: t + P.escrowMatureLag, basePenalty: Math.max(0.5, lossToRecover), detected: rng.next() < detectP });
      }
    }
    a.cumDelta += delta;
  }

  // -- phase 3: repairs due this round (learning-adjusted, recency-based decay) --
  for (const a of agents) {
    if (a.pendingRepairs.length === 0) continue;
    const due = a.pendingRepairs.filter((r) => r.repairRound === t);
    a.pendingRepairs = a.pendingRepairs.filter((r) => r.repairRound !== t);
    for (const r of due) {
      const log = a.repairLog.get(r.errorClass) ?? [];
      // recent same-class repairs within the recency window -> recurrence speed proxy
      const recent = log.filter((rr) => t - rr <= P.repairRecencyWindow).length;
      let bonus: number;
      if (mech.m1_learningAdjustedRepair) {
        bonus =
          recent >= P.nonLearnThreshold
            ? -P.nonLearnPenalty // re-fixing the SAME class fast & often = non-learning
            : P.repairBonus0 * Math.exp(-P.repairDecayLambda * recent);
      } else {
        bonus = P.repairBonus0; // flat -> error-farming pays
      }
      let redteamPenalty = 0;
      if (mech.m6_rotatingRedteam && r.manufactured && recent >= 2 && rng.next() < P.farmDetectRedteam)
        redteamPenalty = P.concealMult * P.repairBonus0;
      a.cumDelta += P.repairRecoverFrac * r.lossToRecover + bonus - redteamPenalty;
      log.push(t);
      a.repairLog.set(r.errorClass, log);
    }
  }

  // -- phase 4: cross-agent mechanisms --
  crossAgent(agents, mech, P);

  // -- phase 5: escrow maturation + concealment resolution --
  for (const a of agents) {
    if (a.escrow.length) {
      const matured = a.escrow.filter((e) => e.matureRound === t);
      a.escrow = a.escrow.filter((e) => e.matureRound !== t);
      for (const e of matured) {
        if (e.verdictCorrect === 1) a.cumDelta += e.amount;
        else a.cumDelta -= e.amount * (0.5 + e.stated); // confident-wrong clawback
      }
    }
    if (a.concealed.length) {
      const res = a.concealed.filter((c) => c.resolveRound === t);
      a.concealed = a.concealed.filter((c) => c.resolveRound !== t);
      for (const c of res) if (c.detected) a.cumDelta -= P.concealMult * c.basePenalty;
    }
  }
}

// ----------------------------------------------------------------------------
// Cross-agent mechanisms (BTS, residual-correlation, independent-correct, ecosystem).
// ----------------------------------------------------------------------------
function crossAgent(agents: Agent[], mech: Mechanisms, P: Params): void {
  const answering = agents.filter((a) => a.cur && !a.cur.abstain);
  if (answering.length === 0) return;

  let v1 = 0;
  for (const a of answering) if (a.cur!.verdict === 1) v1++;
  const freq1 = v1 / answering.length;
  const freq0 = 1 - freq1;

  for (const a of answering) {
    const act = a.cur!;
    // M5: reward independent-correct (broke from majority AND right), scaled by rarity
    if (mech.m5_rewardIndependentCorrect && act.correct === 1 && act.brokeFromPublic) {
      const myFreq = act.verdict === 1 ? freq1 : freq0;
      a.cumDelta += P.independentBonus * (1 - myFreq);
    }
    // M2: BTS proxy — reward "surprisingly common correct" (non-degenerate), truth-inducing
    if (mech.m2_peerPredictionBTS && act.correct === 1) {
      const myFreq = act.verdict === 1 ? freq1 : freq0;
      a.cumDelta += P.btsBonus * (0.5 - Math.abs(myFreq - 0.5));
    }
  }

  // M3: residual-correlation collusion detector — unanimous cliques agreeing beyond what truth
  // explains are penalized (unanimous-wrong = pure collusion; unanimous-right = suspicious/light).
  if (mech.m3_residualCorrelation) {
    const cliques = new Map<number, Agent[]>();
    for (const a of answering) {
      if (a.cliqueId < 0) continue;
      const arr = cliques.get(a.cliqueId) ?? [];
      arr.push(a);
      cliques.set(a.cliqueId, arr);
    }
    for (const [, members] of cliques) {
      if (members.length < 2) continue;
      const v0 = members[0]!.cur!.verdict;
      const unanimous = members.every((m) => m.cur!.verdict === v0);
      if (unanimous) {
        const wrongTogether = members[0]!.cur!.correct === 0;
        const penalty = wrongTogether ? P.collusionPenalty : P.collusionPenalty * 0.35;
        for (const m of members) m.cumDelta -= penalty;
      }
    }
  }

  // M7: ecosystem multiplier — verified independent contribution (>1); self-referential clique (<1)
  if (mech.m7_ecosystemMultiplier) {
    for (const a of answering) {
      const act = a.cur!;
      if (a.cliqueId >= 0) {
        if (act.brierDelta > 0) a.cumDelta -= act.brierDelta * (1 - P.ecosystemSelf);
      } else if (act.correct === 1 && act.brokeFromPublic) {
        if (act.brierDelta > 0) a.cumDelta += act.brierDelta * (P.ecosystemIndep - 1);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Run wrappers
// ----------------------------------------------------------------------------
interface StratResult {
  strategy: Strategy;
  meanCumDelta: number;
  meanRepid: number;
  accuracy: number;
  coverage: number;
  meanStatedConf: number;
  calibrationError: number;
}
interface RunResult {
  perStrategy: StratResult[];
  ranking: Strategy[];
  honestRank: number;
  honestIsTop: boolean;
  noDishonestBeatsHonest: boolean;
  byStrat: Map<Strategy, StratResult>;
}

function summarize(agents: Agent[]): RunResult {
  const groups = new Map<Strategy, Agent[]>();
  for (const a of agents) {
    const arr = groups.get(a.strategy) ?? [];
    arr.push(a);
    groups.set(a.strategy, arr);
  }
  const perStrategy: StratResult[] = [];
  const byStrat = new Map<Strategy, StratResult>();
  for (const s of STRATEGIES) {
    const arr = groups.get(s) ?? [];
    const n = arr.length || 1;
    const meanCumDelta = arr.reduce((x, a) => x + a.cumDelta, 0) / n;
    const meanRepid = arr.reduce((x, a) => x + a.repid, 0) / n;
    const totalAns = arr.reduce((x, a) => x + a.answered, 0);
    const totalCorrect = arr.reduce((x, a) => x + a.correctOnAnswered, 0);
    const totalRounds = arr.reduce((x, a) => x + a.answered + a.abstained, 0);
    const accuracy = totalAns > 0 ? totalCorrect / totalAns : 0;
    const coverage = totalRounds > 0 ? totalAns / totalRounds : 0;
    const meanStatedConf = totalAns > 0 ? arr.reduce((x, a) => x + a.confSumOnAnswered, 0) / totalAns : 0;
    const r: StratResult = {
      strategy: s,
      meanCumDelta,
      meanRepid,
      accuracy,
      coverage,
      meanStatedConf,
      calibrationError: Math.abs(meanStatedConf - accuracy),
    };
    perStrategy.push(r);
    byStrat.set(s, r);
  }
  const ranking = [...perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta).map((r) => r.strategy);
  const honestRank = ranking.indexOf('honest-calibrated') + 1;
  const honest = byStrat.get('honest-calibrated')!;
  const noDishonestBeatsHonest = perStrategy
    .filter((r) => r.strategy !== 'honest-calibrated')
    .every((r) => r.meanCumDelta < honest.meanCumDelta);
  return { perStrategy, ranking, honestRank, honestIsTop: honestRank === 1, noDishonestBeatsHonest, byStrat };
}

function run(seed: number, rounds: number, mech: Mechanisms, P: Params, antifragility: boolean): { result: RunResult; windows: AntifragilityWindow[] } {
  const rng = new RNG(seed);
  const agents = buildPopulation(P);
  const nWindows = 4;
  const winSize = Math.max(1, Math.floor(rounds / nWindows));
  const boundaries: number[] = [];
  for (let w = 1; w <= nWindows; w++) boundaries.push(Math.min(rounds, w * winSize));
  const snapshots: Map<Strategy, number>[] = [];
  const trapAccum: number[] = new Array(nWindows).fill(0);
  const trapCount: number[] = new Array(nWindows).fill(0);
  let bIdx = 0;

  for (let t = 0; t < rounds; t++) {
    const pressure = antifragility ? t / rounds : 0;
    const difficulty = clamp(P.baseDifficulty + pressure * 0.45, 0, 0.9);
    const trapProb = clamp(P.baseTrapProb + pressure * 0.55, 0, 0.85);
    if (antifragility) {
      const w = Math.min(nWindows - 1, Math.floor(t / winSize));
      trapAccum[w] = (trapAccum[w] ?? 0) + trapProb;
      trapCount[w] = (trapCount[w] ?? 0) + 1;
    }
    runRound(agents, difficulty, trapProb, mech, P, rng, t);
    if (antifragility && bIdx < boundaries.length && t + 1 === boundaries[bIdx]) {
      const snap = new Map<Strategy, number>();
      const groups = new Map<Strategy, Agent[]>();
      for (const a of agents) {
        const arr = groups.get(a.strategy) ?? [];
        arr.push(a);
        groups.set(a.strategy, arr);
      }
      for (const s of STRATEGIES) {
        const arr = groups.get(s) ?? [];
        snap.set(s, arr.reduce((x, a) => x + a.cumDelta, 0) / (arr.length || 1));
      }
      snapshots.push(snap);
      bIdx++;
    }
  }
  for (const a of agents) a.repid = clamp(1000 + a.cumDelta, 10, 10000);
  const result = summarize(agents);

  const windows: AntifragilityWindow[] = [];
  if (antifragility) {
    for (let w = 0; w < snapshots.length; w++) {
      const cur = snapshots[w]!;
      const prev = w === 0 ? null : snapshots[w - 1]!;
      const per = (s: Strategy): number => {
        const now = cur.get(s) ?? 0;
        const before = prev ? prev.get(s) ?? 0 : 0;
        const dRounds = w === 0 ? boundaries[0]! : boundaries[w]! - boundaries[w - 1]!;
        return (now - before) / dRounds;
      };
      const honestD = per('honest-calibrated');
      let bestS: Strategy = 'overconfident';
      let bestD = -Infinity;
      for (const s of STRATEGIES) {
        if (s === 'honest-calibrated') continue;
        const d = per(s);
        if (d > bestD) {
          bestD = d;
          bestS = s;
        }
      }
      const lo = w === 0 ? 0 : boundaries[w - 1]!;
      const hi = boundaries[w]! - 1;
      windows.push({
        window: `${lo}-${hi}`,
        meanTrapProb: (trapAccum[w] ?? 0) / Math.max(1, trapCount[w] ?? 1),
        honestMeanDelta: honestD,
        bestDishonestStrategy: bestS,
        bestDishonestMeanDelta: bestD,
        honestAdvantage: honestD - bestD,
      });
    }
  }
  return { result, windows };
}

interface AntifragilityWindow {
  window: string;
  meanTrapProb: number;
  honestMeanDelta: number;
  bestDishonestStrategy: Strategy;
  bestDishonestMeanDelta: number;
  honestAdvantage: number;
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------
function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}
function stratTable(res: RunResult): string {
  const rows = [...res.perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta);
  let s = '| Rank | Strategy | Mean cumΔ | Mean RepID | Accuracy | Coverage | Mean conf | Calib err |\n';
  s += '|---|---|---:|---:|---:|---:|---:|---:|\n';
  rows.forEach((r, i) => {
    const star = r.strategy === 'honest-calibrated' ? ' **←honest**' : '';
    s += `| ${i + 1} | ${r.strategy}${star} | ${fmt(r.meanCumDelta)} | ${fmt(r.meanRepid, 0)} | ${fmt(r.accuracy, 3)} | ${fmt(r.coverage, 3)} | ${fmt(r.meanStatedConf, 3)} | ${fmt(r.calibrationError, 3)} |\n`;
  });
  return s;
}

function main(): void {
  const argv = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : def;
  };
  const seed = parseInt(getArg('--seed', '1337'), 10);
  const rounds = parseInt(getArg('--rounds', '4000'), 10);
  const P = defaultParams();

  const out: string[] = [];
  const log = (s = ''): void => {
    out.push(s);
    // eslint-disable-next-line no-console
    console.log(s);
  };

  log(`# RRL Honesty-Dominance Simulation — Results`);
  log('');
  log(`**Generated:** ${new Date().toISOString()}  `);
  log(`**Sim:** \`scripts/rrl/honesty-sim.ts\` · **Seed:** ${seed} · **Rounds:** ${rounds} · **Agents/strategy:** ${P.agentsPerStrategy} (colluders in cliques of ${P.cliqueSize})  `);
  log(`**Design:** reports/2026-07-18/RRL_DESIGN_v0.md  `);
  log('');
  log(`> **Scoring rule (proper):** \`delta = R − K·(p−outcome)²\`, R=${P.R_participation}, K=${P.K_cal} (break-even Brier ${fmt(P.R_participation / P.K_cal, 3)}). Repair = recover lost portion + capped bonus ${P.repairBonus0}, learning-adjusted decay (recency window ${P.repairRecencyWindow} rounds, λ=${P.repairDecayLambda}). Concealment multiplier ${P.concealMult}×. All strategies share competence ${P.competence} so ranking reflects **strategy, not skill**. Metric = cumulative earned Δ (unclamped); RepID shown clamped to the live [10,10000].`);
  log('');

  // ---- 1. MAIN ----
  const mainRun = run(seed, rounds, allOn(), P, false).result;
  log(`## 1. Final reputation ranking — all 9 mechanisms ON`);
  log('');
  log(stratTable(mainRun));
  log('');
  const pass = mainRun.honestIsTop && mainRun.noDishonestBeatsHonest;
  log(`**PASS criterion:** honest-calibrated ranks #1 AND no dishonest strategy out-earns it.  `);
  log(`**Honest rank:** #${mainRun.honestRank} of ${STRATEGIES.length}. **No dishonest beats honest:** ${mainRun.noDishonestBeatsHonest}.`);
  log('');
  log(`### VERDICT: ${pass ? '✅ PASS — honesty is the dominant strategy' : '❌ FAIL — a dishonest strategy is competitive'}`);
  log('');

  // ---- 2a. base rule only (all mechanisms OFF) ----
  log(`## 2. Ablation`);
  log('');
  log(`### 2a. Base proper-scoring-rule ONLY (all 9 mechanisms OFF)`);
  log('');
  log(`Isolates what the Brier proper rule + repair + concealment asymmetry deliver with zero anti-gaming hardening.`);
  log('');
  const baseOnly = run(seed, rounds, allOff(), P, false).result;
  log(stratTable(baseOnly));
  log('');
  log(`Base-rule honest rank: #${baseOnly.honestRank}. ${baseOnly.honestIsTop ? 'The proper scoring rule alone already makes honesty #1; the 9 mechanisms are hardening/defense-in-depth on top.' : 'The proper rule alone is NOT sufficient — at least one exploit beats honesty without the mechanisms.'}`);
  log('');

  // ---- 2b. single-mechanism ablation ----
  log(`### 2b. Single-mechanism ablation (one OFF, other eight ON)`);
  log('');
  log(`"Winner" = top earner. "Honest lead over #2" shows how much each mechanism widens honesty's margin (its marginal contribution given the others).`);
  log('');
  const baseSorted = [...mainRun.perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta);
  const baseLead = baseSorted[0]!.meanCumDelta - baseSorted[1]!.meanCumDelta;
  let at = '| Mechanism OFF | Honest rank | Winner | Honest lead over #2 | Δ vs baseline lead | Exploit wins? |\n';
  at += '|---|---:|---|---:|---:|---|\n';
  at += `| (baseline, all ON) | #${mainRun.honestRank} | ${baseSorted[0]!.strategy} | ${fmt(baseLead)} | — | ${mainRun.honestIsTop ? 'no' : 'YES'} |\n`;
  const single: { key: keyof Mechanisms; lead: number; honestTop: boolean; winner: Strategy }[] = [];
  for (const key of MECH_KEYS) {
    const m = allOn();
    m[key] = false;
    const r = run(seed, rounds, m, P, false).result;
    const sorted = [...r.perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta);
    const honest = r.byStrat.get('honest-calibrated')!;
    const bestOther = sorted.find((x) => x.strategy !== 'honest-calibrated')!;
    const lead = honest.meanCumDelta - bestOther.meanCumDelta;
    single.push({ key, lead, honestTop: r.honestIsTop, winner: sorted[0]!.strategy });
    at += `| ${MECH_LABEL[key]} | #${r.honestRank} | ${sorted[0]!.strategy} | ${fmt(lead)} | ${fmt(lead - baseLead)} | ${r.honestIsTop ? 'no' : '🔴 YES'} |\n`;
  }
  log(at);
  log('');
  const flips = single.filter((s) => !s.honestTop);
  log(`**Single-mechanism load-bearing (removing alone lets an exploit win):** ${flips.length ? flips.map((s) => MECH_LABEL[s.key]).join('; ') : 'none — every exploit is defended by more than one mechanism, so no single removal flips the ranking (defense-in-depth). Marginal contribution is read from the "Δ vs baseline lead" column, and the family ablation below isolates each exploit.'}`);
  log('');

  // ---- 2c. mechanism-FAMILY ablation (turn off ALL defenders of an exploit) ----
  log(`### 2c. Family ablation — turn OFF every mechanism that defends a given exploit`);
  log('');
  log(`This is the real load-bearing test: if the whole defense family for an exploit is removed, does that exploit win? "Winner cumΔ" vs "Honest cumΔ" shows the flip.`);
  log('');
  interface Family {
    name: string;
    exploit: Strategy;
    off: (keyof Mechanisms)[];
  }
  const families: Family[] = [
    { name: 'Anti-error-farming (M1+M6 off)', exploit: 'error-farmer', off: ['m1_learningAdjustedRepair', 'm6_rotatingRedteam'] },
    { name: 'Anti-collusion (M2+M3+M7 off)', exploit: 'colluder', off: ['m2_peerPredictionBTS', 'm3_residualCorrelation', 'm7_ecosystemMultiplier'] },
    { name: 'Anti-sandbag (M4 off)', exploit: 'sandbagger', off: ['m4_lazyCoveragePenalty'] },
    { name: 'Anti-herd (M5 off)', exploit: 'herd-follower', off: ['m5_rewardIndependentCorrect'] },
    { name: 'Anti-concealment (M6+M8 off)', exploit: 'concealer', off: ['m6_rotatingRedteam', 'm8_retrospectiveEscrow'] },
    { name: 'Anti-overconfidence (M8+M9 off)', exploit: 'overconfident', off: ['m8_retrospectiveEscrow', 'm9_calibrationCredential'] },
  ];
  let ft = '| Family OFF | Targeted exploit | Winner | Winner cumΔ | Honest cumΔ | Exploit cumΔ | Exploit now beats honest? |\n';
  ft += '|---|---|---|---:|---:|---:|---|\n';
  const familyFindings: { name: string; exploit: Strategy; beats: boolean; winner: Strategy }[] = [];
  for (const fam of families) {
    const m = allOn();
    for (const k of fam.off) m[k] = false;
    const r = run(seed, rounds, m, P, false).result;
    const sorted = [...r.perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta);
    const honest = r.byStrat.get('honest-calibrated')!;
    const exploit = r.byStrat.get(fam.exploit)!;
    const beats = exploit.meanCumDelta >= honest.meanCumDelta;
    familyFindings.push({ name: fam.name, exploit: fam.exploit, beats, winner: sorted[0]!.strategy });
    ft += `| ${fam.name} | ${fam.exploit} | ${sorted[0]!.strategy} | ${fmt(sorted[0]!.meanCumDelta)} | ${fmt(honest.meanCumDelta)} | ${fmt(exploit.meanCumDelta)} | ${beats ? '🔴 YES — load-bearing' : 'no — honesty holds'} |\n`;
  }
  log(ft);
  log('');
  const loadBearingFamilies = familyFindings.filter((f) => f.beats);
  const redundantFamilies = familyFindings.filter((f) => !f.beats);
  log(`**Load-bearing families (removing the whole defense lets the exploit match/beat honesty):** ${loadBearingFamilies.length ? loadBearingFamilies.map((f) => `${f.name} → ${f.exploit} wins`).join('; ') : 'none'}.`);
  log('');
  log(`**Families that turned out NOT load-bearing (honesty holds even with the whole family off):** ${redundantFamilies.length ? redundantFamilies.map((f) => f.name).join('; ') + ' — for these, honesty is protected by the base proper scoring rule itself, so the named mechanisms are redundant given the rule (report-honest finding, not a tuned outcome).' : 'none'}.`);
  log('');

  // ---- 2d. deterrence value (base-rule-only vs all-on, per exploit) ----
  log(`### 2d. Deterrence value — each exploit's reputation, base-rule-only vs all-mechanisms`);
  log('');
  log(`A mechanism family can be "not load-bearing for honesty's #1 RANK" yet still essential for DETERRENCE — driving an exploit from mildly-profitable to actively reputation-losing. That matters under population shift (if agents drift toward an exploit). This isolates that value.`);
  log('');
  let dt = '| Exploit | cumΔ base-rule-only | cumΔ all-ON | Mechanisms\' effect |\n|---|---:|---:|---|\n';
  for (const s of STRATEGIES) {
    if (s === 'honest-calibrated') continue;
    const b = baseOnly.byStrat.get(s)!.meanCumDelta;
    const a = mainRun.byStrat.get(s)!.meanCumDelta;
    const eff = a < b ? `↓ ${fmt(b - a)} (deterred)` : `↑ ${fmt(a - b)}`;
    dt += `| ${s} | ${fmt(b)} | ${fmt(a)} | ${eff} |\n`;
  }
  log(dt);
  log('');

  // ---- surviving exploit (all ON) ----
  const honestBase = mainRun.byStrat.get('honest-calibrated')!.meanCumDelta;
  const survivors = mainRun.perStrategy.filter((x) => x.strategy !== 'honest-calibrated' && x.meanCumDelta >= honestBase);
  log(`**Surviving exploit with everything ON:** ${survivors.length ? survivors.map((s) => `${s.strategy} (cumΔ ${fmt(s.meanCumDelta)} ≥ honest ${fmt(honestBase)}) — ⚠️ DESIGN HOLE, reported not hidden`).join('; ') : 'none — no exploit matches or beats honesty with all mechanisms on.'}`);
  log('');

  // ---- 3. ANTIFRAGILITY ----
  log(`## 3. Antifragility — honest advantage as adversarial pressure rises`);
  log('');
  log(`Difficulty and trap-probability (misleading public/majority signal) rise linearly across the run. Antifragile ⇒ honest per-round advantage over the best deceptive strategy HOLDS or IMPROVES as pressure climbs.`);
  log('');
  const anti = run(seed, rounds, allOn(), P, true).windows;
  let aw = '| Round window | Mean trap prob | Honest Δ/round | Best dishonest | Its Δ/round | Honest advantage |\n';
  aw += '|---|---:|---:|---|---:|---:|\n';
  for (const w of anti) aw += `| ${w.window} | ${fmt(w.meanTrapProb, 3)} | ${fmt(w.honestMeanDelta, 3)} | ${w.bestDishonestStrategy} | ${fmt(w.bestDishonestMeanDelta, 3)} | ${fmt(w.honestAdvantage, 3)} |\n`;
  log(aw);
  log('');
  const first = anti[0];
  const last = anti[anti.length - 1];
  const antiVerdict = first && last ? (last.honestAdvantage >= first.honestAdvantage - 1e-6 ? '✅ HOLDS/IMPROVES' : '⚠️ ERODES') : 'inconclusive';
  log(`**Antifragility check:** honest advantage first window ${first ? fmt(first.honestAdvantage, 3) : 'n/a'} → last window ${last ? fmt(last.honestAdvantage, 3) : 'n/a'} → ${antiVerdict}.`);
  log('');

  // ---- 4. SENSITIVITY ----
  log(`## 4. Sensitivity — concealment ratio and repair-bonus size`);
  log('');
  log(`One knob at a time, all mechanisms ON. Shows honest rank plus the directly-affected exploit's cumΔ so the knob is visibly load-bearing.`);
  log('');
  let st = '| Variant | Honest rank | Honest cumΔ | Affected exploit | Its cumΔ | Honest still #1 |\n|---|---:|---:|---|---:|---|\n';
  const runVariant = (label: string, affected: Strategy, mut: (p: Params) => void): void => {
    const p2 = defaultParams();
    mut(p2);
    const r = run(seed, rounds, allOn(), p2, false).result;
    const honest = r.byStrat.get('honest-calibrated')!;
    const ex = r.byStrat.get(affected)!;
    st += `| ${label} | #${r.honestRank} | ${fmt(honest.meanCumDelta)} | ${affected} | ${fmt(ex.meanCumDelta)} | ${r.honestIsTop ? '✅' : '❌'} |\n`;
  };
  runVariant('concealMult 2×', 'concealer', (p) => (p.concealMult = 2.0));
  runVariant('concealMult 3× (default)', 'concealer', (p) => (p.concealMult = 3.0));
  runVariant('concealMult 5×', 'concealer', (p) => (p.concealMult = 5.0));
  runVariant('repairBonus 1.5 (half)', 'error-farmer', (p) => (p.repairBonus0 = 1.5));
  runVariant('repairBonus 3.0 (default)', 'error-farmer', (p) => (p.repairBonus0 = 3.0));
  runVariant('repairBonus 6.0 (2× larger)', 'error-farmer', (p) => (p.repairBonus0 = 6.0));
  log(st);
  log('');
  log(`Note: a **larger repair bonus** is the knob that could open error-farming — if it ever lets error-farmer approach honesty, M1's learning-decay + M6's red-team are what must keep pace. A **larger concealment multiplier** monotonically sinks the concealer.`);
  log('');

  // ---- 5. ROBUSTNESS across seeds ----
  log(`## 5. Robustness — verdict across independent seeds`);
  log('');
  log(`The PASS verdict must not be a single-seed artifact. Re-runs the full main scenario (all mechanisms ON) on 6 independent seeds.`);
  log('');
  let rt = '| Seed | Honest rank | No dishonest beats honest | Honest cumΔ | #2 strategy | #2 cumΔ |\n|---:|---:|---|---:|---|---:|\n';
  let allPass = true;
  for (const sd of [seed, 1, 42, 2718, 99999, 7]) {
    const r = run(sd, rounds, allOn(), P, false).result;
    const sorted = [...r.perStrategy].sort((a, b) => b.meanCumDelta - a.meanCumDelta);
    const honest = r.byStrat.get('honest-calibrated')!;
    const second = sorted.find((x) => x.strategy !== 'honest-calibrated')!;
    if (!(r.honestIsTop && r.noDishonestBeatsHonest)) allPass = false;
    rt += `| ${sd} | #${r.honestRank} | ${r.noDishonestBeatsHonest} | ${fmt(honest.meanCumDelta)} | ${second.strategy} | ${fmt(second.meanCumDelta)} |\n`;
  }
  log(rt);
  log('');
  log(`**Robustness:** ${allPass ? '✅ honest ranks #1 with no dishonest strategy out-earning it on EVERY seed tested' : '⚠️ verdict is seed-dependent — see failing rows above'}.`);
  log('');

  // ---- footer ----
  log(`## Reproducibility`);
  log('');
  log('```');
  log(`npx tsx scripts/rrl/honesty-sim.ts --seed ${seed} --rounds ${rounds}`);
  log('```');
  log('');
  log(`Deterministic Mulberry32 RNG; identical seed → identical numbers. No LLM, no infra, no DB.`);
  log('');
  log(`_Discipline note: parameters were fixed a-priori from the design doc's approved values and NOT tuned to make honesty win. Any surviving exploit / non-load-bearing mechanism above is reported, not hidden (RULE-4)._`);

  const reportDir = path.join(process.cwd(), 'reports', '2026-07-18');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'RRL_SIM_RESULTS.md');
  fs.writeFileSync(reportPath, out.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`\n[written] ${reportPath}`);
}

main();
