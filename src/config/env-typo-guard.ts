import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { KNOWN_ENV_VARS } from './known-env-vars.generated';
import { SURFACE_ENV_NAMES } from '../resilience/decision-contract';

/**
 * The registry the guard actually checks against: the statically-discovered
 * names PLUS the ones this codebase composes at runtime and static analysis
 * therefore cannot see. The generated file's header declares that gap accepted;
 * this closes the part of it we can enumerate from a canonical list rather than
 * a hand-written one, so it cannot drift out of date on its own.
 */
export const ALL_KNOWN_ENV_VARS: readonly string[] = [
  ...KNOWN_ENV_VARS,
  ...SURFACE_ENV_NAMES,
];

/**
 * A `??`-style default cannot distinguish "unset" from "misspelled" — both
 * read as absent from inside the process. This is a warn-only boot check:
 * if a set env var is a near-miss (small edit distance) of a name this
 * codebase actually reads, and that real name is unset, say so loudly.
 * It must never fail or delay boot — a stray variable is not worth refusing
 * to start over.
 */
export interface EnvTypoWarning {
  set: string;
  suggested: string;
  distance: number;
}

// Short names collide too easily under edit distance (e.g. "CI" vs "AI").
// Only compare names long enough that a 1-2 edit distance is meaningfully
// "close" rather than coincidental, and scale the threshold with length.
const MIN_NAME_LENGTH = 5;

function maxDistanceFor(name: string): number {
  return name.length >= 8 ? 2 : 1;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? Infinity) + 1,
        (curr[j - 1] ?? Infinity) + 1,
        (prev[j - 1] ?? Infinity) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? m;
}

export function findEnvTypos(
  setNames: readonly string[] = Object.keys(process.env),
  knownNames: readonly string[] = ALL_KNOWN_ENV_VARS,
): EnvTypoWarning[] {
  const known = new Set(knownNames);
  const setSet = new Set(setNames);
  const warnings: EnvTypoWarning[] = [];

  for (const set of setNames) {
    if (known.has(set)) continue; // exact match, nothing to suggest

    let best: EnvTypoWarning | null = null;
    for (const candidate of knownNames) {
      if (candidate.length < MIN_NAME_LENGTH) continue;
      if (setSet.has(candidate)) continue; // canonical name is itself set — not silently defaulted
      if (Math.abs(candidate.length - set.length) > 2) continue; // cheap pre-filter

      const distance = levenshtein(set, candidate);
      if (distance <= maxDistanceFor(candidate) && (!best || distance < best.distance)) {
        best = { set, suggested: candidate, distance };
      }
    }
    if (best) warnings.push(best);
  }

  return warnings;
}

export function warnEnvTypos(): void {
  const warnings = findEnvTypos();
  for (const w of warnings) {
    console.warn(
      `[config] ${w.set} is set, but nothing reads it. Did you mean ${w.suggested}? (that one is UNSET, using its default)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Unread names: every set variable that no shipped code names at all.
//
// The typo check above only speaks when a set name is CLOSE to a real one, so a
// stale name that resembles nothing passes in silence (on 2026-11-10 one service
// held about 20 such names). This prints them all,
// once per boot, off the boot path. Names only: no value is ever read.
//
// "Named" is deliberately generous: any SCREAMING_SNAKE token anywhere in the
// shipped code (compiled src and the scripts the cron services run, comments
// included), plus the registry. A name that is only in a comment counts as read.
// That errs toward silence, never toward telling the owner to delete a live
// variable. Two gaps remain, and the line names both: a name built at runtime,
// and a name only a library reads (node_modules is not scanned).

/** Names the platform injects. One missing here shows up as noise, not as a hidden name. */
const PLATFORM_NAME_RE =
  /^(RAILWAY|NIXPACKS|NPM|NODE|LC|XDG|GIT)_|^(_|PATH|HOME|HOSTNAME|PWD|OLDPWD|SHLVL|TERM|LANG|TZ|USER|SHELL|LD_LIBRARY_PATH|CI|DEBIAN_FRONTEND)$/i;

/** Anything else is counted, never printed: a name is not a value, but an odd one could hold one. */
const PLAIN_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** src/config.ts refuses to boot without it, so a scan that cannot see it saw nothing. */
const SCAN_CONTROL = 'SUPABASE_URL';

const TOKEN_RE = /\b[A-Z][A-Z0-9_]+\b/g;
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);
// This file and the registry are skipped: both spell SCAN_CONTROL, so scanning them would satisfy the
// control on a tree with no other code (Strix, #1529). The registry is unioned separately below.
const SELF_FILE_RE = /^(env-typo-guard|known-env-vars\.generated)\./;

export async function scanNamedTokens(roots: readonly string[]): Promise<Set<string>> {
  const named = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.isSymbolicLink() || SELF_FILE_RE.test(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (CODE_EXT.has(extname(e.name))) {
        const text = await readFile(p, 'utf8').catch(() => '');
        for (const m of text.match(TOKEN_RE) ?? []) named.add(m);
      }
    }
  };
  for (const r of roots) await walk(r);
  return named;
}

export function unreadEnvReport(setNames: readonly string[], named: ReadonlySet<string>): string {
  if (!named.has(SCAN_CONTROL)) {
    return `[config] unread-variable check NOT_CHECKED: the code scan did not find ${SCAN_CONTROL}, which this service always reads, so it cannot say any name is absent.`;
  }
  const known = new Set(ALL_KNOWN_ENV_VARS);
  const platform = setNames.filter((n) => PLATFORM_NAME_RE.test(n)).length;
  const unread = setNames.filter((n) => !PLATFORM_NAME_RE.test(n) && !known.has(n) && !named.has(n));
  const plain = unread.filter((n) => PLAIN_NAME_RE.test(n)).sort();
  const odd = unread.length - plain.length;
  if (!unread.length) {
    return `[config] no set variable is unread: all ${setNames.length - platform} non-platform names appear in this repo's code (${platform} platform names skipped).`;
  }
  const oddNote = odd ? ` Plus ${odd} name(s) in an unusual format, not printed.` : '';
  return (
    `[config] ${plain.length} set variable(s) that this repo's code never names: ${plain.join(', ') || 'none'}.${oddNote}` +
    ' Names only, values are never read. Libraries and names built at runtime are not seen, so check before deleting.'
  );
}

/** dist/config -> dist (src/config -> src under ts-node), plus the repo's scripts/. */
export function defaultScanRoots(): string[] {
  const codeRoot = resolve(__dirname, '..');
  return [codeRoot, resolve(codeRoot, '..', 'scripts')];
}

/** Fire-and-forget. Never throws, never blocks boot. */
export function reportUnreadEnvNames(roots: readonly string[] = defaultScanRoots()): Promise<void> {
  return scanNamedTokens(roots)
    .then((named) => console.warn(unreadEnvReport(Object.keys(process.env), named)))
    .catch((e) => console.warn(`[config] unread-variable check NOT_CHECKED: ${e?.message ?? e}`));
}
