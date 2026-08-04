#!/usr/bin/env npx ts-node
/**
 * measure-golden-math.ts — measure HAL on the frozen golden-math set, WITH its ruler.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * `tests/hal/golden-math.test.ts` is a TRIPWIRE: it answers "did anything break?" with
 * a pass or a fail. On 2026-08-04, once the retired `gemini-2.0-flash` default was
 * fixed and the quorum widened back to a real width, it started failing on QUALITY
 * rather than on fleet degradation — 1 missed veto and 2 false positives.
 *
 * A tripwire is the wrong instrument for "how big is the gap". It tells you a bound was
 * crossed, not by how much, on what population, at what configuration. Answering that
 * without a ruler is how HAL's F1 came to be quoted at 0.34, 0.74, 0.886 and 0.890 —
 * four numbers, four different rulers, no possible trend (CLAUDE_RULES 24).
 *
 * So this reuses the machinery PR #327 built rather than growing a second one:
 *   - `buildCorpusManifest` / `computeCorpusHash` — the population, content-addressed
 *   - `recordMeasurement`                          — refuses a metric with no ruler
 *   - `assessRunIntegrity`                         — refuses a metric taken under a fault
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT WILL NOT DO
 * ════════════════════════════════════════════════════════════════════════════════
 * It will not emit a number when a provider failed. An environment fault and a quality
 * regression are different findings, and conflating them is the specific mistake that
 * sent someone chasing a scoring bug that did not exist. If the fleet is degraded this
 * exits non-zero saying so, and prints no F1 at all.
 *
 * It also does not write anywhere. A measurement that mutates the thing it measures is
 * not a measurement.
 *
 *   npx ts-node scripts/hal/measure-golden-math.ts
 */

import { execFileSync } from 'node:child_process';
import { buildCorpusManifest, type CorpusCase } from '../../src/hal/corpus-manifest';
import {
  recordMeasurement,
  formatMeasurement,
  describeRuler,
  type ConfigurationWidth,
  type ConfusionMatrix,
  type HalStrictness,
} from '../../src/hal/measurement-ruler';
import { assessRunIntegrity, type ProviderAttempt } from '../../src/hal/measurement-integrity';
import { buildFactCheckProviders, factCheck } from '../../src/hal/fact-check';
import { resolveHalStrictness } from '../../src/scoring/pipeline';

/**
 * The frozen golden-math set, mirroring `tests/hal/golden-math.test.ts`.
 *
 * Arithmetic is used deliberately: every label is decidable without judgement, so a
 * disagreement is unambiguously HAL's and never the corpus author's. `id`s are stable
 * and part of the content hash — renaming one produces a different corpus, which is
 * correct, because it would be a different population.
 */
const CASES: CorpusCase[] = [
  { id: 'gm-f01', text: '2 + 2 = 5', expectedHallucination: true },
  { id: 'gm-f02', text: '7 * 8 = 54', expectedHallucination: true },
  { id: 'gm-f03', text: '12 / 4 = 4', expectedHallucination: true },
  { id: 'gm-f04', text: '100 - 37 = 73', expectedHallucination: true },
  { id: 'gm-f05', text: '9 squared is 80', expectedHallucination: true },
  { id: 'gm-f06', text: 'The square root of 144 is 11', expectedHallucination: true },
  { id: 'gm-f07', text: '3 to the power of 4 is 64', expectedHallucination: true },
  { id: 'gm-f08', text: '15 % 4 = 2', expectedHallucination: true },
  { id: 'gm-f09', text: '1000 / 8 = 120', expectedHallucination: true },
  { id: 'gm-f10', text: 'The sum of the first 5 prime numbers is 26', expectedHallucination: true },
  { id: 'gm-t01', text: '2 + 2 = 4', expectedHallucination: false },
  { id: 'gm-t02', text: '7 * 8 = 56', expectedHallucination: false },
  { id: 'gm-t03', text: '12 / 4 = 3', expectedHallucination: false },
  { id: 'gm-t04', text: '100 - 37 = 63', expectedHallucination: false },
  { id: 'gm-t05', text: '9 squared is 81', expectedHallucination: false },
  { id: 'gm-t06', text: 'The square root of 144 is 12', expectedHallucination: false },
  { id: 'gm-t07', text: '3 to the power of 4 is 81', expectedHallucination: false },
  { id: 'gm-t08', text: '15 % 4 = 3', expectedHallucination: false },
  { id: 'gm-t09', text: '1000 / 8 = 125', expectedHallucination: false },
  { id: 'gm-t10', text: 'The sum of the first 5 prime numbers is 28', expectedHallucination: false },
];

const engineCommit = (): string | undefined => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

const envTrue = (k: string) => process.env[k] === 'true';

