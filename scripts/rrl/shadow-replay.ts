/**
 * WS2.3 Stage-0 — RRL Shadow Replay Harness
 * -----------------------------------------
 * Replays a stream of ground-truth-bearing events through the LOCKED production scorer
 * (`src/rrl/scoring.ts`) in STRICT SHADOW mode, writes the shadow ledger, and computes the
 * WS2.3 exit-gate metrics. There is no live swarm traffic while the system is frozen, so we
 * validate OFFLINE. This harness exercises the exit-gate machinery end-to-end; it does NOT
 * re-prove honesty-dominance (honesty-sim.ts already does, on the same core).
 *
 * ABSOLUTE SHADOW DISCIPLINE:
 *   - NO write to repid_score_events / repid_agents. NO ERC-8004 / ZKP / on-chain.
 *   - Uses the JSONL sink (forceArmed — an offline replay is inherently shadow-only and has
 *     zero live effect regardless of RRL_SHADOW_ENABLED). The DB sink stays a stub.
 *
 * EVENT SOURCE (checked-first, 2026-07-18):
 *   Real historical signal was probed read-only. `hal_production_events` = 5 rows, 0 with a
 *   populated ground-truth outcome (is_hallucination all NULL) -> 0 usable (confidence,
 *   outcome, error-class) tuples. `repid_score_events` is a delta audit log with no per-
 *   response correctness label. => real signal is NOT cleanly available. This harness
 *   therefore replays a DOCUMENTED SYNTHETIC stream that mirrors the sim's agent strategies.
 *   Every ledger row is labeled event_source='synthetic'. Swap in a real HAL/peer-verify
 *   subscription at Stage-0.5 when traffic resumes (see report "What remains").
 *
 * Run:  npx tsx scripts/rrl/shadow-replay.ts [--seed 1337] [--rounds 800] [--agents 3]
 * Emits: reports/2026-07-18/rrl-shadow-ledger.jsonl  +  RRL_SHADOW_REPLAY_RESULTS.md
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  RNG,
  clamp,
  defaultRRLParams,
  allMechanismsOn,
  RRLScorer,
  type RRLResponseEvent,
  type RRLParams,
} from '../../src/rrl/scoring';
import { JsonlShadowSink, ShadowLedger, defaultLedgerPath, type ShadowLedgerEntry } from '../../src/rrl/shadow-ledger';
import {
  fitReliabilityCurve,
  applyCalibration,
  makeCalibrator,
  kFoldEce,
  defaultCalibrationConfig,
  relativeCalibrationCredential,
  type ConfCorrectPair,
  type CalibrationConfig,
  type ReliabilityCurve,
} from '../../src/rrl/calibration';

// Neutral Epoch-1 baseline (STATE_OF_THE_SYSTEM: 12 core agents calibrated to 1000). We
// have no live RepID for synthetic agents, so we compare shadow-RepID against this baseline.
const LIVE_BASELINE_REPID = 1000;

type Archetype =
  | 'honest-calibrated'
  | 'overconfident'
  | 'sandbagger'
  | 'error-farmer'
  | 'concealer'
  | 'herd-follower';

/** Which archetypes are HONEST (non-gaming) — used for the detector false-positive metric. */
const HONEST_ARCHETYPES = new Set<Archetype>(['honest-calibrated']);

interface SynthAgent {
  id: string;
  archetype: Archetype;
  scorer: RRLScorer;
  /** per-event detector-fire log restricted to this agent, for FP-rate accounting */
  events: number;
  detectorFires: number;
}

/** Reliability histogram (10 confidence bins) for the honest cohort — Gate-1 diagram. */
const N_BINS = 10;
interface RelBin { confSum: number; correct: number; n: number; }
function newRelHist(): RelBin[] {
  return Array.from({ length: N_BINS }, () => ({ confSum: 0, correct: 0, n: 0 }));
}
function relBinIndex(conf: number): number {
  return Math.min(N_BINS - 1, Math.max(0, Math.floor(conf * N_BINS)));
}
/** Expected Calibration Error: weighted mean |mean-conf − realized-accuracy| over bins. */
function expectedCalibrationError(h: RelBin[]): number {
  const total = h.reduce((s, b) => s + b.n, 0);
  if (total === 0) return 1;
  let ece = 0;
  for (const b of h) {
    if (b.n === 0) continue;
    ece += (b.n / total) * Math.abs(b.confSum / b.n - b.correct / b.n);
  }
  return ece;
}

/**
 * Generate ONE synthetic response event for an agent this round, mirroring the sim's
 * per-strategy behavior. `publicSignal` is the (sometimes-misleading) majority/public cue.
 */
