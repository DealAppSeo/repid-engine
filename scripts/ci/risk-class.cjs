#!/usr/bin/env node
/**
 * risk-class.cjs — a PR's merge weight (LOW / MEDIUM / MAJOR) from the paths it changes.
 *
 * Why it exists (owner policy r31): the weight must come from repository rules, not from
 * an agent declaring its own PR "LOW". ADVISORY ONLY: it prints a class and the file(s)
 * that decided it. It never blocks, approves or merges, and the workflow that runs it
 * always exits 0.
 *
 * Usage:
 *   git diff --name-only -z --no-renames origin/main...HEAD | node risk-class.cjs --base-ref origin/main
 *   node risk-class.cjs [--rules FILE] [--base-ref REF | --pkg-changed CSV|none] [PATH ...]
 *
 * Paths come from the arguments, else from stdin (NUL- or newline-separated).
 * package.json is classed by WHICH fields changed, so the script needs one of:
 *   --base-ref REF       compare REF:package.json with HEAD:package.json itself
 *   --pkg-changed CSV    the release fields that changed ("none" = none), for manual runs
 * With neither, a changed package.json is MAJOR (unsure goes up).
 *
 * The rules live in risk-class-rules.json next to this file (read its _readme first).
 * CommonJS on purpose, like scripts/check-named-env-vars.cjs: tests require() it.
 * Exit codes: 0 classified, 2 bad usage or bad rules file.
 */
'use strict';

const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const ORDER = ['LOW', 'MEDIUM', 'MAJOR'];
const MAX_LISTED = 25;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?'; // "**/" = zero or more directories
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i'); // git paths are case-sensitive, Windows/macOS checkouts are not: match both
}

function tokensOf(path) {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalize(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Validate and pre-compile the rules; throws on anything malformed (a bad rules file must not silently classify). */
function loadRules(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const need = (ok, msg) => {
    if (!ok) throw new Error('risk-class rules: ' + msg);
  };
  need(ORDER.includes(raw.defaultClass) && raw.defaultClass !== 'LOW', 'defaultClass must be MEDIUM or MAJOR (never LOW)');
  need(Array.isArray(raw.rules) && raw.rules.length > 0, 'rules must be a non-empty array');
  const pj = raw.packageJson;
  need(pj && pj.path && Array.isArray(pj.majorFields) && ORDER.includes(pj.otherClass), 'packageJson block is malformed');
  raw.rules.forEach((r, i) => {
    need(ORDER.includes(r.class), `rule ${i}: class must be LOW, MEDIUM or MAJOR`);
    need(typeof r.reason === 'string' && r.reason.length > 0, `rule ${i}: reason is required`);
    const globs = r.globs || [], subs = r.substrings || [], toks = r.tokens || [];
    need(globs.length + subs.length + toks.length > 0, `rule ${i}: no matchers`);
    r._globs = globs.map(globToRegExp);
    r._subs = subs.map((s) => s.toLowerCase());
    r._toks = new Set(toks.map((s) => s.toLowerCase()));
  });
  return raw;
}

function ruleMatches(r, path) {
  if (r._globs.some((g) => g.test(path))) return true;
  const lower = path.toLowerCase();
  if (r._subs.some((s) => lower.includes(s))) return true;
  return r._toks.size > 0 && tokensOf(path).some((t) => r._toks.has(t));
}

/** pkgChanged: array of changed release fields, or undefined when it could not be determined. */
function classifyPath(rawPath, rules, pkgChanged) {
  const path = normalize(rawPath);
  const pj = rules.packageJson;
  if (path.toLowerCase() === pj.path) {
    if (pkgChanged === undefined) return { path, class: 'MAJOR', reason: pj.unknownReason };
    if (pkgChanged.length > 0) return { path, class: 'MAJOR', reason: `${pj.majorReason} [${pkgChanged.join(', ')}]` };
    return { path, class: pj.otherClass, reason: pj.otherReason };
  }
  const hit = rules.rules.find((r) => ruleMatches(r, path));
  return hit
    ? { path, class: hit.class, reason: hit.reason }
    : { path, class: rules.defaultClass, reason: rules.defaultReason };
}

/** The highest class among the files wins. `deciding` = the files at that class. */
function classify(paths, rules, opts = {}) {
  const files = paths.map(normalize).filter(Boolean).map((p) => classifyPath(p, rules, opts.pkgChanged));
  const top = files.reduce((m, f) => Math.max(m, ORDER.indexOf(f.class)), 0);
  const cls = ORDER[top];
  return { class: cls, files, deciding: files.filter((f) => f.class === cls) };
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

/** Which of `fields` differ between two parsed package.json objects. */
function pkgFieldsChanged(base, head, fields) {
  return fields.filter((f) => JSON.stringify(getPath(base, f)) !== JSON.stringify(getPath(head, f)));
}

/** Compare REF:package.json with HEAD:package.json; undefined if either side cannot be read. */
function pkgChangedFromGit(baseRef, fields) {
  try {
    const show = (spec) => JSON.parse(execFileSync('git', ['show', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return pkgFieldsChanged(show(`${baseRef}:package.json`), show('HEAD:package.json'), fields);
  } catch {
    return undefined;
  }
}

function format(result) {
  const count = (c) => result.files.filter((f) => f.class === c).length;
  const out = [`RISK CLASS: ${result.class}`];
  if (result.files.length === 0) {
    out.push('No changed files.');
    return out.join('\n');
  }
  out.push(`Changed files: ${result.files.length} (MAJOR ${count('MAJOR')}, MEDIUM ${count('MEDIUM')}, LOW ${count('LOW')})`);
  out.push(`Decided by the ${result.class} file(s):`);
  for (const f of result.deciding.slice(0, MAX_LISTED)) out.push(`  ${f.class}  ${f.path}  (${f.reason})`);
  if (result.deciding.length > MAX_LISTED) out.push(`  ... and ${result.deciding.length - MAX_LISTED} more at ${result.class}`);
  return out.join('\n');
}

function parseArgs(argv) {
  const a = { rules: join(__dirname, 'risk-class-rules.json'), baseRef: null, pkgChanged: undefined, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--rules') a.rules = argv[++i];
    else if (v === '--base-ref') a.baseRef = argv[++i];
    else if (v === '--pkg-changed') a.pkgChanged = (argv[++i] || '').split(',').filter((s) => s && s !== 'none');
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.paths.push(v);
  }
  return a;
}

function main(argv) {
  const args = parseArgs(argv);
  const rules = loadRules(args.rules);
  const paths = args.paths.length ? args.paths : readFileSync(0, 'utf8').split(/\0|\r?\n/).filter(Boolean);
  let pkgChanged = args.pkgChanged;
  if (pkgChanged === undefined && args.baseRef && paths.map(normalize).includes(rules.packageJson.path)) {
    pkgChanged = pkgChangedFromGit(args.baseRef, rules.packageJson.majorFields);
  }
  console.log(format(classify(paths, rules, { pkgChanged })));
}

module.exports = { ORDER, globToRegExp, tokensOf, loadRules, classifyPath, classify, pkgFieldsChanged, format };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`risk-class: ${e.message}`);
    process.exit(2);
  }
}
