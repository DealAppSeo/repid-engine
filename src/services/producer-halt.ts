/**
 * L2 breaker 2.1 — producer kill-switch (drain-only halt).
 *
 * WHY: the anti-fragile floor requires a manual lever that instantly stops a
 * runaway *producer* (a spawner that turns one unit of work into many) WITHOUT
 * stopping *draining* (workers finishing the tasks already in flight). Breaker
 * 2.3 structurally bans the specific peer-verify recursion; this is the general
 * operational off-switch to reach for before ramping any producer, or if a class
 * of spawns misbehaves after restart (AUTONOMOUS_LOOP_CONTRACT — "kill-switch
 * before ramping producers"). It is the manual complement to the automatic
 * birth-rate / lineage breakers.
 *
 * WHAT: an env-gated, per-class skip at every enqueue/spawn chokepoint. When a
 * task class is halted, no NEW task of that class is spawned; tasks already
 * queued still drain normally. Zero DDL — a pure env lever, so it can be flipped
 * on Railway without a code deploy and is instantly reversible (unset → resume).
 *
 * LEVER: PRODUCER_HALT_CLASSES = comma-separated task classes to halt.
 *   ""            (unset)  — nothing halted; legacy behavior (DEFAULT).
 *   "peer_verify"          — halt only peer-verification spawns.
 *   "peer_verify,foo"      — halt several classes.
 *   "all" or "*"           — global producer halt (drain-only everything).
 * Case-insensitive; surrounding whitespace ignored.
 *
 * FAIL-SAFE: this only ever SKIPS a spawn, never adds one — the worst case of a
 * mis-set value is that useful work is deferred (recoverable by unsetting), never
 * that extra work is created.
 * FAIL-LOUD: callers log the suppression so a halt is never silent.
 */

/** Wildcard tokens that halt every producer class. */
const HALT_ALL = new Set(['all', '*']);

/**
 * Parse the PRODUCER_HALT_CLASSES value into a normalized set of halted class
 * names (lowercased, trimmed, empties dropped). Pure — takes the raw string so
 * it is trivially testable without touching process.env.
 */
export function parseHaltClasses(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * True when producers of `taskClass` are currently halted. Reads
 * process.env.PRODUCER_HALT_CLASSES at call time (matching this repo's other
 * env-flag conventions, e.g. prefilterMode()), so the lever takes effect without
 * a logic redeploy. Pass `env` explicitly in tests.
 *
 * A halt set containing "all"/"*" halts every class.
 */
export function isProducerHalted(
  taskClass: string,
  env: string | null | undefined = process.env.PRODUCER_HALT_CLASSES,
): boolean {
  const halted = parseHaltClasses(env);
  if (halted.size === 0) return false;
  for (const token of halted) {
    if (HALT_ALL.has(token)) return true;
  }
  return halted.has((taskClass ?? '').trim().toLowerCase());
}
