#!/usr/bin/env node
/**
 * lane.js — take, list, and release write leases.
 *
 * The fence is worthless without a one-line way to claim territory, so this is
 * deliberately blunt:
 *
 *   node scripts/lane.js claim GA "src/hal/**" "tests/hal/**" --purpose "HAL precision"
 *   node scripts/lane.js list
 *   node scripts/lane.js release GA
 *   node scripts/lane.js check GA src/hal/fact-check.ts
 *
 * `claim` refuses when another ACTIVE lease may overlap, and prints who holds what so
 * the clash is resolved by a human sentence rather than by a silent overwrite.
 *
 * Plain CommonJS with no dependencies, same reasoning as the hook: this has to work in
 * a fresh worktree with no install and no build.
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');

const LEASE_FILENAME = 'hyperdag-lane-leases.json';
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function leasePath() {
  return join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), LEASE_FILENAME);
}

function read(p) {
  if (!existsSync(p)) return { version: 1, leases: [] };
  try {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    return r && Array.isArray(r.leases) ? r : { version: 1, leases: [] };
  } catch {
    return { version: 1, leases: [] };
  }
}

function write(p, reg) {
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

const expired = (l, now) => {
  const t = Date.parse(l.expiresAt);
  return !Number.isFinite(t) || t <= now;
};

function literalPrefix(pattern) {
  const i = pattern.search(/[*?]/);
  const head = i === -1 ? pattern : pattern.slice(0, i);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut + 1);
}

const mayOverlap = (a, b) => {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
};

function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$');
}

const now = Date.now();
const p = leasePath();
const reg = read(p);
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'list') {
  const active = reg.leases.filter((l) => !expired(l, now));
  const stale = reg.leases.length - active.length;
  if (active.length === 0) {
    console.log('no active leases' + (stale ? ` (${stale} expired, ignored)` : ''));
    process.exit(0);
  }
  for (const l of active) {
    const mins = Math.round((Date.parse(l.expiresAt) - now) / 60000);
    console.log(`${l.lane.padEnd(6)} ${String(mins).padStart(4)}m left  ${l.branch}`);
    console.log(`       ${l.paths.join('  ')}`);
    console.log(`       "${l.purpose}"`);
  }
  if (stale) console.log(`(${stale} expired lease(s) ignored — they free themselves)`);
  process.exit(0);
}

if (cmd === 'claim') {
  const lane = args[1];
  const pi = args.indexOf('--purpose');
  const purpose = pi > -1 ? args[pi + 1] : '(no purpose given)';
  const ti = args.indexOf('--ttl-min');
  const ttl = ti > -1 ? Number(args[ti + 1]) * 60000 : DEFAULT_TTL_MS;
  const paths = args
    .slice(2)
    .filter((a, i) => !a.startsWith('--') && args[i + 1] !== undefined)
    .filter((a) => a !== purpose && a !== (ti > -1 ? args[ti + 1] : null));

  if (!lane || paths.length === 0) {
    console.error('usage: lane.js claim <LANE> <path-glob>... [--purpose "..."] [--ttl-min N]');
    process.exit(2);
  }

  const active = reg.leases.filter((l) => !expired(l, now));
  const conflicts = active.filter(
    (l) => l.lane !== lane && l.paths.some((op) => paths.some((np) => mayOverlap(op, np))),
  );
  if (conflicts.length) {
    console.error(`REFUSED: ${conflicts.length} active lease(s) may overlap:`);
    for (const c of conflicts) console.error(`  ${c.lane}: ${c.paths.join(', ')} — "${c.purpose}"`);
    console.error('Resolve it with a sentence, not an overwrite. Narrow your paths or wait.');
    process.exit(1);
  }

  const branch = (() => {
    try { return git(['branch', '--show-current']) || 'detached'; } catch { return 'unknown'; }
  })();

  const lease = {
    lane, paths, branch, purpose,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
  write(p, { version: 1, leases: [...active.filter((l) => l.lane !== lane), lease] });
  console.log(`${lane} holds ${paths.length} pattern(s) for ${Math.round(ttl / 60000)}m on ${branch}`);
  console.log(`Set HYPERDAG_LANE=${lane} in the lane's session or the fence will only advise.`);
  process.exit(0);
}

if (cmd === 'release') {
  const lane = args[1];
  if (!lane) { console.error('usage: lane.js release <LANE>'); process.exit(2); }
  const kept = reg.leases.filter((l) => !expired(l, now) && l.lane !== lane);
  write(p, { version: 1, leases: kept });
  console.log(`released ${lane}`);
  process.exit(0);
}

if (cmd === 'check') {
  const lane = args[1] || null;
  const file = args[2];
  if (!file) { console.error('usage: lane.js check <LANE|-> <file>'); process.exit(2); }
  const active = reg.leases.filter((l) => !expired(l, now));
  const holder = active.find((l) => l.paths.some((g) => globToRegExp(g).test(file)));
  if (!holder) console.log(`allow — ${file} is not leased`);
  else if (lane && lane !== '-' && holder.lane === lane) console.log(`allow — leased to ${lane}`);
  else console.log(`${lane && lane !== '-' ? 'DENY' : 'advise'} — held by ${holder.lane}: "${holder.purpose}"`);
  process.exit(0);
}

console.error('usage: lane.js <claim|list|release|check> ...');
process.exit(2);
