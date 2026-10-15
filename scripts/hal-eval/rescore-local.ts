/**
 * Re-score a run-frozen-corpus-local output under both scorings, v1 and v2 (metrics.ts SCORING), so a
 * number taken before v2 can be read on the new ruler instead of being compared across rulers.
 * Reads the JSON only; calls nothing.
 *
 *   npx ts-node scripts/hal-eval/rescore-local.ts reports/hal-eval/<run>.LOCAL.json
 */
import fs from 'fs';
import { confusionMatrix, prf1, isNotChecked, isNotCheckedV2, SCORING } from './metrics';

type Row = { id: string; truth: string; verdict?: string; mode?: string; error?: string; votes?: Record<string, number> };

const file = process.argv[2];
if (!file) {
  console.error('usage: rescore-local.ts <run .LOCAL.json>');
  process.exit(1);
}
const run = JSON.parse(fs.readFileSync(file, 'utf8')) as { ruler?: string; results?: Row[] };
const rows = run.results ?? [];
for (const [name, notChecked] of [
  ['v1-not-checked-is-error-abstain-fallback', isNotChecked],
  [SCORING, isNotCheckedV2],
] as const) {
  const checked = rows.filter((r) => !r.error && r.verdict && !notChecked(r));
  const c = confusionMatrix(checked);
  const { f1 } = prf1(c);
  const nc = rows.filter((r) => notChecked(r)).length;
  console.log(
    `${name}: TP ${c.tp} FP ${c.fp} TN ${c.tn} FN ${c.fn} | NOT_CHECKED ${nc}/${rows.length} | ` +
      `F1 ${checked.length ? f1.toFixed(4) : 'n/a (nothing checked)'} on ${run.ruler ?? 'unknown ruler'}`,
  );
}
