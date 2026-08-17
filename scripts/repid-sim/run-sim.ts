/**
 * RepID INCENTIVE SIMULATION — does honest behaviour win?
 *
 * Runs the strategy tournament in src/incentives/strategy-sim.ts against the REAL scoring path
 * (computeDelta + clampRepid), and prints the reachable reward curve alongside it.
 *
 * MEASURE-ONLY: no database, no network, no writes. Deterministic from --seed.
 *
 * Run:
 *   npm run repid:sim
 * Env:
 *   SIM_ROUNDS=200   rounds per strategy (default 200)
 *   SIM_SEED=12345   PRNG seed (default 12345)
 *   SIM_JSON=1       also emit machine-readable JSON (for the chart)
 *
 * READ THE ASSUMPTIONS in src/incentives/strategy-sim.ts before quoting any number from this.
 * pCatch (detector accuracy) and pQuorum (quorum availability) are MODELLED and swept, because HAL
 * strictness 2 needs live provider keys. Everything about the payoff arithmetic is real.
 */
import {
  runTournament,
  sweep,
  honestyWins,
  measureArbitrage,
  STRATEGIES,
  SimParams,
  SYSTEM_FLAG_THRESHOLD,
  ARBITRAGE_OPTIMUM,
} from '../../src/incentives/strategy-sim';
import {
  sampleCurve,
  cleanExtrema,
  monotonicityViolations,
  rewardMaximisingRisk,
} from '../../src/incentives/reward-curve';
import { STARTING_REPID } from '../../src/scoring/repid-constants';

const ROUNDS = Number(process.env.SIM_ROUNDS ?? '200');
const SEED = Number(process.env.SIM_SEED ?? '12345');

const P_CATCH = [0, 0.25, 0.5, 0.75, 1.0];
const P_QUORUM = [1.0, 0.2];

function line(n = 104) {
  console.log('='.repeat(n));
}

function reportCurve(): void {
  console.log('');
  console.log('PART 1 — THE REACHABLE REWARD CURVE (real deriveHalDecision + real computeDelta)');
  line();
  console.log('hal_score is hallucination RISK: LOWER IS BETTER quality.');
  console.log('');
  console.log('  risk   decision   delta_applied');
  for (const p of sampleCurve(21)) {
    console.log(
      `  ${p.risk.toFixed(2).padStart(4)}   ${p.decision.padEnd(9)}  ${p.delta_applied
        .toFixed(2)
        .padStart(6)}`,
    );
  }

  const { best, worst, inverted } = cleanExtrema();
  const violations = monotonicityViolations(401);
  const maxima = rewardMaximisingRisk();

  console.log('');
  console.log(`  best-paid clean event : risk ${best.risk.toFixed(3)} pays ${best.delta_applied.toFixed(2)}`);
  console.log(`  worst-paid clean event: risk ${worst.risk.toFixed(3)} pays ${worst.delta_applied.toFixed(2)}`);
  // Describe where the maximum actually IS rather than asserting where it was: this line used to
  // hardcode "just under the 0.40 flag boundary", which silently became false the moment the
  // orientation was corrected.
  const atBoundary = maxima.risk > 0.3;
  console.log(
    `  reward-maximising risk: ${maxima.risk.toFixed(3)} ` +
      (atBoundary
        ? '(just under the 0.40 flag boundary — reward rises with risk)'
        : '(best-grounded end of the branch — reward falls with risk)'),
  );
  console.log(`  monotonicity violations over the clean branch: ${violations.length}`);
  console.log(
    `  VERDICT: reward ${inverted ? 'INCREASES with risk — quality is PENALISED' : 'decreases with risk (correct)'}`,
  );
  const breakEven = Math.ceil(10 / best.delta_applied);
  console.log(`  farming exchange rate: ${breakEven} best-case clean events to repay one veto (-10)`);
}

