#!/usr/bin/env node
/**
 * lane-write-guard.js — the PreToolUse hook that actually refuses the write.
 *
 * `src/orchestration/write-lease.ts` decides; this executes. Register it on
 * Edit / Write / NotebookEdit and a lane physically cannot edit a file another lane has
 * leased. Exit 2 is the harness's blocking signal, and stderr is fed back to the model,
 * so the denial explains itself and the agent can pick different work.
 *
 * PLAIN COMMONJS, NO IMPORTS FROM src/, NO DEPENDENCIES. This is deliberate and it is
 * the difference between a fence and a decoration:
 *   - it must run in a fresh worktree with no `npm install`;
 *   - it must run with no build step, because `dist/` is stale exactly when someone is
 *     mid-refactor, which is exactly when collisions happen;
 *   - anything it needs to require is a way for it to fail, and a fence that fails is
 *     a fence that fails OPEN.
 * The lease logic is therefore duplicated here in ~40 lines, and a test asserts the two
 * implementations agree on every case. Duplication with an equivalence test beats a
 * dependency that can break at the worst moment.
 *
 * FAILS OPEN, ON PURPOSE. Any error — unparseable stdin, no git, corrupt registry —
 * exits 0 and allows the write. This protects cooperating lanes from stepping on each
 * other; it is not a security boundary, and a hostile actor could delete the registry
 * anyway. Freezing every write in the repo because a JSON file got truncated would be a
 * far worse failure than the one being prevented.
 *
 * Register in .claude/settings.json:
 *   { "hooks": { "PreToolUse": [ {
 *       "matcher": "Edit|Write|NotebookEdit",
 *       "hooks": [ { "type": "command",
 *                    "command": "node scripts/hooks/lane-write-guard.js" } ] } ] } }
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const LEASE_FILENAME = 'hyperdag-lane-leases.json';
const LANE_ENV = 'HYPERDAG_LANE';

// --- the duplicated core (kept equivalent to write-lease.ts by test) ---------

function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + '$');
}

function normalisePath(p, repoRoot) {
  let s = String(p).replace(/\\/g, '/');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (s.toLowerCase().startsWith(root.toLowerCase() + '/')) s = s.slice(root.length + 1);
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '');
}

function isExpired(lease, now) {
  const t = Date.parse(lease.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

function evaluateWrite({ registry, lane, file, now }) {
  const active = (registry.leases || []).filter((l) => !isExpired(l, now));
  if (active.length === 0) return { verdict: 'allow', heldBy: null, message: 'no active leases' };

  const holder = active.find((l) => l.paths.some((p) => globToRegExp(p).test(file)));
  if (!holder) return { verdict: 'allow', heldBy: null, message: 'path is not leased' };
  if (lane && holder.lane === lane) {
    return { verdict: 'allow', heldBy: holder, message: `leased to ${lane}` };
  }

  const detail =
    `${file} is leased by ${holder.lane} on branch ${holder.branch} ` +
    `until ${holder.expiresAt} — "${holder.purpose}"`;

  if (!lane) {
    return {
      verdict: 'advise',
      heldBy: holder,
      message:
        `${detail}. No ${LANE_ENV} is set for this session, so this is a warning, not a ` +
        `block — but another lane is mid-sprint in this file.`,
    };
  }

  return {
    verdict: 'deny',
    heldBy: holder,
    message:
      `${detail}. You are ${lane}. Editing it would overwrite work in progress — ` +
      `this has already happened on config.ts and x402-real-settler.ts. Either work on a ` +
      `path your lane holds, or ask for the lease to be released.`,
  };
}

// --- plumbing ---------------------------------------------------------------

/**
 * Run git, falling back to the process cwd if the supplied one is unusable.
 *
 * WHY THE FALLBACK EXISTS — caught in testing, and it is the exact failure this whole
 * file warns about. A payload carrying a POSIX-style cwd (`/c/Users/...`) makes
 * `execFileSync` fail to chdir on Windows, `git` never runs, and the guard exits 0.
 * The fence had SILENTLY DISABLED ITSELF while looking healthy — a collision would
 * have gone straight through with no denial and no warning.
 *
 * One unusable input must degrade to a second attempt, not to no enforcement.
 */
function git(args, cwd) {
  for (const dir of [cwd, process.cwd()]) {
    if (!dir) continue;
    try {
      const out = execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open
  }

  const filePath =
    payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path ?? payload?.tool_input?.path;
  if (!filePath) process.exit(0);

  const cwd = payload?.cwd || process.cwd();
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!commonDir) process.exit(0);

  const leasePath = join(commonDir, LEASE_FILENAME);
  if (!existsSync(leasePath)) process.exit(0);

  let registry;
  try {
    registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (!registry || !Array.isArray(registry.leases)) process.exit(0);
  } catch {
    process.exit(0); // corrupt registry must not freeze the repo
  }

  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const file = normalisePath(filePath, root || undefined);
  const lane = (process.env[LANE_ENV] || '').trim() || null;

  const d = evaluateWrite({ registry, lane, file, now: Date.now() });

  if (d.verdict === 'deny') {
    process.stderr.write(`BLOCKED by lane write-lease fence: ${d.message}\n`);
    process.exit(2);
  }
  if (d.verdict === 'advise') {
    process.stderr.write(`⚠ lane write-lease: ${d.message}\n`);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // never let the guard itself break a session
}
