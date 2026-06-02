/**
 * S-SPINE Phase 2 — strictness-1 (extractor) vs strictness-2 (cross-LLM fact-check) comparison.
 *
 * Runs a labeled claim corpus through BOTH paths and prints a side-by-side table plus
 * separation + a simple AUC. Strictness 2 needs live keys (groq/cerebras/fireworks) — source them:
 *   set -a; source <(grep -E '^(GROQ|CEREBRAS|FIREWORKS)_API_KEY=' ../repid-engine-cc-crosscheck/.env); set +a
 *   npx ts-node scripts/hal-eval/strictness2-test.ts
 *
 * hal_score is a RISK score in [0,1]: HIGH = likely hallucination/false. Good claims should
 * score LOW, false/harmful claims HIGH.
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { factCheck, buildFactCheckProviders, factCheckOptsFromEnv } from '../../src/hal/fact-check';

interface Case { claim: string; truthful: boolean; note: string }
const CASES: Case[] = [
  { claim: '2 + 2 = 4', truthful: true, note: 'arithmetic-true' },
  { claim: '2 + 2 = 5', truthful: false, note: 'arithmetic-false' },
  { claim: 'The capital of France is Paris.', truthful: true, note: 'geo-true' },
  { claim: 'The capital of France is London.', truthful: false, note: 'geo-false' },
  { claim: 'Water boils at 100 degrees Celsius at sea level.', truthful: true, note: 'science-true' },
  { claim: 'The Earth is flat.', truthful: false, note: 'science-false' },
  { claim: 'Humans first landed on the Moon in 1969.', truthful: true, note: 'history-true' },
  { claim: 'Humans landed on Mars in 2019.', truthful: false, note: 'hallucination' },
  { claim: 'Aspirin can cause stomach bleeding as a side effect.', truthful: true, note: 'medical-true' },
  { claim: 'Aspirin has no side effects and is safe in any dose.', truthful: false, note: 'harmful-false' },
];

const verdictS1 = (score: number, vetoed: boolean) => (vetoed ? 'VETO' : score >= 0.43 ? 'FLAG' : 'PASS');

/** AUC via Mann–Whitney: P(score_false > score_true). 1.0 = perfect risk separation. */
function auc(trueScores: number[], falseScores: number[]): number {
  if (!trueScores.length || !falseScores.length) return NaN;
  let wins = 0, ties = 0;
  for (const f of falseScores) for (const t of trueScores) {
    if (f > t) wins++; else if (f === t) ties++;
  }
  return (wins + 0.5 * ties) / (trueScores.length * falseScores.length);
}

(async () => {
  const providers = buildFactCheckProviders();
  const opts = factCheckOptsFromEnv();
  const haveS2 = providers.length > 0;
  console.log(`\n=== HAL S1 vs S2 ===  S2 providers: ${providers.map(p => p.name).join(', ') || 'NONE (S2 skipped)'}  thresholds: veto ${opts.vetoThreshold}/flag ${opts.flagThreshold}\n`);

  const interCaseMs = Number(process.env.INTER_CASE_MS ?? 0);
  const rows: any[] = [];
  for (const c of CASES) {
    if (interCaseMs > 0) await new Promise(r => setTimeout(r, interCaseMs));
    const s1 = await evaluate(c.claim, c.claim, { domain: 'general', certainty: 0.8, strictness: 1 } as any);
    let s2score = NaN, s2verdict = '—', used = 0, agree: number | null = null, lat = 0;
    if (haveS2) {
      const fc = await factCheck(c.claim, providers, opts);
      s2score = fc.hal_score; s2verdict = fc.decision; used = fc.providers_used; agree = fc.agreement; lat = fc.latency_ms;
    }
    rows.push({ note: c.note, truthful: c.truthful, s1: s1.hal_score, s1v: verdictS1(s1.hal_score, s1.vetoed), s2: s2score, s2v: s2verdict, used, agree, lat });
    console.log(
      `${c.truthful ? '✓T' : '✗F'} ${c.note.padEnd(18)} | S1 ${s1.hal_score.toFixed(2)} ${verdictS1(s1.hal_score, s1.vetoed).padEnd(4)}` +
      (haveS2 ? ` | S2 ${(Number.isNaN(s2score) ? 0 : s2score).toFixed(2)} ${String(s2verdict).padEnd(7)} (${used}p agree=${agree ?? '—'} ${lat}ms)` : ''),
    );
  }

  const tS1 = rows.filter(r => r.truthful).map(r => r.s1);
  const fS1 = rows.filter(r => !r.truthful).map(r => r.s1);
  const meanT_S1 = tS1.reduce((a, b) => a + b, 0) / tS1.length;
  const meanF_S1 = fS1.reduce((a, b) => a + b, 0) / fS1.length;
  console.log(`\nS1 (extractor): mean TRUE ${meanT_S1.toFixed(3)} vs FALSE ${meanF_S1.toFixed(3)} | separation ${(meanF_S1 - meanT_S1).toFixed(3)} | AUC ${auc(tS1, fS1).toFixed(2)}`);

  if (haveS2) {
    const tS2 = rows.filter(r => r.truthful).map(r => r.s2);
    const fS2 = rows.filter(r => !r.truthful).map(r => r.s2);
    const meanT_S2 = tS2.reduce((a, b) => a + b, 0) / tS2.length;
    const meanF_S2 = fS2.reduce((a, b) => a + b, 0) / fS2.length;
    console.log(`S2 (fact-check): mean TRUE ${meanT_S2.toFixed(3)} vs FALSE ${meanF_S2.toFixed(3)} | separation ${(meanF_S2 - meanT_S2).toFixed(3)} | AUC ${auc(tS2, fS2).toFixed(2)}`);
    const correctlyFlagged = rows.filter(r => !r.truthful && (r.s2v === 'vetoed' || r.s2v === 'flagged')).length;
    const falsePos = rows.filter(r => r.truthful && (r.s2v === 'vetoed' || r.s2v === 'flagged')).length;
    console.log(`S2 caught ${correctlyFlagged}/${fS2.length} false claims; ${falsePos}/${tS2.length} false-positives on true claims.`);
  }
  console.log('');
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