function genEvent(a: SynthAgent, round: number, P: RRLParams, difficulty: number, G: number, publicSignal: number, rng: RNG): RRLResponseEvent {
  const pCorrect = P.competence * (1 - difficulty) + 0.5 * difficulty;
  const b = clamp(pCorrect + rng.gauss(0, P.sigmaBelief), 0.5, 0.985);
  const ownCorrect = rng.bernoulli(b);
  const ownVerdict = ownCorrect ? G : 1 - G;
  const base = (over: Partial<RRLResponseEvent>): RRLResponseEvent => ({
    agentId: a.id,
    round,
    abstain: false,
    confidence: clamp(b, 0.02, 0.985),
    correct: (ownVerdict === G ? 1 : 0) as 0 | 1,
    disclosed: false,
    difficulty,
    errorClass: rng.int(12),
    ...over,
  });

  switch (a.archetype) {
    case 'honest-calibrated': {
      const wrong = ownVerdict !== G;
      return base({
        disclosed: b < P.discloseThreshold,
        scheduleRepair: wrong && rng.next() < P.honestNoticeProb,
      });
    }
    case 'overconfident':
      return base({ confidence: 0.97, disclosed: false });
    case 'sandbagger':
      if (b < 0.9 && rng.next() < 0.85) {
        return { agentId: a.id, round, abstain: true, confidence: 0.5, correct: 0, disclosed: true, difficulty, errorClass: -1 };
      }
      return base({ disclosed: false });
    case 'error-farmer':
      // deliberately wrong at low confidence, then "repair" the SAME class every round
      return {
        agentId: a.id,
        round,
        abstain: false,
        confidence: 0.35,
        correct: (1 - G === G ? 1 : 0) as 0 | 1, // always wrong (verdict = 1-G)
        disclosed: false,
        difficulty,
        errorClass: 0,
        scheduleRepair: true,
        manufactured: true,
      };
    case 'concealer': {
      const wrong = ownVerdict !== G;
      const detectP = P.detectRedteam; // M6 red-team surfacing probability
      return base({
        disclosed: false,
        concealed: wrong,
        concealSurfaced: wrong && rng.next() < detectP,
      });
    }
    case 'herd-follower':
      return base({ correct: (publicSignal === G ? 1 : 0) as 0 | 1, confidence: 0.85, disclosed: false });
    default:
      return base({});
  }
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function getArgFrom(argv: string[], name: string, def: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : def;
}

function runSynthetic(): void {
  const argv = process.argv.slice(2);
  const getArg = (name: string, def: string): string => getArgFrom(argv, name, def);
  const seed = parseInt(getArg('--seed', '1337'), 10);
  const rounds = parseInt(getArg('--rounds', '800'), 10);
  const perArch = parseInt(getArg('--agents', '3'), 10); // agents per archetype
  const P = defaultRRLParams();
  const mech = allMechanismsOn();
  const rng = new RNG(seed);
  const runId = `shadow-replay-${seed}-${rounds}-${new Date().toISOString().slice(0, 10)}`;

  // ---- build synthetic population ----
  const archetypes: Archetype[] = ['honest-calibrated', 'overconfident', 'sandbagger', 'error-farmer', 'concealer', 'herd-follower'];
  const agents: SynthAgent[] = [];
  for (const arch of archetypes) {
    for (let k = 0; k < perArch; k++) {
      const id = `${arch}#${k}`;
      agents.push({ id, archetype: arch, scorer: new RRLScorer(id, P, mech), events: 0, detectorFires: 0 });
    }
  }

  // ---- ledger sink (offline, forceArmed: inherently shadow-only) ----
  const sink = new JsonlShadowSink(defaultLedgerPath());
  sink.truncate();
  const ledger = new ShadowLedger(sink, { forceArmed: true });

  // reliability diagram accumulator for the honest cohort (Gate 1)
  const honestRelHist = newRelHist();

  // ---- replay loop ----
  for (let t = 0; t < rounds; t++) {
    const difficulty = P.baseDifficulty;
    const G = rng.bernoulli(0.5);
    const trap = rng.bernoulli(P.baseTrapProb);
    const publicSignal = trap ? 1 - G : G;

    // phase A: observe each agent's response
    for (const a of agents) {
      const ev = genEvent(a, t, P, difficulty, G, publicSignal, rng);
      const obs = a.scorer.observe(ev);
      a.events++;
      if (obs.detectorFired) a.detectorFires++;
      // Gate-1 reliability diagram: record (stated confidence, realized correctness) for honest agents
      if (HONEST_ARCHETYPES.has(a.archetype) && !ev.abstain) {
        const bin = honestRelHist[relBinIndex(ev.confidence)]!;
        bin.confSum += ev.confidence;
        bin.correct += ev.correct;
        bin.n += 1;
      }
      const entry: ShadowLedgerEntry = {
        ts: new Date().toISOString(),
        agent_id: a.id,
        event_id: `${runId}:obs:${a.id}:${t}`,
        event_source: 'synthetic',
        round: t,
        computed_delta: obs.immediateDelta,
        mechanisms_fired: obs.mechanismsFired,
        detector_fired: obs.detectorFired,
        would_be_repid: a.scorer.wouldBeRepid,
        live_repid: LIVE_BASELINE_REPID,
        note: `synthetic:${a.archetype}:observe`,
      };
      ledger.record(entry);
    }

    // phase B: settle deferred items due this round (repairs / escrow / concealment)
    for (const a of agents) {
      const s = a.scorer.settle(t, rng);
      if (s.delta !== 0 || s.mechanismsFired.length) {
        if (s.detectorFired) a.detectorFires++, a.events++; // count detector settlements toward FP denom cautiously
        ledger.record({
          ts: new Date().toISOString(),
          agent_id: a.id,
          event_id: `${runId}:settle:${a.id}:${t}`,
          event_source: 'synthetic',
          round: t,
          computed_delta: s.delta,
          mechanisms_fired: s.mechanismsFired,
          detector_fired: s.detectorFired,
          would_be_repid: a.scorer.wouldBeRepid,
          live_repid: LIVE_BASELINE_REPID,
          note: `synthetic:${a.archetype}:settle`,
        });
      }
    }
  }

  // flush any still-pending deferred items past the last round
  for (let extra = rounds; extra < rounds + P.escrowMatureLag + 2; extra++) {
    for (const a of agents) a.scorer.settle(extra, rng);
  }

  ledger.close();

  // ---- exit-gate metrics ----
  // Gate 1: CALIBRATION via a reliability diagram on the honest cohort (spec: "reliability-
  // diagram check, not a single point"). Expected Calibration Error must be small — an
  // agent's stated confidence must track its realized accuracy. Raw accuracy-vs-RepID is the
  // WRONG statistic here (RRL rewards calibration+honesty, not accuracy; herd-followers are
  // accurate-but-not-calibrated and are correctly NOT top-rewarded), so it is reported only
  // as supporting context using the UNCLAMPED trajectory (cumΔ).
  const ece = expectedCalibrationError(honestRelHist);
  const accs = agents.map((a) => a.scorer.realizedAccuracy);
  const cumDeltas = agents.map((a) => a.scorer.cumDelta);
  const accVsTrajectory = pearson(accs, cumDeltas); // supporting context only

  // Gate 2: honesty-ordering — honest cohort mean cumΔ must top every gaming cohort.
  const byArch = new Map<Archetype, SynthAgent[]>();
  for (const a of agents) {
    const arr = byArch.get(a.archetype) ?? [];
    arr.push(a);
    byArch.set(a.archetype, arr);
  }
  const cohortDelta = (arch: Archetype): number => {
    const arr = byArch.get(arch)!;
    return arr.reduce((s, a) => s + a.scorer.cumDelta, 0) / arr.length;
  };
  const cohortRanking = [...archetypes].sort((x, y) => cohortDelta(y) - cohortDelta(x));
  const honestCohortDelta = cohortDelta('honest-calibrated');
  const honestRank = cohortRanking.indexOf('honest-calibrated') + 1;
  const honestTopsGaming = archetypes
    .filter((x) => x !== 'honest-calibrated')
    .every((x) => cohortDelta(x) < honestCohortDelta);

  // Gate 3: no catastrophic UNEXPLAINED divergence. Flag an HONEST agent nuked to floor, or
  // any agent whose direction contradicts its ground-truthed accuracy without reason.
  let catastrophic = 0;
  const divergences: { id: string; arch: Archetype; repid: number; acc: number; explained: boolean }[] = [];
  for (const a of agents) {
    const repid = a.scorer.wouldBeRepid;
    const acc = a.scorer.realizedAccuracy;
    const gaming = !HONEST_ARCHETYPES.has(a.archetype);
    // "explained" = direction matches ground truth OR agent is a known gaming archetype.
    const wentDown = repid < LIVE_BASELINE_REPID;
    const explained = gaming ? true : acc >= 0.6 ? repid >= LIVE_BASELINE_REPID : wentDown;
    if (!explained) catastrophic++;
    divergences.push({ id: a.id, arch: a.archetype, repid, acc, explained });
  }

  // Gate 4: detector false-positive rate on HONEST agents.
  const honestAgents = agents.filter((a) => HONEST_ARCHETYPES.has(a.archetype));
  const honestEvents = honestAgents.reduce((s, a) => s + a.events, 0);
  const honestDetectorFires = honestAgents.reduce((s, a) => s + a.detectorFires, 0);
  const fpRate = honestEvents > 0 ? honestDetectorFires / honestEvents : 0;

  // ---- thresholds ----
  const GATE1 = ece < 0.05; // honest cohort is well-calibrated (reliability diagram near diagonal)
  const GATE2 = honestRank === 1 && honestTopsGaming;
  const GATE3 = catastrophic === 0;
  const GATE4 = fpRate < 0.05;
  const allPass = GATE1 && GATE2 && GATE3 && GATE4;

  // ---- report ----
  const out: string[] = [];
  const log = (s = ''): void => { out.push(s); console.log(s); };

  log(`# RRL Shadow Replay — WS2.3 Stage-0 Exit-Gate Metrics`);
  log('');
  log(`**Generated:** ${new Date().toISOString()}  `);
  log(`**Harness:** \`scripts/rrl/shadow-replay.ts\` · **Scorer:** \`src/rrl/scoring.ts\` (RRLScorer) · **Sink:** \`${sink.path}\`  `);
  log(`**Seed:** ${seed} · **Rounds:** ${rounds} · **Agents/archetype:** ${perArch} · **Total agents:** ${agents.length} · **Ledger rows:** ${ledger.count}  `);
  log(`**Run id:** \`${runId}\`  `);
  log('');
  log(`> ⚠️ **EVENT SOURCE = SYNTHETIC (labeled).** Real HAL/peer-verify signal was probed read-only and is NOT cleanly available (hal_production_events: 5 rows, 0 with a ground-truth outcome). This replay mirrors the sim's agent strategies to exercise the exit-gate machinery end-to-end. NO live RepID was read or written; NO on-chain/ZKP. Shadow ledger only.`);
  log('');

  log(`## Exit-gate results`);
  log('');
  log(`| Gate | Metric | Value | Threshold | Verdict |`);
  log(`|---|---|---:|---|---|`);
  log(`| 1 Calibration | Expected Calibration Error (honest cohort reliability diagram) | ${fmt(ece)} | < 0.05 | ${GATE1 ? '✅' : '❌'} |`);
  log(`| 2 Honesty-order | honest cohort rank / tops all gaming | #${honestRank} / ${honestTopsGaming} | #1 & true | ${GATE2 ? '✅' : '❌'} |`);
  log(`| 3 No divergence | unexplained catastrophic agents | ${catastrophic} | 0 | ${GATE3 ? '✅' : '❌'} |`);
  log(`| 4 Detector FP | detector-fire rate on honest agents | ${fmt(fpRate)} | < 0.05 | ${GATE4 ? '✅' : '❌'} |`);
  log('');
  log(`_Supporting context (not a gate): Pearson(accuracy, unclamped cumΔ) across all archetypes = ${fmt(accVsTrajectory)}. Deliberately NOT gated on — RRL rewards calibration + honesty, so an accurate-but-herding agent correctly earns less, which suppresses a raw accuracy↔reward correlation. The reliability diagram above is the correct calibration statistic._`);
  log('');
  log(`### Honest-cohort reliability diagram (Gate 1 detail)`);
  log('');
  log(`| Conf bin | n | Mean stated conf | Realized accuracy | |gap| |`);
  log(`|---|---:|---:|---:|---:|`);
  honestRelHist.forEach((b, i) => {
    if (b.n === 0) return;
    const lo = (i / N_BINS).toFixed(1), hi = ((i + 1) / N_BINS).toFixed(1);
    const mc = b.confSum / b.n, ma = b.correct / b.n;
    log(`| ${lo}-${hi} | ${b.n} | ${fmt(mc)} | ${fmt(ma)} | ${fmt(Math.abs(mc - ma))} |`);
  });
  log('');
  log(`### VERDICT (synthetic exercise): ${allPass ? '✅ all four exit-gate metrics computable and passing on the synthetic stream' : '⚠️ one or more gates did not pass — see rows above'}`);
  log('');
  log(`_Note: passing on SYNTHETIC data proves the exit-gate machinery is wired and discriminating; it is NOT the WS2.3 promotion evidence. Promotion requires the same gates to hold on REAL traffic (Stage-0.5) plus human co-sign (A6)._`);
  log('');

  log(`## Cohort reputation ordering (shadow cumΔ)`);
  log('');
  log(`| Rank | Archetype | Mean cumΔ | Mean would-be RepID | Mean accuracy | Mean coverage |`);
  log(`|---:|---|---:|---:|---:|---:|`);
  cohortRanking.forEach((arch, i) => {
    const arr = byArch.get(arch)!;
    const md = arr.reduce((s, a) => s + a.scorer.cumDelta, 0) / arr.length;
    const mr = arr.reduce((s, a) => s + a.scorer.wouldBeRepid, 0) / arr.length;
    const ma = arr.reduce((s, a) => s + a.scorer.realizedAccuracy, 0) / arr.length;
    const mc = arr.reduce((s, a) => s + a.scorer.coverage, 0) / arr.length;
    const star = arch === 'honest-calibrated' ? ' **←honest**' : '';
    log(`| ${i + 1} | ${arch}${star} | ${fmt(md, 1)} | ${fmt(mr, 0)} | ${fmt(ma)} | ${fmt(mc)} |`);
  });
  log('');
  log(`## Divergence detail (Gate 3)`);
  log('');
  log(`Baseline live RepID (synthetic) = ${LIVE_BASELINE_REPID}. "Explained" = shadow direction matches ground-truthed accuracy, or agent is a known gaming archetype.`);
  log('');
  log(`| Agent | Archetype | Would-be RepID | Accuracy | Explained |`);
  log(`|---|---|---:|---:|---|`);
  for (const d of divergences) log(`| ${d.id} | ${d.arch} | ${fmt(d.repid, 0)} | ${fmt(d.acc)} | ${d.explained ? 'yes' : '🔴 NO'} |`);
  log('');
  log(`## Reproducibility`);
  log('```');
  log(`npx tsx scripts/rrl/shadow-replay.ts --seed ${seed} --rounds ${rounds} --agents ${perArch}`);
  log('```');
  log(`Deterministic (Mulberry32, same seed → same ledger). Scorer = the same locked core the sim uses.`);

  const reportDir = path.join(process.cwd(), 'reports', '2026-07-18');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'RRL_SHADOW_REPLAY_RESULTS.md');
  fs.writeFileSync(reportPath, out.join('\n'), 'utf8');
  console.log(`\n[written] ${reportPath}`);
  console.log(`[written] ${sink.path} (${ledger.count} rows)`);
}

