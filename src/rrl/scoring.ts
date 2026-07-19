/**
 * RRL — Response Reputation Layer: locked scoring core (WS2.3, extracted from WS2.2 sim).
 * ------------------------------------------------------------------------------------
 * This module is the SINGLE SOURCE OF TRUTH for the RRL reward rule. It was EXTRACTED
 * verbatim from the sim-proven core in `scripts/rrl/honesty-sim.ts` (WS2.2, honesty
 * dominant across 6 seeds) so that the simulation AND the shadow-mode scorer are
 * provably the same code. The sim imports these primitives; refactoring it to do so and
 * re-running seed 1337 to identical output is the anti-drift correctness check.
 *
 * Design source: reports/2026-07-18/RRL_DESIGN_v0.md (rule + M1-M9 LOCKED, WS2.2-proven).
 *
 * PURITY / DISCIPLINE:
 *   - Pure + deterministic. NO I/O, NO DB, NO network, NO clock, NO RepID writes.
 *   - Parameters are the a-priori design-doc values (NOT tuned). Changing them is a
 *     values decision (RRL_DESIGN_v0 §"VALUES DECISIONS FOR SEAN"), logged, not casual.
 *   - Nothing here touches repid_score_events / repid_agents / ERC-8004 / ZKP. The
 *     module computes deltas; wiring them to anything live is Stage-1+ and gated.
 */

