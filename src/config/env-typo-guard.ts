import { KNOWN_ENV_VARS } from './known-env-vars.generated';

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
  knownNames: readonly string[] = KNOWN_ENV_VARS,
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
