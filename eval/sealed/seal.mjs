#!/usr/bin/env node
/**
 * seal.mjs - compute every hash a sealed package's manifest commits to, and write them in.
 *
 *   node eval/sealed/seal.mjs <package-dir> [--holdout <dir>] [--check]
 *
 * Fills: statement.sha256, baseline.tree_sha256 / file_count, protected_files[].sha256, every
 * command's argv_sha256, evaluator.files[].sha256, and (with --holdout) holdout.tree_sha256 /
 * file_count. Without --holdout the holdout hash already in the manifest is kept: the holdout is
 * secret, and only its owner can recompute it.
 *
 * --check writes nothing and exits 1 if any hash it can compute differs from the manifest. The
 * self-tests run it so a stale manifest cannot sit beside a changed file.
 *
 * Prints the manifest's sha256: the value published before a worker starts (the commitment).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, treeHash, walk } from './evaluate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pkg = resolve(args[0] ?? '');
const holdoutAt = args.indexOf('--holdout');
const holdout = holdoutAt >= 0 ? resolve(args[holdoutAt + 1]) : null;
const check = args.includes('--check');

const path = join(pkg, 'manifest.json');
const before = readFileSync(path, 'utf8');
const m = JSON.parse(before);

m.statement.sha256 = sha256(readFileSync(join(pkg, m.statement.path)));
const base = walk(join(pkg, m.baseline.dir));
if (base.links.length) throw new Error(`baseline contains links: ${base.links.join(', ')}`);
Object.assign(m.baseline, (({ sha256: s, file_count }) => ({ tree_sha256: s, file_count }))(treeHash(base.files)));
for (const p of m.protected_files) {
  const abs = base.files.get(p.path);
  if (!abs) throw new Error(`protected file not in baseline: ${p.path}`);
  p.sha256 = sha256(readFileSync(abs));
}
for (const c of [m.reproduction, ...m.protected_commands, ...(m.holdout ? [m.holdout] : [])]) c.argv_sha256 = sha256(JSON.stringify(c.argv));
for (const f of m.evaluator.files) f.sha256 = sha256(readFileSync(join(HERE, f.path)));
if (holdout && m.holdout) {
  const h = walk(holdout);
  if (h.links.length) throw new Error('holdout contains links');
  const t = treeHash(h.files);
  m.holdout.tree_sha256 = t.sha256;
  m.holdout.file_count = t.file_count;
}

const after = JSON.stringify(m, null, 2) + '\n';
if (check) {
  if (after !== before) {
    process.stderr.write('STALE: manifest.json does not match the files it commits to. Run seal.mjs without --check.\n');
    process.exit(1);
  }
} else {
  writeFileSync(path, after);
}
process.stdout.write(`manifest sha256: ${sha256(Buffer.from(after, 'utf8'))}\n`);
