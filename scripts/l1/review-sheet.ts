/**
 * Re-render the review sheet from the payload and the experiment policy, so a reviewer checks the sheet
 * against the bytes rather than against the author's copy.
 *
 *   npx ts-node --transpile-only scripts/l1/review-sheet.ts --payload <l1-typed-data.json> --experiment <l1-experiment-policy.json> [--check <l1-review-sheet.md>]
 *
 * Prints the sheet. With --check, exits 0 only when the given sheet is byte-identical to a fresh render.
 */
import { readFileSync } from 'node:fs';
import { renderReviewSheet } from '../../src/kernel/l1';

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

try {
  const payload = arg('payload');
  const experiment = arg('experiment');
  if (!payload || !experiment) throw new Error('--payload and --experiment are required');
  const sheet = renderReviewSheet(readFileSync(payload, 'utf8'), readFileSync(experiment, 'utf8'));
  const check = arg('check');
  if (check) {
    // Line endings only: an editor re-saving the sheet with CRLF changes no word of it. The signed bytes are the payload, not the sheet.
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    const same = lf(readFileSync(check, 'utf8')) === lf(sheet);
    console.log(same ? 'MATCH: the sheet is exactly what these bytes render' : 'MISMATCH: the sheet is not what these bytes render. Do not sign.');
    process.exit(same ? 0 : 1);
  }
  process.stdout.write(sheet);
} catch (e) {
  console.error(`REFUSED: ${(e as Error).message}`);
  process.exit(1);
}
