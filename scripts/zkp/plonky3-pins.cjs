#!/usr/bin/env node
/**
 * plonky3-pins.cjs — ZKP Invariant 5 ("one Plonky3 pin governs all Plonky3 circuits"), checked.
 *
 * Reads the Cargo.lock of every prover that builds Plonky3 and lists each distinct Plonky3
 * source: a git commit, or crates.io@version.
 *   exit 0  PASS         exactly one source across every lockfile
 *   exit 1  FAIL         more than one source: the invariant is broken
 *   exit 2  NOT_CHECKED  a lockfile was unreadable or held no Plonky3 crate, and nothing failed.
 *                        Never reported as a pass: an unread prover may be the one that drifted.
 *
 * WHY THE LOCKFILE, NOT Cargo.toml: trinity-ecosystem's zkp-postcard names Plonky3 by git URL
 * with no `rev`, so its Cargo.toml floats while its Cargo.lock holds the commit that actually
 * builds. On 2026-11-15 this found THREE sources: zkp-vault on crates.io 0.3.0, hyperdag-core on
 * 0.5.1 @ 27d59f73, trinity-ecosystem on 0.5.1 @ 6374a36f. The invariant was prose until then.
 *
 * WHERE IT RUNS: beside sibling checkouts (operator machine or the ops loop). repid-engine CI
 * alone cannot see the other repos, so this is not a CI gate yet. Making each repo check its
 * own lock against one named pin is plan step B2, once the pins agree.
 *
 * Usage:
 *   node scripts/zkp/plonky3-pins.cjs                 default provers; siblings under REPOS_DIR
 *                                                     (default: this repo's parent directory)
 *   node scripts/zkp/plonky3-pins.cjs a/Cargo.lock …  explicit lockfiles
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Own lock is read from THIS checkout (the one under review); siblings from REPOS_DIR.
const OWN_LOCK = path.join(REPO_ROOT, 'zkp-vault', 'Cargo.lock');
const SIBLING_LOCKS = [
  'hyperdag-core/services/zkp-postcard/Cargo.lock',
  'hyperdag-core/services/babybear-leaf/Cargo.lock',
  'hyperdag-proof-verifier/Cargo.lock',
  'trinity-ecosystem/services/zkp-postcard/Cargo.lock',
];

/** Distinct Plonky3 sources in one Cargo.lock text, sorted. Non-`p3-` packages are ignored. */
function plonky3Sources(lockText) {
  const sources = new Set();
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (!name || !name.startsWith('p3-')) continue;
    const version = /^version = "([^"]+)"/m.exec(block)?.[1] ?? '?';
    const source = /^source = "([^"]+)"/m.exec(block)?.[1];
    const commit = source && /^git\+[^#]+#([0-9a-f]{7,40})$/.exec(source)?.[1];
    if (commit) sources.add(`git:${commit}@${version}`);
    else if (source && source.startsWith('registry+')) sources.add(`crates.io@${version}`);
    else sources.add(`${source ?? 'path'}@${version}`); // a path or unknown source is its own pin
  }
  return [...sources].sort();
}

/** entries: [{ file, text }] where text is null when the file could not be read. */
function check(entries) {
  const perFile = entries.map(({ file, text }) => {
    if (text == null) return { file, status: 'NOT_CHECKED', reason: 'unreadable', sources: [] };
    const sources = plonky3Sources(text);
    if (sources.length === 0) return { file, status: 'NOT_CHECKED', reason: 'no Plonky3 crate', sources };
    return { file, status: 'READ', sources };
  });
  const distinct = [...new Set(perFile.flatMap((f) => f.sources))].sort();
  const verdict = distinct.length > 1 ? 'FAIL'
    : perFile.some((f) => f.status === 'NOT_CHECKED') ? 'NOT_CHECKED'
      : 'PASS';
  return { verdict, distinct, perFile };
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

if (require.main === module) {
  const reposDir = process.env.REPOS_DIR || path.dirname(REPO_ROOT);
  const files = process.argv.length > 2
    ? process.argv.slice(2)
    : [OWN_LOCK, ...SIBLING_LOCKS.map((f) => path.join(reposDir, f))];
  const r = check(files.map((file) => ({ file, text: readOrNull(file) })));
  for (const f of r.perFile) {
    console.log(`${f.status.padEnd(11)} ${f.file}${f.reason ? `  (${f.reason})` : ''}`);
    for (const s of f.sources) console.log(`            ${s}`);
  }
  console.log(`\n${r.verdict}: ${r.distinct.length} distinct Plonky3 source(s) across ${files.length} lockfile(s)`);
  process.exit({ PASS: 0, FAIL: 1, NOT_CHECKED: 2 }[r.verdict]);
}

module.exports = { plonky3Sources, check };
