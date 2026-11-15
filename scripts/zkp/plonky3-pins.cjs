#!/usr/bin/env node
/**
 * plonky3-pins.cjs — ZKP Invariant 5 ("one Plonky3 pin governs all Plonky3 circuits"), checked.
 *
 * Lists each distinct Plonky3 source (a git commit, or crates.io@version) across every prover.
 *   exit 0  PASS         exactly one source
 *   exit 1  FAIL         more than one source: the invariant is broken
 *   exit 2  NOT_CHECKED  something could not be read or is not pinned, and nothing failed.
 *                        Never reported as a pass: an unread prover may be the one that drifted.
 *
 * WHAT IT READS
 * - This repo's `zkp-vault/Cargo.lock` from THIS checkout (the change under review).
 * - Sibling provers from their `origin/main` via `git show`, NOT their working trees. A sibling
 *   checkout can sit on a stale branch: on 2026-11-15 the first version of this script read a
 *   trinity-ecosystem zkp-postcard that main had retired on 2026-10-07 (#214) and reported three
 *   sources where main has two. Run `git fetch` in the siblings first; the commit read is printed.
 * - A Cargo.lock when the repo commits one. Otherwise the Cargo.toml, where only an exact
 *   `rev = "<sha>"` git pin counts; a version range or a rev-less git dep is NOT_CHECKED.
 *
 * WHERE IT RUNS: beside sibling checkouts (operator machine or the ops loop). repid-engine CI
 * alone cannot see the other repos, so this is not a CI gate yet.
 *
 * Usage:
 *   node scripts/zkp/plonky3-pins.cjs              default provers; siblings under REPOS_DIR
 *                                                  (default: this repo's parent directory)
 *   node scripts/zkp/plonky3-pins.cjs FILE …       explicit Cargo.lock / Cargo.toml files
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OWN = path.join(REPO_ROOT, 'zkp-vault', 'Cargo.lock');
// Every Plonky3 prover on main, as of 2026-11-15. Adding a prover means adding a line here.
const SIBLINGS = [
  { repo: 'hyperdag-core', file: 'services/zkp-postcard/Cargo.lock' }, // the live prover
  { repo: 'hyperdag-core', file: 'services/babybear-leaf/Cargo.toml' },
  { repo: 'hyperdag-proof-verifier', file: 'Cargo.toml' },
];

/**
 * Plonky3 sources in one Cargo.lock or Cargo.toml text. Git sources are keyed by commit alone,
 * so a lockfile and a manifest pinning the same commit agree. Entries starting `unpinned:` are
 * manifest deps that name no exact commit.
 */
function plonky3Sources(text) {
  const sources = new Set();
  if (text.includes('[[package]]')) {
    for (const block of text.split('[[package]]').slice(1)) {
      const name = /^name = "([^"]+)"/m.exec(block)?.[1];
      if (!name || !name.startsWith('p3-')) continue;
      const version = /^version = "([^"]+)"/m.exec(block)?.[1] ?? '?';
      const source = /^source = "([^"]+)"/m.exec(block)?.[1];
      const commit = source && /^git\+[^#]+#([0-9a-f]{7,40})$/.exec(source)?.[1];
      if (commit) sources.add(`git:${commit}`);
      else if (source && source.startsWith('registry+')) sources.add(`crates.io@${version}`);
      else sources.add(`${source ?? 'path'}@${version}`); // a path or unknown source is its own pin
    }
  } else {
    for (const m of text.matchAll(/^(p3-[\w-]+)\s*=\s*(.+)$/gm)) {
      const rev = /\brev\s*=\s*"([0-9a-f]{7,40})"/.exec(m[2])?.[1];
      sources.add(rev ? `git:${rev}` : `unpinned:${m[1]}`);
    }
  }
  return [...sources].sort();
}

/** entries: [{ file, text }] where text is null when the file could not be read. */
function check(entries) {
  const perFile = entries.map(({ file, text }) => {
    if (text == null) return { file, status: 'NOT_CHECKED', reason: 'unreadable', sources: [] };
    const all = plonky3Sources(text);
    const unpinned = all.filter((s) => s.startsWith('unpinned:'));
    const sources = all.filter((s) => !s.startsWith('unpinned:'));
    if (unpinned.length) return { file, status: 'NOT_CHECKED', reason: `not pinned to a commit: ${unpinned.join(', ')}`, sources };
    if (sources.length === 0) return { file, status: 'NOT_CHECKED', reason: 'no Plonky3 crate', sources };
    return { file, status: 'READ', sources };
  });
  const distinct = [...new Set(perFile.flatMap((f) => f.sources))].sort();
  const verdict = distinct.length > 1 ? 'FAIL'
    : perFile.some((f) => f.status === 'NOT_CHECKED') ? 'NOT_CHECKED'
      : 'PASS';
  return { verdict, distinct, perFile };
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readMainOrNull(repoDir, file) {
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const at = git('log', '-1', '--format=%h %cs', 'origin/main').trim();
    return { label: `${path.basename(repoDir)}@origin/main(${at}):${file}`, text: git('show', `origin/main:${file}`) };
  } catch {
    return { label: `${path.basename(repoDir)}@origin/main:${file}`, text: null };
  }
}

if (require.main === module) {
  const reposDir = process.env.REPOS_DIR || path.dirname(REPO_ROOT);
  const entries = process.argv.length > 2
    ? process.argv.slice(2).map((file) => ({ file, text: readFileOrNull(file) }))
    : [
      { file: `this checkout:zkp-vault/Cargo.lock`, text: readFileOrNull(OWN) },
      ...SIBLINGS.map(({ repo, file }) => {
        const r = readMainOrNull(path.join(reposDir, repo), file);
        return { file: r.label, text: r.text };
      }),
    ];
  const r = check(entries);
  for (const f of r.perFile) {
    console.log(`${f.status.padEnd(11)} ${f.file}${f.reason ? `  (${f.reason})` : ''}`);
    for (const s of f.sources) console.log(`            ${s}`);
  }
  console.log(`\n${r.verdict}: ${r.distinct.length} distinct Plonky3 source(s) across ${entries.length} file(s)`);
  process.exit({ PASS: 0, FAIL: 1, NOT_CHECKED: 2 }[r.verdict]);
}

module.exports = { plonky3Sources, check };
