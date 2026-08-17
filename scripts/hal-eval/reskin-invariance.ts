/**
 * RE-SKIN INVARIANCE — does HAL judge the claim, or the writing?
 *
 * Re-renders every case in the canary corpus in ways that CANNOT change whether the claim is true
 * (src/hal/reskin.ts), re-runs HAL's decision path on each rendering, and reports how far the
 * verdict and the score moved. Movement under a truth-preserving transform is the instrument
 * reading the typography.
 *
 * Implements the one Phase 2 item of docs/RSI-ADOPTION-PLAN.md §3.4 that needs neither a live fleet
 * nor provider keys.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MEASURES, AND WHAT IT EXPLICITLY DOES NOT
 * ════════════════════════════════════════════════════════════════════════════════
 * MEASURED: strictness 1 — the deterministic extractor (src/hal/lib/extract.ts) plus the canonical
 * score (src/hal/lib/score.ts). Both are pure functions, so this runs anywhere, needs no keys, and
 * is exactly reproducible.
 *
 * NOT CHECKED: strictness 2 — the cross-LLM fact-check quorum. It requires live provider keys, and
 * a re-skin result from strictness 1 says NOTHING about it. Running the quorum on re-skinned text
 * is a separate and more interesting measurement, and it is the one that describes production
 * behaviour on the veto path. This harness refuses to guess at it: the report prints NOT_CHECKED
 * for that row rather than extrapolating (three outcomes, never two).
 *
 * A caveat that belongs in the reading of any result here: src/hal/lib/score.ts records in its own
 * comments that the strictness-1 extractor is NON-DISCRIMINATIVE — it does not separate true claims
 * from false ones. So this measures the stability of an instrument already known not to discriminate.
 * That makes the result more interesting rather than less: if the extractor neither separates
 * true from false NOR holds still under re-rendering, its output is substantially a function of
 * writing style.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE RULER
 * ════════════════════════════════════════════════════════════════════════════════
 * Every number printed carries corpus id + content hash + case count + strictness + the certainty
 * held constant + the transform-set version. Two runs under different transform sets are not
 * comparable, exactly as two F1 numbers under different rulers are not (LESSONS §8).
 *
 * MEASURE-ONLY: reads two files, writes nothing, touches no database and no network.
 *
 * Run:
 *   npx ts-node scripts/hal-eval/reskin-invariance.ts
 * Env:
 *   RESKIN_CORPUS=eval/canary/canary-corpus-v1.1.jsonl   which corpus file
 *   RESKIN_CERTAINTY=0.9                                 certainty held constant across renderings
 *   RESKIN_JSON=1                                        emit machine-readable JSON as well
 */
import * as fs from 'fs';
import * as path from 'path';

import { extractHALSignals } from '../../src/hal/lib/extract';
import { computeHALScore } from '../../src/hal/lib/score';
import { RESKIN_TRANSFORMS, RESKIN_TRANSFORM_SET_VERSION, applyReskin } from '../../src/hal/reskin';
import { buildCorpusManifest, CorpusCase, describeCorpus } from '../../src/hal/corpus-manifest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CORPUS_REL = process.env.RESKIN_CORPUS ?? 'eval/canary/canary-corpus-v1.1.jsonl';
const CERTAINTY = Number(process.env.RESKIN_CERTAINTY ?? '0.9');

interface CanaryRow {
  claim: string;
  label: string;
  domain?: string;
}