// ============================================================================
// Deterministic RNG (Mulberry32) + Gaussian (Box-Muller). Seeded -> reproducible.
// Shared by the sim and the synthetic replay generator so both are the same code.
// ============================================================================
export class RNG {
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

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ============================================================================
// The 9 anti-gaming mechanisms — each a toggle so it can be ABLATED.
// Default (validated) set = all ON. This is the LOCKED WS2.2 configuration.
// ============================================================================
export interface Mechanisms {
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

export function allMechanismsOn(): Mechanisms {
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
export function allMechanismsOff(): Mechanisms {
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

export const MECH_KEYS: (keyof Mechanisms)[] = [
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

export const MECH_LABEL: Record<keyof Mechanisms, string> = {
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

// ============================================================================
// Parameters — a-priori from RRL_DESIGN_v0's approved values. Documented, not tuned.
// These are the LOCKED knobs: Brier R=4/K=20, repair bonus 3 w/ recency-window 40 λ=0.9,
// concealment 3x. (Population knobs like competence/agentsPerStrategy are sim-only but
// live here so the sim and replay share one param object.)
// ============================================================================
export interface RRLParams {
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

export function defaultRRLParams(): RRLParams {
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

// ============================================================================
// LOCKED PRIMITIVES — the actual reward math. The sim inlines nothing anymore;
// it calls these, and so does the RRLScorer. Same functions => provably same core.
// ============================================================================

/** Component 1 — Calibration via a strictly-proper scoring rule (Brier). */
export function calibrationDelta(p: number, outcome: number, P: RRLParams): number {
  return P.R_participation - P.K_cal * (p - outcome) * (p - outcome);
}

/**
 * M9 calibration-over-time credential factor. Scales a POSITIVE calibration gain by how
 * well the agent's stated confidence has tracked its realized accuracy so far. Perfectly
 * calibrated -> 1 (untouched); overconfident -> shaved toward 0.4. Caller applies the
 * guard (mech.m9 && cal > 0 && enough history).
 */
export function credentialFactor(statedMean: number, realizedMean: number, P: RRLParams): number {
  const miscal = Math.abs(statedMean - realizedMean); // 0 = perfectly calibrated
  return clamp(1 - P.credentialWeight * miscal * 4, 0.4, 1); // 4x makes it bite
}

/** Component 2 — disclosure bonus: protected uncertainty on non-trivial claims. */
export function disclosureBonusFor(disclosed: boolean, difficulty: number, P: RRLParams): number {
  return disclosed && difficulty >= P.easyThreshold ? P.disclosureBonus : 0;
}

/**
 * Component 3 + M1 — learning-adjusted repair bonus. `recentSameClass` = # of same
 * error-class repairs inside the recency window. First repair of a novel class = full
 * bonus; re-fixing a recurring mistake decays to ~0, then (>= threshold) a non-learning
 * penalty. With M1 off, the bonus is flat (which is what lets error-farming pay).
 */
export function learningAdjustedRepairBonus(recentSameClass: number, m1On: boolean, P: RRLParams): number {
  if (!m1On) return P.repairBonus0;
  return recentSameClass >= P.nonLearnThreshold
    ? -P.nonLearnPenalty
    : P.repairBonus0 * Math.exp(-P.repairDecayLambda * recentSameClass);
}

/** Concealment asymmetry — a hidden error that surfaces costs concealMult x its base. */
export function concealmentPenalty(basePenalty: number, P: RRLParams): number {
  return P.concealMult * basePenalty;
}

/** M8 escrow settlement — held portion released if correct; confident-wrong clawed back. */
export function settleEscrow(verdictCorrect: number, amount: number, stated: number): number {
  return verdictCorrect === 1 ? amount : -amount * (0.5 + stated);
}

/** M5 — reward independent-correct (broke from majority AND right), scaled by rarity. */
export function independentCorrectBonus(myVerdictFreq: number, P: RRLParams): number {
  return P.independentBonus * (1 - myVerdictFreq);
}

/** M2 — BTS proxy: reward "surprisingly common correct" (non-degenerate), truth-inducing. */
export function btsBonusFor(myVerdictFreq: number, P: RRLParams): number {
  return P.btsBonus * (0.5 - Math.abs(myVerdictFreq - 0.5));
}

// ============================================================================
// RRLScorer — stateful per-agent scorer for SHADOW mode. Encapsulates the deferred
// mechanics (escrow / concealment / repair scheduling) and calls the exact primitives
// above. This is the production scoring path the shadow-ledger records; it computes a
// would-be delta only — it NEVER writes RepID. Cross-agent mechanisms (M2/M3/M5/M7) that
// need a panel are applied by the caller (replay harness) when panel context is present.
// ============================================================================

export interface RRLResponseEvent {
  agentId: string;
  round: number; // logical time index (monotonic per replay)
  abstain: boolean;
  confidence: number; // stated p in [0,1] (ignored if abstain)
  correct: 0 | 1; // oracle outcome from HAL / peer-verify (ignored if abstain)
  disclosed: boolean;
  difficulty: number; // [0,1] claim difficulty from the oracle context
  errorClass: number; // semantic error-class id (for M1 recurrence)
  /** Scheduling of a self-repair of THIS response (agent detected + corrected its error). */
  scheduleRepair?: boolean;
  /** This response is a CONCEALED error; `concealSurfaced` = oracle later exposed it. */
  concealed?: boolean;
  concealSurfaced?: boolean;
  /** True if the repair being scheduled is a manufactured (error-farming) one. */
  manufactured?: boolean;
}

export interface RRLObservation {
  agentId: string;
  round: number;
  immediateDelta: number; // delta applied at observe time (excludes deferred settlements)
  escrowHeld: number; // portion deferred to escrow maturation
  mechanismsFired: string[]; // human-readable list, e.g. ['M8 escrow','M9 credential']
  detectorFired: boolean; // an anti-gaming DETECTOR penalty fired (for FP-rate metric)
}

interface EscrowEntry {
  matureRound: number;
  amount: number;
  verdictCorrect: number;
  stated: number;
}
interface ConcealedEntry {
  resolveRound: number;
  basePenalty: number;
  surfaced: boolean;
}
interface PendingRepair {
  repairRound: number;
  errorClass: number;
  lossToRecover: number;
  manufactured: boolean;
}

export class RRLScorer {
  readonly agentId: string;
  private P: RRLParams;
  private mech: Mechanisms;
  cumDelta = 0;
  answered = 0;
  abstained = 0;
  correctOnAnswered = 0;
  confSumOnAnswered = 0;
  private escrow: EscrowEntry[] = [];
  private concealed: ConcealedEntry[] = [];
  private pendingRepairs: PendingRepair[] = [];
  private repairLog = new Map<number, number[]>(); // errorClass -> rounds repaired

  constructor(agentId: string, P: RRLParams = defaultRRLParams(), mech: Mechanisms = allMechanismsOn()) {
    this.agentId = agentId;
    this.P = P;
    this.mech = mech;
  }

  /** Would-be RepID from a 1000 baseline, clamped to the live [10,10000] band. */
  get wouldBeRepid(): number {
    return clamp(1000 + this.cumDelta, 10, 10000);
  }

  /** Realized accuracy on answered events so far (independent reliability signal). */
  get realizedAccuracy(): number {
    return this.answered > 0 ? this.correctOnAnswered / this.answered : 0;
  }
  get coverage(): number {
    const total = this.answered + this.abstained;
    return total > 0 ? this.answered / total : 0;
  }

  /**
   * Observe one ground-truth-bearing response. Mirrors the sim's per-agent phase-2 logic
   * (calibration + disclosure + M9 credential + M8 escrow scheduling + repair/conceal
   * scheduling). Returns the immediate delta + which mechanisms fired. Deferred pieces
   * (repairs, escrow maturation, concealment surfacing) settle via `settle(round)`.
   */
  observe(ev: RRLResponseEvent): RRLObservation {
    const P = this.P;
    const mech = this.mech;
    const fired: string[] = [];
    let detectorFired = false;
    let delta = 0;
    let escrowHeld = 0;

    if (ev.abstain) {
      this.abstained++;
      if (mech.m4_lazyCoveragePenalty) {
        if (ev.difficulty < P.easyThreshold) {
          delta -= P.lazyEasyPenalty;
          fired.push('M4 lazy-easy');
          detectorFired = true;
        }
        const coverageSoFar = this.answered / Math.max(1, this.answered + this.abstained);
        if (coverageSoFar < P.coverageFloor) {
          delta -= P.lazyFloorPenalty;
          fired.push('M4 coverage-floor');
          detectorFired = true;
        }
      }
      this.cumDelta += delta;
      return { agentId: ev.agentId, round: ev.round, immediateDelta: delta, escrowHeld: 0, mechanismsFired: fired, detectorFired };
    }

    // answered
    this.answered++;
    this.confSumOnAnswered += ev.confidence;
    if (ev.correct) this.correctOnAnswered++;

    let cal = calibrationDelta(ev.confidence, ev.correct, P);
    fired.push('calibration');

    // M9 credential scaling of positive gains, once enough history exists.
    if (mech.m9_calibrationCredential && cal > 0 && this.answered > 20) {
      const realized = this.correctOnAnswered / this.answered;
      const stated = this.confSumOnAnswered / this.answered;
      const factor = credentialFactor(stated, realized, P);
      if (factor < 1) fired.push('M9 credential');
      cal *= factor;
    }

    const discBonus = disclosureBonusFor(ev.disclosed, ev.difficulty, P);
    if (discBonus > 0) fired.push('disclosure');

    if (mech.m8_retrospectiveEscrow && cal > 0) {
      const held = cal * P.escrowFrac;
      escrowHeld = held;
      delta += cal - held + discBonus;
      this.escrow.push({ matureRound: ev.round + P.escrowMatureLag, amount: held, verdictCorrect: ev.correct, stated: ev.confidence });
      fired.push('M8 escrow');
    } else {
      delta += cal + discBonus;
    }

    // Schedule self-repair (recover loss + learning-adjusted bonus, settled next round).
    const wasWrong = ev.correct === 0;
    const lossToRecover = Math.max(0, -cal);
    if (ev.scheduleRepair) {
      this.pendingRepairs.push({
        repairRound: ev.round + 1,
        errorClass: ev.errorClass,
        lossToRecover,
        manufactured: ev.manufactured === true,
      });
    }
    // Concealment: a hidden error that the oracle may later surface -> asymmetric penalty.
    if (ev.concealed && wasWrong) {
      this.concealed.push({
        resolveRound: ev.round + P.escrowMatureLag,
        basePenalty: Math.max(0.5, lossToRecover),
        surfaced: ev.concealSurfaced === true,
      });
    }

    this.cumDelta += delta;
    return { agentId: ev.agentId, round: ev.round, immediateDelta: delta, escrowHeld, mechanismsFired: fired, detectorFired };
  }

  /**
   * Settle everything due at `round`: repairs (M1 learning-adjusted, M6 red-team on
   * manufactured farming), escrow maturation (M8), concealment surfacing. Returns the
   * settlement delta and the mechanisms that fired. `rng` is only consumed for the M6
   * red-team catch probability on manufactured repairs (kept explicit + deterministic).
   */
  settle(round: number, rng?: RNG): { delta: number; mechanismsFired: string[]; detectorFired: boolean } {
    const P = this.P;
    const mech = this.mech;
    const fired: string[] = [];
    let detectorFired = false;
    let delta = 0;

    // -- repairs due --
    if (this.pendingRepairs.length) {
      const due = this.pendingRepairs.filter((r) => r.repairRound === round);
      this.pendingRepairs = this.pendingRepairs.filter((r) => r.repairRound !== round);
      for (const r of due) {
        const log = this.repairLog.get(r.errorClass) ?? [];
        const recent = log.filter((rr) => round - rr <= P.repairRecencyWindow).length;
        const bonus = learningAdjustedRepairBonus(recent, mech.m1_learningAdjustedRepair, P);
        if (mech.m1_learningAdjustedRepair && recent >= P.nonLearnThreshold) {
          fired.push('M1 non-learning penalty');
          detectorFired = true;
        } else {
          fired.push('repair');
        }
        let redteamPenalty = 0;
        if (mech.m6_rotatingRedteam && r.manufactured && recent >= 2 && rng && rng.next() < P.farmDetectRedteam) {
          redteamPenalty = P.concealMult * P.repairBonus0;
          fired.push('M6 red-team catch');
          detectorFired = true;
        }
        delta += P.repairRecoverFrac * r.lossToRecover + bonus - redteamPenalty;
        log.push(round);
        this.repairLog.set(r.errorClass, log);
      }
    }

    // -- escrow maturation --
    if (this.escrow.length) {
      const matured = this.escrow.filter((e) => e.matureRound === round);
      this.escrow = this.escrow.filter((e) => e.matureRound !== round);
      for (const e of matured) {
        delta += settleEscrow(e.verdictCorrect, e.amount, e.stated);
        fired.push('M8 escrow settle');
      }
    }

    // -- concealment resolution --
    if (this.concealed.length) {
      const res = this.concealed.filter((c) => c.resolveRound === round);
      this.concealed = this.concealed.filter((c) => c.resolveRound !== round);
      for (const c of res) {
        if (c.surfaced) {
          delta -= concealmentPenalty(c.basePenalty, P);
          fired.push('concealment surfaced');
          detectorFired = true;
        }
      }
    }

    this.cumDelta += delta;
    return { delta, mechanismsFired: fired, detectorFired };
  }

  /** Any deferred items still outstanding (for a final flush at end of replay). */
  hasPending(): boolean {
    return this.pendingRepairs.length > 0 || this.escrow.length > 0 || this.concealed.length > 0;
  }
}