// ============================================================================
// REAL-LABELS MODE — feed the RRL shadow scorer on REAL HAL labeled outcomes.
// ----------------------------------------------------------------------------
// Source stream = reports/2026-07-18/hal-outcomes.jsonl (produced by scripts/hal/label-run.ts:
// the decontaminated corpus scored by the real 5-strong factCheck quorum, graded vs known
// TRUE/FALSE labels). Mapping (documented, honest):
//   - AGENT = each provider/family in the quorum (real, distinct scorers). The quorum-level
//     outcome is expanded via meta.provider_verdicts into one RRLResponseEvent per provider.
//   - round = claim index in the labeled stream.
//   - correct = the provider's own verdict vs the ground-truth label (1/0).
//   - abstain = provider verdict UNCERTAIN or ERROR (no committed answer).
//   - confidence = provider-reported confidence (0..1).
//   - disclosed = committed answer at confidence < discloseThreshold (flagged uncertainty).
//   - difficulty = corpus difficulty mapped to [0,1]; errorClass = domain hash (M1 recurrence).
//   - scheduleRepair / concealed / manufactured = FALSE. The labeled corpus is SINGLE-SHOT, so
//     repair (M1), concealment-surfacing, and error-farming (M6) have NO signal in real data.
//     This is itself a finding (see report). M8 escrow + M4 lazy/coverage still exercise.
// Every ledger row is labeled event_source='hal' + real-derived. NO live RepID / on-chain / ZKP.
// ============================================================================

