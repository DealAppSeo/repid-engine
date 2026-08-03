/**
 * write-lease.ts — make a mid-sprint repo collision IMPOSSIBLE rather than discouraged.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY: THE MEASURED FAILURE
 * ════════════════════════════════════════════════════════════════════════════════
 * Parallel worktree agents editing shared files cross-contaminate. It has already
 * happened here on `config.ts` and `x402-real-settler.ts` — two lanes, one file, one
 * lane's work silently overwritten. This repo currently has ELEVEN live worktrees, six
 * of them holding branches from May through July.
 *
 * The capability fence in `lane-registry.ts` stops the wrong lane taking the wrong
 * TASK. It does nothing about two correctly-assigned lanes reaching for the same FILE
 * in the same hour. That is the actual blocker to running four lanes overnight, and no
 * amount of instruction fixes it: an agent that has been told to edit `pipeline.ts`
 * will edit `pipeline.ts`.
 *
 * So a lane LEASES paths, and a `PreToolUse` hook refuses the write. Not a convention —
 * a refusal, enforced outside the model's control by the harness.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHERE THE LEASES LIVE, AND WHY THAT EXACT PLACE
 * ════════════════════════════════════════════════════════════════════════════════
 * `git rev-parse --git-common-dir`. Verified: from any worktree this resolves to the
 * MAIN repo's `.git`, so every worktree of this repo sees ONE registry with no
 * configuration, while a different repo gets its own. And because it is inside `.git`
 * it can never be committed, staged by a stray `git add -A`, or land in a diff.
 *
 * A file in the working tree would have been wrong three ways: invisible across
 * worktrees, committable, and mergeable — a lease registry that can have merge
 * conflicts is a joke at its own expense.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE THREE PROPERTIES THAT MAKE IT SAFE TO TURN ON
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. LEASES EXPIRE. A crashed agent must not lock a path forever. An expired lease is
 *    ignored — never "cleaned up" by whoever notices, which would be a race. Liveness
 *    beats tidiness: the worst outcome of a short TTL is re-acquiring; the worst
 *    outcome of no TTL is a repo nobody can write to at 3am.
 *
 * 2. IT IS GRADUATED, so adopting it cannot brick the repo. No leases at all → allow
 *    everything (the system is not in use). A session with no lane → ADVISE, never
 *    block, so Sean is never locked out of his own repo by a robot's bookkeeping. A
 *    session WITH a lane → enforce.
 *
 * 3. OVERLAP DETECTION OVER-APPROXIMATES. `patternsMayOverlap` compares the literal
 *    prefix before the first wildcard, so it can report a conflict that could not
 *    actually happen — and can never MISS one that could. For a safety fence, a false
 *    conflict costs a conversation and a missed one costs a night's work.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type LaneId = string;

export interface WriteLease {
  lane: LaneId;
  /** Glob patterns, repo-relative, POSIX separators. */
  paths: string[];
  /** Branch the lane is working on. Informational — helps a human resolve a clash. */
  branch: string;
  /** One line on what this lease is for. Shown verbatim in a denial. */
  purpose: string;
  /** ISO timestamps. `expiresAt` is authoritative; see property 1 above. */
  acquiredAt: string;
  expiresAt: string;
}

export interface LeaseRegistry {
  version: 1;
  leases: WriteLease[];
}

export const EMPTY_REGISTRY: LeaseRegistry = { version: 1, leases: [] };

/**
 * Default lease lifetime: 4 hours.
 *
 * Long enough for a real overnight sprint stage without renewal chatter, short enough
 * that a crashed lane frees its paths inside one working session. Renew by re-acquiring.
 */
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export const LEASE_FILENAME = 'hyperdag-lane-leases.json';

