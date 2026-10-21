#!/usr/bin/env node
/**
 * seal.mjs - hash every frozen arena-evaluator file into manifest.json and print the manifest's sha256
 * (the commitment, pinned in tests/eval/arena-oracle-frozen.test.ts).
 *
 *   node eval/arena/seal.mjs            rewrite manifest.json
 *   node eval/arena/seal.mjs --check    write nothing; exit 1 if any hash drifted
 *
 * Raw bytes, no line-ending normalisation (.gitattributes keeps them LF). XC1 only: a change here is a
 * new commitment and goes in its own PR with the new manifest sha256.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['FROZEN.md', 'cases.json', 'oracle.ts', 'variants.ts', 'run-variants.ts', 'seal.mjs'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const manifest = {
  format: 'xc1-arena-frozen/0.1',
  author_lane: 'XC1',
  created: '2026-10-21',
  files: FILES.map((path) => ({ path, sha256: sha256(readFileSync(join(HERE, path))) })),
  signer: { status: 'UNSIGNED', note: 'Sean may sign the manifest sha256 in a detached manifest.sig.json; sealing never signs.' },
};
const text = JSON.stringify(manifest, null, 2) + '\n';
const path = join(HERE, 'manifest.json');
if (process.argv.includes('--check')) {
  let before = '';
  try { before = readFileSync(path, 'utf8'); } catch { /* missing = stale */ }
  if (before !== text) { process.stderr.write('STALE: eval/arena/manifest.json does not match the files it commits to.\n'); process.exit(1); }
} else {
  writeFileSync(path, text);
}
console.log(sha256(text));