interface ProviderVerdictMeta {
  provider: string;
  family?: string;
  verdict: string; // TRUE | FALSE | UNCERTAIN | ERROR
  confidence: number; // 0..1
  correct: 0 | 1 | null;
  error?: string | null;
}
interface OutcomeRow {
  claim_hash: string;
  hal_decision: string;
  ground_truth: string;
  correct: boolean | null;
  source_of_truth: string;
  meta?: {
    difficulty?: string;
    domain?: string;
    provider_verdicts?: ProviderVerdictMeta[];
  };
}

function difficultyToScalar(d: string | undefined, P: RRLParams): number {
  switch ((d ?? '').toLowerCase()) {
    case 'hard':
      return 0.7;
    case 'medium':
      return 0.4;
    case 'grounded-faithfulness':
      return 0.4;
    case 'easy':
      return 0.2;
    default:
      return P.baseDifficulty;
  }
}
function domainToErrorClass(domain: string | undefined): number {
  const s = domain ?? 'unknown';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 64; // bounded class space for M1 recurrence
}

function runReal(): void {
  const argv = process.argv.slice(2);
  const labelsPath = path.resolve(getArgFrom(argv, '--labels', path.join('reports', '2026-07-18', 'hal-outcomes.jsonl')));
  if (!fs.existsSync(labelsPath)) {
    console.error(`[shadow-replay:real] FATAL: labeled outcomes not found at ${labelsPath}. Run scripts/hal/label-run.ts first.`);
    process.exit(2);
  }
  const rows: OutcomeRow[] = fs
    .readFileSync(labelsPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OutcomeRow);

  const P = defaultRRLParams();
  const mech = allMechanismsOn();
  const runId = `shadow-replay-REAL-${new Date().toISOString().slice(0, 10)}`;

  // ---- WS2.3 calibration-correction toggle (default OFF) ----
  // With --calibrate we fit a per-provider reliability curve from the stream's own committed
  // (confidence, correct) pairs and (a) recalibrate the Gate-1 reliability diagram + Brier term,
  // (b) report the HONEST out-of-sample (K-fold) ECE, not the circular in-sample one. See
  // src/rrl/calibration.ts + reports/2026-07-18/RRL_CALIBRATION_DESIGN.md.
  const calibrateOn = argv.includes('--calibrate');
  const calCfg = defaultCalibrationConfig();
  const providerPairs = new Map<string, ConfCorrectPair[]>();
  if (calibrateOn) {
    for (const row of rows) {
      if (row.ground_truth !== 'TRUE' && row.ground_truth !== 'FALSE') continue;
      for (const pv of row.meta?.provider_verdicts ?? []) {
        if (pv.verdict !== 'TRUE' && pv.verdict !== 'FALSE') continue;
        const arr = providerPairs.get(pv.provider) ?? [];
        arr.push({ confidence: clamp(pv.confidence, 0, 1), correct: (pv.correct === 1 ? 1 : 0) as 0 | 1 });
        providerPairs.set(pv.provider, arr);
      }
    }
  }
  const curves = new Map<string, ReliabilityCurve>();
  const calibrators = new Map<string, (c: number) => number>();
  if (calibrateOn) {
    for (const [prov, pairs] of providerPairs) {
      const curve = fitReliabilityCurve(prov, pairs, calCfg);
      curves.set(prov, curve);
      calibrators.set(prov, makeCalibrator(curve));
    }
  }

  // One scorer per provider (agent). Discover providers from the stream. `committed` counts
  // events where the provider actually answered (not ERROR/UNCERTAIN) — a provider with 0
  // committed answers is INFRA-DEAD (e.g. a stale API key), not a gaming agent; we surface it
  // separately so a dead key can't masquerade as a detector false-positive.
  const scorers = new Map<string, { scorer: RRLScorer; family: string; events: number; detectorFires: number; committed: number }>();
  const ensure = (provider: string, family: string) => {
    let s = scorers.get(provider);
    if (!s) {
      s = { scorer: new RRLScorer(provider, P, mech, calibrateOn ? calibrators.get(provider) : undefined), family, events: 0, detectorFires: 0, committed: 0 };
      scorers.set(provider, s);
    }
    return s;
  };

  const ledgerPath = path.join(process.cwd(), 'reports', '2026-07-18', 'rrl-shadow-ledger-real.jsonl');
  const sink = new JsonlShadowSink(ledgerPath);
  sink.truncate();
  const ledger = new ShadowLedger(sink, { forceArmed: true });

  // Reliability diagram across ALL real committed provider answers (all providers presumed honest).
  const relHist = newRelHist(); // RAW confidences (the provider-honesty diagnostic)
  const calRelHist = newRelHist(); // RECALIBRATED confidences (in-sample; optimistic — see report)
  let scoredRows = 0;

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t]!;
    const pvs = row.meta?.provider_verdicts ?? [];
    if (row.ground_truth !== 'TRUE' && row.ground_truth !== 'FALSE') continue; // only scored labels drive RRL
    scoredRows++;
    const difficulty = difficultyToScalar(row.meta?.difficulty, P);
    const errorClass = domainToErrorClass(row.meta?.domain);

    // phase A — observe each provider's verdict as one RRL event
    for (const pv of pvs) {
      const s = ensure(pv.provider, pv.family ?? pv.provider);
      const committed = pv.verdict === 'TRUE' || pv.verdict === 'FALSE';
      const abstain = !committed; // UNCERTAIN or ERROR => no committed answer
      const confidence = clamp(pv.confidence, 0.02, 0.985);
      const ev: RRLResponseEvent = {
        agentId: pv.provider,
        round: t,
        abstain,
        confidence,
        correct: (pv.correct === 1 ? 1 : 0) as 0 | 1,
        disclosed: committed && confidence < P.discloseThreshold,
        difficulty,
        errorClass,
      };
      const obs = s.scorer.observe(ev);
      s.events++;
      if (committed) s.committed++;
      if (obs.detectorFired) s.detectorFires++;
      if (committed) {
        const bin = relHist[relBinIndex(confidence)]!;
        bin.confSum += confidence;
        bin.correct += ev.correct;
        bin.n += 1;
        if (calibrateOn) {
          const cc = clamp(applyCalibration(curves.get(pv.provider)!, confidence), 0, 1);
          const cbin = calRelHist[relBinIndex(cc)]!;
          cbin.confSum += cc;
          cbin.correct += ev.correct;
          cbin.n += 1;
        }
      }
      ledger.record({
        ts: new Date().toISOString(),
        agent_id: pv.provider,
        event_id: `${runId}:obs:${pv.provider}:${t}`,
        event_source: 'hal',
        round: t,
        computed_delta: obs.immediateDelta,
        mechanisms_fired: obs.mechanismsFired,
        detector_fired: obs.detectorFired,
        would_be_repid: s.scorer.wouldBeRepid,
        live_repid: LIVE_BASELINE_REPID,
        note: `real:${pv.family ?? pv.provider}:observe:${abstain ? 'abstain' : pv.verdict}`,
      });
    }

    // phase B — settle deferred (M8 escrow maturation; no repair/conceal in single-shot data)
    for (const [provider, s] of scorers) {
      const st = s.scorer.settle(t);
      if (st.delta !== 0 || st.mechanismsFired.length) {
        ledger.record({
          ts: new Date().toISOString(),
          agent_id: provider,
          event_id: `${runId}:settle:${provider}:${t}`,
          event_source: 'hal',
          round: t,
          computed_delta: st.delta,
          mechanisms_fired: st.mechanismsFired,
          detector_fired: st.detectorFired,
          would_be_repid: s.scorer.wouldBeRepid,
          live_repid: LIVE_BASELINE_REPID,
          note: `real:${s.family}:settle`,
        });
      }
    }
  }
  // flush trailing escrow
  for (let extra = rows.length; extra < rows.length + P.escrowMatureLag + 2; extra++) {
    for (const [, s] of scorers) s.scorer.settle(extra);
  }
  ledger.close();

  // ---- gate metrics, RE-INTERPRETED for real single-cohort data ----
  const provs = [...scorers.entries()].map(([name, s]) => ({
    name,
    family: s.family,
    cumDelta: s.scorer.cumDelta,
    repid: s.scorer.wouldBeRepid,
    acc: s.scorer.realizedAccuracy,
    coverage: s.scorer.coverage,
    events: s.events,
    detectorFires: s.detectorFires,
    committed: s.committed,
    dead: s.committed === 0, // infra-dead (e.g. stale key) — never answered; not a gaming agent
  }));
  provs.sort((a, b) => b.cumDelta - a.cumDelta);
  const livingProvs = provs.filter((p) => !p.dead);
  const deadProvs = provs.filter((p) => p.dead);

  // Gate 1 — calibration (reliability diagram over all real committed answers).
  const eceRaw = expectedCalibrationError(relHist);
  // Aggregate OUT-OF-SAMPLE recalibrated ECE (deterministic K-fold by index residue). This is
  // the HONEST calibration number when --calibrate is on: fit on K−1 folds, apply to the held-out
  // fold, pool across providers, then ECE. In-sample recal ECE (calRelHist) is circular (isotonic
  // drives it to ~0 by construction) and is reported ONLY as an optimistic bound, never the gate.
  const aggregateOosEce = (k: number, cfg: CalibrationConfig): number => {
    const hist = newRelHist();
    for (const [, pairs] of providerPairs) {
      if (pairs.length < k) {
        for (const p of pairs) { const b = hist[relBinIndex(p.confidence)]!; b.confSum += p.confidence; b.correct += p.correct; b.n++; }
        continue;
      }
      for (let f = 0; f < k; f++) {
        const train = pairs.filter((_, i) => i % k !== f);
        const test = pairs.filter((_, i) => i % k === f);
        const curve = fitReliabilityCurve('kfold', train, cfg);
        for (const p of test) {
          const cc = clamp(applyCalibration(curve, p.confidence), 0, 1);
          const b = hist[relBinIndex(cc)]!;
          b.confSum += cc; b.correct += p.correct; b.n++;
        }
      }
    }
    return expectedCalibrationError(hist);
  };
  const eceCalInSample = calibrateOn ? expectedCalibrationError(calRelHist) : NaN;
  const eceOos5 = calibrateOn ? aggregateOosEce(5, calCfg) : NaN;
  const eceOos10 = calibrateOn ? aggregateOosEce(10, calCfg) : NaN;
  // Gate verdict uses RAW ECE when calibration is off, and the HONEST out-of-sample (5-fold)
  // recalibrated ECE when it is on.
  const ece = calibrateOn ? eceOos5 : eceRaw;
  const GATE1 = ece < 0.05;

  // Gate 2 — RE-INTERPRETED. There is NO gaming cohort in real provider data, so the synthetic
  // "honest tops gaming" gate is NOT EVALUABLE. The real-data analog: does RRL reward reliability?
  // i.e. provider cumΔ ordering should track realized-accuracy ordering (Pearson > 0) AND the
  // single most-accurate provider should be the top-ranked by cumΔ.
  // Computed over LIVING providers (a dead/never-answered provider has acc 0 and would distort
  // both the correlation and the "most accurate" pick).
  const accByCum = pearson(livingProvs.map((p) => p.acc), livingProvs.map((p) => p.cumDelta));
  const mostAccurate = [...livingProvs].sort((a, b) => b.acc - a.acc)[0];
  const topByCum = livingProvs[0];
  const rewardsReliability = accByCum > 0 && !!mostAccurate && !!topByCum && mostAccurate.name === topByCum.name;
  const GATE2 = rewardsReliability; // re-interpreted; see note in report

  // Gate 3 — no catastrophic UNEXPLAINED divergence (acc>=0.6 must not be nuked below baseline).
  let catastrophic = 0;
  for (const p of provs) {
    const wentDown = p.repid < LIVE_BASELINE_REPID;
    const explained = p.acc >= 0.6 ? p.repid >= LIVE_BASELINE_REPID : wentDown || p.repid >= LIVE_BASELINE_REPID;
    if (!explained) catastrophic++;
  }
  const GATE3 = catastrophic === 0;

  // Gate 4 — detector FP rate on (honest, non-gaming) providers. Reported TWO ways: RAW (all
  // providers, incl. infra-dead) and LIVE (excluding providers that never answered). A dead
  // provider trips the M4 coverage-floor detector every round — a real FP *source*, but one
  // caused by a stale key, not by gaming. Both are shown; the gate verdict uses RAW (no massaging).
  const totalEventsAll = provs.reduce((s, p) => s + p.events, 0);
  const totalDetectorAll = provs.reduce((s, p) => s + p.detectorFires, 0);
  const fpRateAll = totalEventsAll > 0 ? totalDetectorAll / totalEventsAll : 0;
  const totalEventsLive = livingProvs.reduce((s, p) => s + p.events, 0);
  const totalDetectorLive = livingProvs.reduce((s, p) => s + p.detectorFires, 0);
  const fpRateLive = totalEventsLive > 0 ? totalDetectorLive / totalEventsLive : 0;
  const fpRate = fpRateAll; // gate verdict on the raw number
  const GATE4 = fpRate < 0.05;

  const allPass = GATE1 && GATE2 && GATE3 && GATE4;

  // ---- report ----
  const out: string[] = [];
  const log = (s = ''): void => { out.push(s); console.log(s); };
  log(`# RRL Shadow Replay — WS2.3 on REAL LABELED HAL OUTCOMES`);
  log('');
  log(`**Generated:** ${new Date().toISOString()}  `);
  log(`**Event source:** \`${labelsPath}\` (REAL — 5-strong factCheck quorum × decontaminated corpus, graded vs known labels)  `);
  log(`**Scorer:** \`src/rrl/scoring.ts\` (RRLScorer, LOCKED WS2.2 core) · **Sink:** \`${sink.path}\`  `);
  log(`**Labeled rows:** ${rows.length} · **Scored rows (TRUE/FALSE gt):** ${scoredRows} · **Provider-agents:** ${provs.length} · **Ledger rows:** ${ledger.count}  `);
  log('');
  log(`> **REAL-DERIVED**, not synthetic. Each provider/family in the quorum is a real RRL agent; every event is a real graded verdict. NO live RepID read/written; NO on-chain/ZKP. Shadow ledger only.`);
  log(`> **Single-shot corpus caveat:** the labeled corpus is one verdict per claim, so repair (M1), concealment-surfacing, and error-farming (M6) have NO signal here — those mechanisms are UNEXERCISED by real data. M8 escrow + M4 lazy/coverage + calibration + M9 credential + M5/M2 cross-agent do exercise.`);
  log('');
  log(`## Exit-gate results (RE-INTERPRETED for a single honest cohort)`);
  log('');
  log(`| Gate | Metric (real-data reading) | Value | Threshold | Verdict |`);
  log(`|---|---|---:|---|---|`);
  if (calibrateOn) {
    log(`| 1 Calibration (raw) | ECE on RAW self-reported confidence — provider-honesty diagnostic (NOT the gate) | ${fmt(eceRaw)} | (context) | ${eceRaw < 0.05 ? '✅' : '⚠️'} |`);
    log(`| 1 Calibration (OOS) | **ECE on RECALIBRATED signal, 5-fold OUT-OF-SAMPLE** — the honest gate | ${fmt(eceOos5)} | < 0.05 | ${GATE1 ? '✅' : '❌'} |`);
  } else {
    log(`| 1 Calibration | ECE over all real committed provider answers (RAW) | ${fmt(eceRaw)} | < 0.05 | ${GATE1 ? '✅' : '❌'} |`);
  }
  log(`| 2 Rewards-reliability* | Pearson(acc, cumΔ) & most-accurate = top-ranked | ${fmt(accByCum)} / ${rewardsReliability} | >0 & true | ${GATE2 ? '✅' : '❌'} |`);
  log(`| 3 No divergence | providers nuked below baseline despite acc≥0.6 | ${catastrophic} | 0 | ${GATE3 ? '✅' : '❌'} |`);
  log(`| 4 Detector FP (raw) | detector-fire rate, ALL providers | ${fmt(fpRateAll)} | < 0.05 | ${GATE4 ? '✅' : '❌'} |`);
  log(`| 4b Detector FP (live) | detector-fire rate, excl. infra-dead providers | ${fmt(fpRateLive)} | < 0.05 | ${fpRateLive < 0.05 ? '✅' : '❌'} |`);
  log('');
  log(`*Gate 2 is RE-INTERPRETED: the synthetic gate ("honest cohort tops gaming cohorts") is **NOT EVALUABLE** on real data — there are no gaming archetypes among real providers. The honest real-data analog is "does RRL reward the more reliable providers?" (Pearson over LIVING providers, most-accurate = top-ranked). Treat a fail here as a signal about provider calibration/agreement, not proof of gaming.`);
  log('');
  if (deadProvs.length) {
    log(`⚠️ **Infra-dead providers (0 committed answers — a stale key or dead endpoint, NOT gaming):** ${deadProvs.map((p) => `${p.name}(${p.family})`).join(', ')}. Each trips the M4 coverage-floor detector every round, which is why Gate-4 RAW > Gate-4 LIVE. This is a real FP *source* to be aware of, but its cause is infrastructure, not the RRL rule mis-firing on an honest working agent. Gate 4b excludes them.`);
    log('');
  }
  log(`### VERDICT (real labeled outcomes): ${allPass ? '✅ all four (re-interpreted) gates pass on REAL data' : '⚠️ one or more gates did NOT pass on real data — see the honest finding below'}`);
  log('');
  log(`### Honest reliability diagram (Gate 1 detail — all real committed provider answers)`);
  log('');
  log(`| Conf bin | n | Mean stated conf | Realized accuracy | |gap| |`);
  log(`|---|---:|---:|---:|---:|`);
  relHist.forEach((b, i) => {
    if (b.n === 0) return;
    const lo = (i / N_BINS).toFixed(1), hi = ((i + 1) / N_BINS).toFixed(1);
    const mc = b.confSum / b.n, ma = b.correct / b.n;
    log(`| ${lo}-${hi} | ${b.n} | ${fmt(mc)} | ${fmt(ma)} | ${fmt(Math.abs(mc - ma))} |`);
  });
  log('');
  if (calibrateOn) {
    log(`### Calibration-correction detail (WS2.3 \`--calibrate\`)`);
    log('');
    log(`Per-provider reliability curves fit from each provider's OWN committed (confidence, correct) pairs (binned + shrinkage-K=${calCfg.shrinkageK} toward the provider prior, isotonic-monotone; identity map below n=${calCfg.minSamples}).`);
    log('');
    log(`| Provider | Family | n | Raw ECE | 5-fold OOS ECE | Prior acc | Fit |`);
    log(`|---|---|---:|---:|---:|---:|---|`);
    const provEces: { name: string; ece: number }[] = [];
    for (const [prov, pairs] of providerPairs) {
      const curve = curves.get(prov)!;
      const oos = kFoldEce(pairs, 5, calCfg);
      provEces.push({ name: prov, ece: curve.eceRaw });
      log(`| ${prov} | ${curve.provider === prov ? (scorers.get(prov)?.family ?? '') : ''} | ${pairs.length} | ${fmt(curve.eceRaw)} | ${fmt(oos)} | ${fmt(curve.prior)} | ${curve.identity ? 'identity (n<min)' : 'fitted'} |`);
    }
    log('');
    log(`**In-sample recal ECE (optimistic bound, NOT the gate):** ${fmt(eceCalInSample)} · **5-fold OOS:** ${fmt(eceOos5)} · **10-fold OOS:** ${fmt(eceOos10)} · **raw:** ${fmt(eceRaw)}.`);
    log('');
    log(`**Incentive preserved (Option B — relative-calibration credential).** Recalibration de-biases the SIGNAL but does not flatten the reward gradient: scoring the raw per-provider ECEs relative to the panel median still ranks providers, so the honest reporter is still rewarded.`);
    log('');
    log(`| Provider | Raw ECE | Relative-calibration credential (×, [0.4,1]) |`);
    log(`|---|---:|---:|`);
    const eces = provEces.map((p) => p.ece);
    [...provEces].sort((a, b) => a.ece - b.ece).forEach((p) => {
      const peers = eces.filter((_, i) => provEces[i]!.name !== p.name);
      log(`| ${p.name} | ${fmt(p.ece)} | ${fmt(relativeCalibrationCredential(p.ece, peers))} |`);
    });
    log('');
  }
  log(`## Provider-agent reputation ordering (shadow cumΔ on REAL labels)`);
  log('');
  log(`| Rank | Provider | Family | cumΔ | Would-be RepID | Realized acc | Coverage | Committed | Events | Detector fires | Status |`);
  log(`|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|`);
  provs.forEach((p, i) => {
    log(`| ${i + 1} | ${p.name} | ${p.family} | ${fmt(p.cumDelta, 1)} | ${fmt(p.repid, 0)} | ${fmt(p.acc)} | ${fmt(p.coverage)} | ${p.committed} | ${p.events} | ${p.detectorFires} | ${p.dead ? '🔴 infra-dead' : 'live'} |`);
  });
  log('');
  log(`## Reproducibility`);
  log('```');
  log(`npx tsx scripts/hal/label-run.ts            # produce the real labeled outcomes`);
  log(`npx tsx scripts/rrl/shadow-replay.ts --mode real --labels ${path.relative(process.cwd(), labelsPath)}              # calibration OFF (raw ECE)`);
  log(`npx tsx scripts/rrl/shadow-replay.ts --mode real --calibrate --labels ${path.relative(process.cwd(), labelsPath)}  # calibration ON (out-of-sample recalibrated ECE)`);
  log('```');

  const reportDir = path.join(process.cwd(), 'reports', '2026-07-18');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, calibrateOn ? 'RRL_SHADOW_REPLAY_REAL_CALIBRATED.md' : 'RRL_SHADOW_REPLAY_REAL_RESULTS.md');
  fs.writeFileSync(reportPath, out.join('\n'), 'utf8');
  console.log(`\n[written] ${reportPath}`);
  console.log(`[written] ${sink.path} (${ledger.count} rows)`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = getArgFrom(argv, '--mode', 'synthetic');
  if (mode === 'real') runReal();
  else runSynthetic();
}

main();