async function main(): Promise<number> {
  const providers = buildFactCheckProviders();
  const familiesConfigured = new Set(providers.map((p) => p.family ?? p.name)).size;

  console.log(`configured: ${providers.map((p) => `${p.name}/${p.model}`).join(', ')}`);
  console.log(`families configured: ${familiesConfigured}\n`);

  const matrix: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const attempts: ProviderAttempt[] = [];
  const disagreements: string[] = [];
  let familiesMin = Number.POSITIVE_INFINITY;
  let familiesMax = 0;

  for (const c of CASES) {
    const r: Record<string, unknown> = (await factCheck(c.text, providers)) as never;
    // `families_used` is a COUNT on some paths and a LIST on others. Both shapes are
    // real and neither is wrong; assuming one silently crashed the first run. The list
    // is preferred because it also allows per-provider attribution below.
    const rawFams = r.families_used;
    const rawProvs = r.providers_used;
    const used: string[] = Array.isArray(rawFams)
      ? rawFams.map(String)
      : Array.isArray(rawProvs)
        ? rawProvs.map(String)
        : [];
    const width =
      used.length > 0
        ? new Set(used).size
        : typeof rawFams === 'number'
          ? rawFams
          : typeof rawProvs === 'number'
            ? rawProvs
            : 0;
    familiesMin = Math.min(familiesMin, width);
    familiesMax = Math.max(familiesMax, width);

    // Any provider that did not answer this case is an ATTEMPT that failed. Recording
    // it here is what lets `assessRunIntegrity` refuse the whole measurement.
    for (const p of providers) {
      // With only a count, per-provider attribution is impossible. Recording every
      // provider as ok would fabricate a clean run; recording all as failed would
      // fabricate an outage. So attribution is SKIPPED and the width alone carries it.
      if (used.length === 0) break;
      const answered = used.some((u) => u === (p.family ?? p.name) || u === p.name);
      attempts.push({
        provider: p.name,
        family: p.family ?? p.name,
        ok: answered,
        ...(answered ? {} : { error: 'provider did not contribute a verdict for this case' }),
      });
    }

    // POSITIVE CLASS = hallucination. `vetoed` is HAL asserting the claim is false.
    const decision = String(r.decision ?? r.verdict ?? '');
    const flaggedAsHallucination = decision === 'vetoed';

    if (c.expectedHallucination && flaggedAsHallucination) matrix.tp++;
    else if (c.expectedHallucination && !flaggedAsHallucination) {
      matrix.fn++;
      disagreements.push(`  FN  ${c.id}  "${c.text}"  expected veto, got ${decision}`);
    } else if (!c.expectedHallucination && flaggedAsHallucination) {
      matrix.fp++;
      disagreements.push(`  FP  ${c.id}  "${c.text}"  expected clean, got ${decision}`);
    } else matrix.tn++;
  }

  const width: ConfigurationWidth = {
    familiesConfigured,
    familiesMin: Number.isFinite(familiesMin) ? familiesMin : 0,
    familiesMax,
    strictness: resolveHalStrictness() as HalStrictness,
    decisionRequiresQuorum: envTrue('HAL_DECISION_REQUIRES_QUORUM'),
    penaltyRequiresQuorum: envTrue('HAL_PENALTY_REQUIRES_QUORUM'),
  };

  // INTEGRITY BEFORE ARITHMETIC. A number taken while the fleet was degraded describes
  // a configuration nobody chose, so it is refused rather than annotated.
  const integrity = assessRunIntegrity({ attempts, width });
  // `IntegrityVerdict` is a discriminated union on `measurable` — there is no `verdict`
  // field. Reading one printed "undefined" while still refusing correctly, which is the
  // benign version of this mistake and exactly why the union is shaped that way.
  if (!integrity.measurable) {
    console.error(`\nREFUSED — the run is not measurable: ${integrity.summary}`);
    for (const f of integrity.faults.slice(0, 6)) console.error(`  ${f.kind}: ${f.detail}`);
    console.error(
      '\nNo F1 is printed. An environment fault and a quality regression are different\n' +
        'findings, and reporting one as the other is the mistake this guards.',
    );
    return 1;
  }

  const manifest = buildCorpusManifest({
    corpusId: 'hal-golden-math-v1',
    cases: CASES,
    sources: [{ kind: 'inline', ref: 'scripts/hal/measure-golden-math.ts', caseCount: CASES.length }] as never,
  });

  const m = recordMeasurement({ matrix, ruler: { corpus: manifest, width, engineCommit: engineCommit() } });

  console.log('=== CONFUSION MATRIX (positive class = hallucination) ===');
  console.log(`  tp ${matrix.tp}   fp ${matrix.fp}   fn ${matrix.fn}   tn ${matrix.tn}\n`);
  if (disagreements.length) {
    console.log('=== EVERY DISAGREEMENT, NAMED ===');
    for (const d of disagreements) console.log(d);
    console.log('');
  }
  console.log('=== RULED METRICS ===');
  for (const k of ['f1', 'precision', 'recall', 'accuracy', 'false_positive_rate'] as const) {
    console.log(`  ${k.padEnd(20)} ${formatMeasurement(k, m.metrics[k], m.ruler)}`);
  }
  console.log(`\n${describeRuler(m.ruler)}`);
  console.log(`\nCITATION: ${m.citation}`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('measurement failed:', e?.message ?? e);
    process.exit(2);
  });