function loadCorpus(rel: string): CanaryRow[] {
  const abs = path.join(REPO_ROOT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const rows: CanaryRow[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const parsed = JSON.parse(t) as CanaryRow;
    if (typeof parsed.claim === 'string' && parsed.claim.trim() !== '') rows.push(parsed);
  }
  return rows;
}

/** Score one rendering through the pure strictness-1 path. */
function scoreOne(text: string, domain: string) {
  const signals = extractHALSignals({ text, domain, certainty: CERTAINTY });
  const scored = computeHALScore(signals);
  return { signals, hal_score: scored.hal_score, vetoed: scored.vetoed, threshold: scored.threshold };
}

type SignalKey =
  | 'harm_probability'
  | 'epistemic_uncertainty'
  | 'evidence_quality'
  | 'scope_appropriateness';

const SIGNAL_KEYS: SignalKey[] = [
  'harm_probability',
  'epistemic_uncertainty',
  'evidence_quality',
  'scope_appropriateness',
];

interface TransformResult {
  transformId: string;
  probes: string;
  /** Cases where the transform actually altered the string. Deltas are computed over these only. */
  applicable: number;
  /** Cases where the verdict (vetoed true/false) changed. */
  verdictFlips: number;
  /** Of those, how many went clean -> vetoed, and how many vetoed -> clean. Direction is the finding. */
  flipsToVeto: number;
  flipsToClean: number;
  meanAbsScoreDelta: number;
  /** SIGNED: positive means the re-rendering RAISED measured hallucination risk. */
  meanSignedScoreDelta: number;
  maxAbsScoreDelta: number;
  /** Case text of the biggest mover, for the report. Truncated. */
  worstCase: string | null;
  signalMeanAbsDelta: Record<SignalKey, number>;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function main(): void {
  const rows = loadCorpus(CORPUS_REL);
  if (rows.length === 0) {
    console.error(`[reskin] no usable rows in ${CORPUS_REL}`);
    process.exit(1);
  }

  // The ruler's corpus half. expectedHallucination: label FALSE means the claim is false, which is
  // the positive (hallucination) class for this corpus.
  const cases: CorpusCase[] = rows.map((r, i) => ({
    id: `canary-${i}`,
    text: r.claim,
    expectedHallucination: String(r.label).toUpperCase() === 'FALSE',
  }));
  const manifest = buildCorpusManifest({
    corpusId: path.basename(CORPUS_REL, '.jsonl'),
    cases,
    builtAt: new Date('2026-08-17T00:00:00.000Z'),
  });

  const results: TransformResult[] = [];

  for (const transform of RESKIN_TRANSFORMS) {
    const scoreDeltas: number[] = [];
    const signedDeltas: number[] = [];
    let flipsToVeto = 0;
    let flipsToClean = 0;
    const signalDeltas: Record<SignalKey, number[]> = {
      harm_probability: [],
      epistemic_uncertainty: [],
      evidence_quality: [],
      scope_appropriateness: [],
    };
    let verdictFlips = 0;
    let applicable = 0;
    let maxAbs = 0;
    let worstCase: string | null = null;

    for (const row of rows) {
      const domain = row.domain ?? 'general';
      const app = applyReskin(transform, row.claim);
      if (!app.changed && transform.id !== 'identity') continue;
      applicable += 1;

      const before = scoreOne(row.claim, domain);
      const after = scoreOne(app.reskinned, domain);

      const signed = after.hal_score - before.hal_score;
      const d = Math.abs(signed);
      scoreDeltas.push(d);
      signedDeltas.push(signed);
      if (d > maxAbs) {
        maxAbs = d;
        worstCase = row.claim;
      }
      if (before.vetoed !== after.vetoed) {
        verdictFlips += 1;
        if (after.vetoed) flipsToVeto += 1;
        else flipsToClean += 1;
      }

      for (const k of SIGNAL_KEYS) {
        signalDeltas[k].push(Math.abs(after.signals[k] - before.signals[k]));
      }
    }

    results.push({
      transformId: transform.id,
      probes: transform.probes,
      applicable,
      verdictFlips,
      flipsToVeto,
      flipsToClean,
      meanAbsScoreDelta: mean(scoreDeltas),
      meanSignedScoreDelta: mean(signedDeltas),
      maxAbsScoreDelta: maxAbs,
      worstCase,
      signalMeanAbsDelta: {
        harm_probability: mean(signalDeltas.harm_probability),
        epistemic_uncertainty: mean(signalDeltas.epistemic_uncertainty),
        evidence_quality: mean(signalDeltas.evidence_quality),
        scope_appropriateness: mean(signalDeltas.scope_appropriateness),
      },
    });
  }

  // ---- the ruler, printed before any number ----
  const rulerLine =
    `corpus ${describeCorpus(manifest)} | strictness 1 (deterministic extractor, NO cross-LLM) | ` +
    `certainty held at ${CERTAINTY} | transforms ${RESKIN_TRANSFORM_SET_VERSION}`;

  console.log('');
  console.log('RE-SKIN INVARIANCE — HAL strictness 1');
  console.log('='.repeat(100));
  console.log(`RULER: ${rulerLine}`);
  console.log('');

  const control = results.find((r) => r.transformId === 'identity');
  if (!control) {
    console.error('[reskin] negative control missing — refusing to report');
    process.exit(1);
  }
  const controlClean = control.verdictFlips === 0 && control.maxAbsScoreDelta === 0;
  console.log(
    `NEGATIVE CONTROL (identity): ${controlClean ? 'CLEAN — 0 flips, 0 drift' : 'FAILED'}` +
      `${controlClean ? '' : ` (flips=${control.verdictFlips}, maxDrift=${control.maxAbsScoreDelta})`}`,
  );
  if (!controlClean) {
    console.error('[reskin] the no-op transform moved the score. The harness is broken; every row below is untrustworthy.');
    process.exit(1);
  }
  console.log('');

  const head =
    'transform'.padEnd(26) +
    'N'.padStart(4) +
    'flips'.padStart(7) +
    '->veto'.padStart(8) +
    '->clean'.padStart(9) +
    'mean|Δ|'.padStart(11) +
    'meanΔsigned'.padStart(14) +
    'max|Δ|'.padStart(10);
  console.log(head);
  console.log('-'.repeat(100));
  for (const r of results) {
    if (r.transformId === 'identity') continue;
    console.log(
      r.transformId.padEnd(26) +
        String(r.applicable).padStart(4) +
        String(r.verdictFlips).padStart(7) +
        String(r.flipsToVeto).padStart(8) +
        String(r.flipsToClean).padStart(9) +
        r.meanAbsScoreDelta.toFixed(6).padStart(11) +
        (r.meanSignedScoreDelta >= 0 ? '+' : '') + r.meanSignedScoreDelta.toFixed(6).padStart(13) +
        r.maxAbsScoreDelta.toFixed(6).padStart(10),
    );
  }

  console.log('');
  console.log('PER-SIGNAL MEAN |Δ| (transforms that moved anything)');
  console.log('-'.repeat(100));
  console.log(
    'transform'.padEnd(26) +
      'harm'.padStart(12) +
      'epistemic'.padStart(12) +
      'evidence'.padStart(12) +
      'scope'.padStart(12),
  );
  for (const r of results) {
    if (r.transformId === 'identity') continue;
    const s = r.signalMeanAbsDelta;
    const anyMovement = SIGNAL_KEYS.some((k) => s[k] > 0);
    if (!anyMovement) continue;
    console.log(
      r.transformId.padEnd(26) +
        s.harm_probability.toFixed(6).padStart(12) +
        s.epistemic_uncertainty.toFixed(6).padStart(12) +
        s.evidence_quality.toFixed(6).padStart(12) +
        s.scope_appropriateness.toFixed(6).padStart(12),
    );
  }

  // ---- the factorial read: contentless-prefix minus initial-lowercase isolates the length term ----
  const prefix = results.find((r) => r.transformId === 'contentless-prefix');
  const initial = results.find((r) => r.transformId === 'initial-lowercase');
  if (prefix && initial) {
    console.log('');
    console.log('ISOLATING THE LENGTH TERM (contentless-prefix = initial-lowercase + 5 padding words)');
    console.log('-'.repeat(100));
    console.log(
      `  initial-lowercase alone : mean|Δscore| ${initial.meanAbsScoreDelta.toFixed(6)}, ` +
        `${initial.verdictFlips} flips`,
    );
    console.log(
      `  + 5 contentless words   : mean|Δscore| ${prefix.meanAbsScoreDelta.toFixed(6)}, ` +
        `${prefix.verdictFlips} flips`,
    );
    console.log(
      `  => attributable to length: ${(prefix.meanAbsScoreDelta - initial.meanAbsScoreDelta).toFixed(6)} ` +
        `mean |Δscore|`,
    );
  }

  const totalFlips = results.reduce((a, r) => a + (r.transformId === 'identity' ? 0 : r.verdictFlips), 0);
  const worst = results
    .filter((r) => r.transformId !== 'identity')
    .reduce<TransformResult | null>((a, r) => (a === null || r.maxAbsScoreDelta > a.maxAbsScoreDelta ? r : a), null);

  console.log('');
  console.log('VERDICT');
  console.log('='.repeat(100));
  console.log(`  strictness 1 : ${totalFlips === 0 ? 'INVARIANT on verdicts' : `NOT INVARIANT — ${totalFlips} verdict flips`}`);
  if (worst) {
    console.log(`  largest score drift under a truth-preserving re-render: ${worst.maxAbsScoreDelta.toFixed(6)} (${worst.transformId})`);
    if (worst.worstCase) console.log(`    on: "${worst.worstCase.slice(0, 88)}${worst.worstCase.length > 88 ? '…' : ''}"`);
  }
  console.log('  strictness 2 (cross-LLM quorum) : NOT_CHECKED — requires live provider keys.');
  console.log('    A strictness-1 result says nothing about the quorum. Do not extrapolate.');
  console.log('');
  console.log(`  ruler: ${rulerLine}`);
  console.log('');

  if (process.env.RESKIN_JSON === '1') {
    console.log(JSON.stringify({ ruler: rulerLine, corpus: manifest, results }, null, 2));
  }
}

main();