/** Env var a lane sets to declare who it is. Absent → advisory mode (property 2). */
export const LANE_ENV = 'HYPERDAG_LANE';

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Minimal glob → RegExp: `**` (any depth), `*` (within one segment), `?` (one char).
 *
 * Hand-written rather than pulled from a dependency because this runs inside a
 * `PreToolUse` hook on every single file write. A hook that needs `node_modules`
 * resolution is a hook that fails in a fresh worktree, and a fence that fails open is
 * not a fence. Same reasoning as the resident-secret gate being plain CommonJS.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` consumes zero or more full segments; a bare `**` consumes anything.
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
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(out + '$');
}

/** Normalise any path to repo-relative POSIX form for matching. */
export function normalisePath(p: string, repoRoot?: string): string {
  let s = p.replace(/\\/g, '/');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
    // Case-insensitive on Windows, where the same path arrives with either drive case.
    if (s.toLowerCase().startsWith(root.toLowerCase() + '/')) s = s.slice(root.length + 1);
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '');
}

export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

/** The literal prefix of a pattern, up to the first wildcard. */
export function literalPrefix(pattern: string): string {
  const i = pattern.search(/[*?]/);
  const head = i === -1 ? pattern : pattern.slice(0, i);
  // Trim back to the last complete path segment so `src/ha` from `src/ha*` does not
  // look like the directory `src/ha`.
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut + 1);
}

/**
 * COULD these two patterns ever match the same file?
 *
 * Over-approximates on purpose (property 3). Two patterns conflict unless their literal
 * directory prefixes provably diverge.
 */
export function patternsMayOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

// ---------------------------------------------------------------------------
// Registry location + IO
// ---------------------------------------------------------------------------

/**
 * Absolute path to the shared registry, or null when not in a git repo.
 *
 * Returns null rather than throwing: the hook must degrade to "no leases" outside a
 * repo, not crash and block every write.
 */
export function registryPath(cwd: string = process.cwd()): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return common ? join(common, LEASE_FILENAME) : null;
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string = process.cwd()): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the registry. A malformed or unreadable file yields an EMPTY registry, not a
 * throw.
 *
 * This is the one place the fence deliberately fails OPEN, and the reason is that the
 * alternative is worse: a corrupt bookkeeping file must not be able to freeze every
 * write in the repository. The fence protects against accidental collision between
 * cooperating lanes; it is not a security boundary against a hostile actor who could
 * simply delete the file anyway.
 */
export function readRegistry(path: string | null): LeaseRegistry {
  if (!path || !existsSync(path)) return EMPTY_REGISTRY;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LeaseRegistry;
    if (!parsed || !Array.isArray(parsed.leases)) return EMPTY_REGISTRY;
    return { version: 1, leases: parsed.leases.filter(isWellFormed) };
  } catch {
    return EMPTY_REGISTRY;
  }
}

function isWellFormed(l: unknown): l is WriteLease {
  const c = l as WriteLease;
  return (
    !!c &&
    typeof c.lane === 'string' &&
    Array.isArray(c.paths) &&
    c.paths.every((p) => typeof p === 'string') &&
    typeof c.expiresAt === 'string'
  );
}

/** Atomic write — tmp + rename, so a concurrent reader never sees a half file. */
export function writeRegistry(path: string, reg: LeaseRegistry): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export function isExpired(lease: WriteLease, now: number): boolean {
  const t = Date.parse(lease.expiresAt);
  // An unparseable expiry counts as EXPIRED. A lease that cannot say when it ends
  // must not be able to hold a path forever.
  return !Number.isFinite(t) || t <= now;
}

export function activeLeases(reg: LeaseRegistry, now: number): WriteLease[] {
  return reg.leases.filter((l) => !isExpired(l, now));
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export interface AcquireResult {
  ok: boolean;
  lease: WriteLease | null;
  /** Active leases from OTHER lanes whose paths may overlap the request. */
  conflicts: WriteLease[];
  reason: string;
}

/**
 * Try to take a lease.
 *
 * Refuses if any ACTIVE lease from another lane may overlap. A lane re-acquiring its
 * own paths always succeeds — that is how renewal works, and how a lane that crashed
 * and restarted gets back to work without a human.
 */
export function acquireLease(
  reg: LeaseRegistry,
  req: { lane: LaneId; paths: string[]; branch: string; purpose: string; ttlMs?: number },
  now: number,
): AcquireResult {
  if (req.paths.length === 0) {
    return { ok: false, lease: null, conflicts: [], reason: 'a lease must name at least one path' };
  }

  const active = activeLeases(reg, now);
  const conflicts = active.filter(
    (l) => l.lane !== req.lane && l.paths.some((op) => req.paths.some((np) => patternsMayOverlap(op, np))),
  );

  if (conflicts.length > 0) {
    return {
      ok: false,
      lease: null,
      conflicts,
      reason:
        `paths overlap ${conflicts.length} active lease(s): ` +
        conflicts.map((c) => `${c.lane} holds ${c.paths.join(', ')} (${c.purpose})`).join('; '),
    };
  }

  const ttl = req.ttlMs ?? DEFAULT_TTL_MS;
  return {
    ok: true,
    conflicts: [],
    reason: `leased ${req.paths.length} path pattern(s) to ${req.lane}`,
    lease: {
      lane: req.lane,
      paths: [...req.paths],
      branch: req.branch,
      purpose: req.purpose,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    },
  };
}

/** Registry with this lane's leases replaced by `lease`, and expired ones dropped. */
export function withLease(reg: LeaseRegistry, lease: WriteLease, now: number): LeaseRegistry {
  return {
    version: 1,
    leases: [...activeLeases(reg, now).filter((l) => l.lane !== lease.lane), lease],
  };
}

/** Registry with this lane's leases removed, and expired ones dropped. */
export function withoutLane(reg: LeaseRegistry, lane: LaneId, now: number): LeaseRegistry {
  return { version: 1, leases: activeLeases(reg, now).filter((l) => l.lane !== lane) };
}

// ---------------------------------------------------------------------------
// The decision the hook makes
// ---------------------------------------------------------------------------

export type WriteVerdict = 'allow' | 'deny' | 'advise';

export interface WriteDecision {
  verdict: WriteVerdict;
  /** The lease that caused a deny/advise, when one did. */
  heldBy: WriteLease | null;
  /** Human-facing explanation. For a deny this is what the agent is told. */
  message: string;
}

/**
 * May `lane` write `file`?
 *
 * The graduation (property 2) is the whole of the safety argument, so it is spelled out
 * in the order the checks run:
 *
 *   - No active leases anywhere → ALLOW. The system is not in use; adopting this file
 *     changes nothing until someone takes a lease.
 *   - The file is leased by ANOTHER lane → DENY if we have a lane, ADVISE if we do not.
 *     A human at a terminal is never blocked by robot bookkeeping.
 *   - The file is leased by US → ALLOW.
 *   - The file is leased by nobody, but we hold a lease → ALLOW. A lease claims
 *     territory; it does not confine the holder to it. Confining would mean every
 *     incidental edit needs a new lease, and a fence that fires constantly gets
 *     switched off.
 */
export function evaluateWrite(args: {
  registry: LeaseRegistry;
  lane: LaneId | null;
  file: string;
  now: number;
}): WriteDecision {
  const active = activeLeases(args.registry, args.now);
  if (active.length === 0) {
    return { verdict: 'allow', heldBy: null, message: 'no active leases' };
  }

  const holder = active.find((l) => matchesAny(args.file, l.paths));
  if (!holder) {
    return { verdict: 'allow', heldBy: null, message: 'path is not leased' };
  }

  if (args.lane && holder.lane === args.lane) {
    return { verdict: 'allow', heldBy: holder, message: `leased to ${args.lane}` };
  }

  const detail =
    `${args.file} is leased by ${holder.lane} on branch ${holder.branch} ` +
    `until ${holder.expiresAt} — "${holder.purpose}"`;

  if (!args.lane) {
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
      `${detail}. You are ${args.lane}. Editing it would overwrite work in progress — ` +
      `this has already happened on config.ts and x402-real-settler.ts. Either work on a ` +
      `path your lane holds, or ask for the lease to be released.`,
  };
}

/** The lane for this session, or null. */
export function currentLane(): LaneId | null {
  const v = (process.env[LANE_ENV] ?? '').trim();
  return v.length > 0 ? v : null;
}