function reportTournament(): void {
  console.log('');
  console.log('');
  console.log(`PART 2 — STRATEGY TOURNAMENT (${ROUNDS} rounds, seed ${SEED}, start ${STARTING_REPID})`);
  line();
  console.log('Perfect detector and always-available quorum: pCatch=1.0, pQuorum=1.0');
  console.log('');

  const params: SimParams = { rounds: ROUNDS, pCatch: 1.0, pQuorum: 1.0, seed: SEED };
  const results = runTournament(params);

  console.log(
    '  rank  strategy'.padEnd(30) +
      'final'.padStart(8) +
      'net'.padStart(9) +
      'claims'.padStart(8) +
      'per-claim'.padStart(11) +
      'vetoes'.padStart(8),
  );
  console.log('  ' + '-'.repeat(100));
  for (const r of results) {
    console.log(
      `  ${String(r.rank).padStart(2)}    ${r.strategyId.padEnd(22)}` +
        r.finalRepid.toFixed(0).padStart(8) +
        (r.netChange >= 0 ? '+' : '') +
        r.netChange.toFixed(1).padStart(8) +
        String(r.claims).padStart(8) +
        r.perClaim.toFixed(4).padStart(11) +
        String(r.vetoes).padStart(8),
    );
  }
  console.log('');
  console.log(`  honesty wins? ${honestyWins(results) ? 'YES' : 'NO'}`);
  console.log(`  winner: ${results[0]!.strategyId}`);

  console.log('');
  console.log('  strategies:');
  for (const s of STRATEGIES) {
    console.log(`    ${s.id.padEnd(18)} ${s.description}`);
  }
}

function reportSweep(): SweepRowsOut {
  console.log('');
  console.log('');
  console.log('PART 3 — SWEEP: how good must the detector be before honesty pays?');
  line();
  console.log('pCatch  = P(quorum catches a fabrication).  pQuorum = P(a quorum exists at all).');
  console.log('');
  const rows = sweep(P_CATCH, P_QUORUM, { rounds: ROUNDS, seed: SEED });
  console.log(
    '  pQuorum  pCatch  honesty?  winner'.padEnd(52) +
      'honest-net'.padStart(12) +
      'gamer-net'.padStart(11) +
      'fabricator-net'.padStart(16),
  );
  console.log('  ' + '-'.repeat(100));
  for (const r of rows) {
    console.log(
      `  ${r.pQuorum.toFixed(1).padStart(6)}  ${r.pCatch.toFixed(2).padStart(6)}  ` +
        `${(r.honestyWins ? 'YES' : 'NO').padEnd(8)}  ${r.bestStrategy.padEnd(22)}` +
        (r.honestExpertNet >= 0 ? '+' : '') + r.honestExpertNet.toFixed(1).padStart(11) +
        (r.thresholdGamerNet >= 0 ? '+' : '') + r.thresholdGamerNet.toFixed(1).padStart(10) +
        (r.fabricatorNet >= 0 ? '+' : '') + r.fabricatorNet.toFixed(1).padStart(15),
    );
  }

  const anyHonestyWin = rows.some((r) => r.honestyWins);
  console.log('');
  console.log(
    `  Does ANY detector accuracy make honesty the best play? ${anyHonestyWin ? 'YES' : 'NO — not at any swept value'}`,
  );
  return rows;
}

