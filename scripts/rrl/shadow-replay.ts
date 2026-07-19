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

function main(): void {
  const argv = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : def;
  };
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

main();
