#!/usr/bin/env ts-node
/**
 * Proof that a commit crosses between two real machines only through the verified bundle.
 * Used by t12-supervisor-synthetic.yml. It touches only local refs in a disposable CI checkout.
 *
 *   artifact-boundary.ts make <dir>    commit on top of origin/main, write the bundle, print step outputs
 *   artifact-boundary.ts check <dir>   import using BUNDLE_SHA256, COMMIT and BASE from the first job, then tamper
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleName, exportSubmission, importSubmission } from '../../src/orchestration/t12-lane-transfer';
import type { LaneSpec, Submission } from '../../src/orchestration/t12-lane-store';

const [mode, dir] = process.argv.slice(2) as [string, string];
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BRANCH = 't12/boundary-e1';
const FILE = 'tests/t12-boundary-probe.test.mjs';
const spec: LaneSpec = { id: 'boundary', repo: 'DealAppSeo/repid-engine', title: 'boundary', prompt: 'probe', paths: [FILE], verify: { runner: 'node-test', target: FILE }, risk: 'LOW' };

if (mode === 'make') {
  git('fetch', '-q', 'origin', 'main');
  const base = git('rev-parse', 'origin/main');
  git('checkout', '-q', '-b', BRANCH, base);
  writeFileSync(FILE, `// probe ${base}\n`);
  git('add', FILE);
  git('-c', 'user.name=t12', '-c', 'user.email=t12@users.noreply.github.com', 'commit', '-q', '-m', 'probe');
  const commit = git('rev-parse', 'HEAD');
  process.stdout.write(`sha256=${exportSubmission(process.cwd(), dir, spec, BRANCH, base, commit)}\ncommit=${commit}\nbase=${base}\n`);
} else if (mode === 'check') {
  const { BUNDLE_SHA256, COMMIT, BASE } = process.env as Record<string, string>;
  const sub: Submission = { branch: BRANCH, commit: COMMIT, base: BASE, files: [FILE], host: null, bundle_sha256: BUNDLE_SHA256 };
  let hadIt = true;
  try { git('cat-file', '-e', `${COMMIT}^{commit}`); } catch { hadIt = false; }
  if (hadIt) throw new Error('this machine already had the commit, so the transfer proves nothing');
  const file = join(dir, bundleName(spec.id, COMMIT));
  const original = readFileSync(file);
  const flipped = Buffer.from(original);
  flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
  writeFileSync(file, flipped);
  const tampered = importSubmission(process.cwd(), dir, spec, sub);
  if (tampered.ok || tampered.outcome !== 'rejected') throw new Error(`a changed byte was not refused: ${JSON.stringify(tampered)}`);
  writeFileSync(file, original);
  const good = importSubmission(process.cwd(), dir, spec, sub);
  if (!good.ok) throw new Error(`the real bundle was refused: ${good.reason}`);
  if (git('cat-file', '-t', COMMIT) !== 'commit') throw new Error('the commit did not arrive');
  process.stdout.write('PASS: a changed byte is refused and the real bundle arrives on a machine that did not have the commit\n');
} else {
  process.stderr.write('usage: artifact-boundary.ts make|check <dir>\n');
  process.exit(2);
}