function reportArbitrage(): void {
  console.log('');
  console.log('');
  console.log('PART 4 — PREFERENCE ARBITRAGE: is a user-settable risk tolerance a gaming vector?');
  line();
  console.log('broad-default and broad-shopper are the SAME agent: identical risk band, identical');
  console.log('volume, identical truthfulness. They differ in ONE bit — the flag threshold the user');
  console.log(`was allowed to set (${SYSTEM_FLAG_THRESHOLD} default vs ${ARBITRAGE_OPTIMUM} shopped).`);
  console.log('So the gap between them is the value of the KNOB with behaviour held fixed.');
  console.log('');

  const results = runTournament({ rounds: ROUNDS, pCatch: 1.0, pQuorum: 1.0, seed: SEED });
  const a = measureArbitrage(results);

  console.log(`  broad-default  (threshold ${SYSTEM_FLAG_THRESHOLD})  net ${a.defaultNet >= 0 ? '+' : ''}${a.defaultNet.toFixed(1)}`);
  console.log(`  broad-shopper  (threshold ${ARBITRAGE_OPTIMUM})  net ${a.shopperNet >= 0 ? '+' : ''}${a.shopperNet.toFixed(1)}`);
  console.log(
    `  => value of the knob, behaviour unchanged: ${a.gain >= 0 ? '+' : ''}${a.gain.toFixed(1)} RepID ` +
      `(${(a.gainRatio * 100).toFixed(0)}% of the honest twin's gain)`,
  );
  console.log('');
  console.log(`  EXPLOITABLE? ${a.exploitable ? 'YES — a setting change pays, with no better work' : 'NO'}`);
  console.log('');
  console.log('  And the other direction — does CAUTION cost the user? Same agent, stricter setting:');
  console.log(`    broad-cautious (threshold 0.25)  net ${a.cautiousNet >= 0 ? '+' : ''}${a.cautiousNet.toFixed(1)}`);
  console.log(`    broad-default  (threshold ${SYSTEM_FLAG_THRESHOLD})   net ${a.defaultNet >= 0 ? '+' : ''}${a.defaultNet.toFixed(1)}`);
  console.log(
    `    => cost of caution: ${a.cautiousCost >= 0 ? '+' : ''}${a.cautiousCost.toFixed(1)} RepID  ` +
      `(penalised? ${a.cautiousPenalised ? 'YES' : 'NO'})`,
  );
  console.log('');
  console.log('  So the knob is monotone in permissiveness: strict < default < permissive, on identical');
  console.log('  work. A user is paid for their SETTING, which is the finding.');
  console.log('');
  console.log('  Note the ceiling: the corrected curve is delta = 3 - 4*risk, which crosses zero at');
  console.log(`  ${ARBITRAGE_OPTIMUM}. Shopping a threshold ABOVE that converts zero-paying flagged events into`);
  console.log('  NEGATIVE-paying clean ones, so a rational shopper stops exactly there. The arbitrage is');
  console.log('  bounded by the reward curve itself, not by any guard.');
}

type SweepRowsOut = ReturnType<typeof sweep>;

function main(): void {
  console.log('');
  console.log('RepID INCENTIVE SIMULATION');
  line();
  console.log('REAL: computeDelta, deriveHalDecision, clampRepid, STARTING_REPID.');
  console.log('MODELLED + SWEPT: detector accuracy (pCatch), quorum availability (pQuorum),');
  console.log('  and the risk band each strategy attracts. HAL strictness 2 needs provider keys.');
  console.log('NOT MODELLED: decay over calendar time, ecosystem-need multiplier, the');
  console.log('  validator/challenger reward path, staking, collusion. Each is a separate measurement.');

  reportCurve();
  reportTournament();
  const rows = reportSweep();
  reportArbitrage();

  console.log('');
  line();
  console.log('');

  if (process.env.SIM_JSON === '1') {
    console.log(
      JSON.stringify(
        {
          meta: { rounds: ROUNDS, seed: SEED, startingRepid: STARTING_REPID },
          curve: sampleCurve(101),
          extrema: cleanExtrema(),
          violations: monotonicityViolations(401).length,
          tournament: runTournament({ rounds: ROUNDS, pCatch: 1.0, pQuorum: 1.0, seed: SEED }),
          sweep: rows,
          arbitrage: measureArbitrage(runTournament({ rounds: ROUNDS, pCatch: 1.0, pQuorum: 1.0, seed: SEED })),
        },
        null,
        2,
      ),
    );
  }
}

main();
