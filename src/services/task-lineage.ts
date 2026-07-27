/**
 * L2 breaker 2.2 — lineage + depth budget (fork-bomb prevention).
 *
 * WHY: breakers 2.0/2.1/2.3 govern VOLUME and CLASS. None of them bounds the
 * shape that actually explodes: a spawner whose children spawn children. A
 * fork bomb three generations deep can sit under every volume threshold for a
 * while and then go vertical. This breaker bounds the tree by DEPTH, which is
 * the property a volume breaker cannot see until the volume already exists
 * (AUTONOMOUS_LOOP_CONTRACT — breakers "before ramping producers").
 *
 * ── ZERO DDL, AND THAT IS THE HEADLINE ────────────────────────────────────
 * The backlog item asks for new `lineage_id` + `depth` columns.
 * `trinity_tasks` ALREADY HAS THE PAIR, under different names, and they are
 * already populated by upstream producers [V sql:2026-07-27]:
 *   parent_task_id  bigint  NULL         — the lineage edge   (50,123 rows set)
 *   generation      integer DEFAULT 0    — the depth          (max observed: 1)
 *   spawned_count   integer DEFAULT 0    — fan-out counter    (77 rows > 0)
 * of 362,974 total rows. Adding a second, parallel pair to a table with 26
 * inbound FKs would have created two competing lineage conventions and a
 * migration nobody could ever finish. So this module is a pure application
 * layer over the columns that exist. Verify before extending:
 *   SELECT count(*), max(generation) FROM trinity_tasks WHERE parent_task_id IS NOT NULL;
 *
 * WHAT: one place that (a) derives a child's lineage fields from its parent and
 * (b) refuses a spawn whose depth would exceed the budget.
 *
 *   deriveLineage(parent)      → { parent_task_id, generation } to spread into an insert
 *   checkDepthBudget(depth)    → { exceeded, halted, mode, reason }
 *   guardedLineage(parent)     → both at once, for a chokepoint
 *
 * MODE: LINEAGE_DEPTH_MODE = off | shadow | enforce  (default: ENFORCE).
 *   off     — disabled; lineage still derived, never refused.
 *   shadow  — log what WOULD be refused, but spawn anyway.
 *   enforce — refuse the spawn (caller returns 400 / skips the cycle).
 *
 * WHY ENFORCE BY DEFAULT, against this repo's shadow-first habit: the default
 * is provably INERT on current traffic. The budget is 5 and the deepest task
 * that has EVER existed is generation 1 [V]. Nothing live can trip it, so
 * "calibrate in shadow first" would be calibrating against a signal that does
 * not exist — while leaving the guard off for the one event it is built for,
 * which arrives without warning. Same reasoning as the emergency-halt switch:
 * a safety lever that also needs an env var set is two levers.
 *
 * OFF-BY-ONE, STATED RATHER THAN IMPLIED: `generation` is 0-based (a root task
 * is generation 0). The budget is a CEILING ON THE STORED VALUE — with
 * LINEAGE_MAX_DEPTH=5, generation 5 is allowed and generation 6 is refused, so
 * `MAX(generation) <= 5` holds. This matches the backlog's acceptance criterion
 * ("5-deep succeeds; depth 6 → 400; MAX(depth)≤5") literally.
 *
 * FAIL-SAFE: this only ever REFUSES a spawn, never creates one. Worst case of a
 * mis-set budget is deferred work (recoverable by raising it), never extra work.
 *
 * FAIL-CLOSED ON A MALFORMED DEPTH — the inverse of breaker 2.0, deliberately.
 * 2.0 fails OPEN because its input is a live count query that can be flaky, and
 * wedging every producer on a flaky count is worse than the backlog it misses.
 * This breaker's input is a value read off a row. A depth that is negative,
 * non-integer, NaN, Infinity or a string of garbage is not a flaky read — it is
 * either corruption or someone handing us a crafted parent, and BOTH are cases
 * where letting the spawn through is how a fork bomb gets its first free level.
 * A missing/null depth is NOT malformed: it means root (0), which is exactly
 * what the column default says.
 *
 * FAIL-LOUD: callers log every refusal/would-refuse.
 *
 * ── KNOWN GAP, MEASURED, NOT PAPERED OVER ─────────────────────────────────
 * The one recursion this system actually has — a peer-verify task whose output
 * is itself enqueued for peer verification — CANNOT be depth-bounded from the
 * engine today, because the lineage chain is broken at the queue hop:
 * `peer_verification_queue` has NO task reference at all (columns enumerated
 * 2026-07-27: id, source_response_id, source_agent_id, certainty_at_claim,
 * verification_status, verifier_agent_id, verifier_response_id,
 * verifier_signature, created_at, completed_at, threshold_used, claim_text) and
 * `source_response_id` carries no foreign key. So a peer_verify spawn genuinely
 * does not know which task produced the claim, and this module correctly
 * records it as a ROOT rather than inventing a parent.
 * Closing it needs the UPSTREAM producer (trinity-symphony-shared, where the
 * response is written) to carry the originating task id into the queue row —
 * a column here that nothing can populate would be worse than the honest gap.
 * Until then breaker 2.3 (self-referential work ban) is what bounds that loop;
 * this breaker bounds every OTHER spawn path.
 */

export type LineageMode = 'off' | 'shadow' | 'enforce';

/** The two existing `trinity_tasks` columns, ready to spread into an insert. */
export interface LineageFields {
  parent_task_id: number | null;
  generation: number;
}

/** What a chokepoint knows about the parent it is spawning from. */
export interface LineageParent {
  /** `trinity_tasks.id` (BIGINT). Null/absent when the id is not to hand. */
  id?: number | string | null;
  /** the parent's `generation`. Absent/null means the parent is a root. */
  generation?: unknown;
}

export interface DepthDecision {
  /** the child's depth we evaluated. */
  depth: number;
  maxDepth: number;
  /** the budget was exceeded (independent of mode). */
  exceeded: boolean;
  /** exceeded AND mode==='enforce' — the caller must actually refuse. */
  halted: boolean;
  mode: LineageMode;
  /** the parent's depth was unusable and we fell back to fail-closed. */
  malformed: boolean;
  /** why it tripped (or why it didn't) — for the fail-loud log. */
  reason: string;
}

/**
 * The value a malformed parent depth resolves to. Deliberately not `Infinity`:
 * it has to survive `JSON.stringify` in a log line, and it has to be a number a
 * reader recognises as "we refused because we could not read the depth" rather
 * than "the tree really was that deep".
 */
export const MALFORMED_DEPTH = Number.MAX_SAFE_INTEGER;

/** Parse LINEAGE_DEPTH_MODE. Default ENFORCE (see header). Pure. */
export function lineageMode(
  env: string | null | undefined = process.env.LINEAGE_DEPTH_MODE,
): LineageMode {
  const m = (env || 'enforce').trim().toLowerCase();
  return m === 'off' || m === 'shadow' ? (m as LineageMode) : 'enforce';
}

/**
 * Resolve LINEAGE_MAX_DEPTH. Default 5, floored at 1 — a budget of 0 would
 * refuse every root task and park the entire system, which is a footgun a
 * fat-fingered env var must not be able to fire.
 */
export function lineageMaxDepth(
  env: string | null | undefined = process.env.LINEAGE_MAX_DEPTH,
): number {
  const n = Number(env);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : 5;
}

/**
 * Read a parent's `generation` into a usable depth.
 * - null/undefined/'' → 0 (root; matches the column's DEFAULT 0)
 * - a non-negative integer (or its exact string form) → that value
 * - anything else → MALFORMED_DEPTH, malformed=true (fail closed; see header)
 */
export function parseParentDepth(raw: unknown): { depth: number; malformed: boolean } {
  if (raw === null || raw === undefined) return { depth: 0, malformed: false };
  // TYPE GATE BEFORE COERCION, and it is load-bearing: `String([])` is `''` and
  // `Number('')` is 0, so an array-valued generation would have coerced clean
  // through to ROOT — a fail-OPEN hole in the middle of a fail-closed parser,
  // and exactly the laundering this breaker exists to stop. Only a number or a
  // string is a depth; booleans, arrays, objects and functions are malformed.
  // (Found by this module's own test suite before merge, not in review.)
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { depth: MALFORMED_DEPTH, malformed: true };
  }
  if (typeof raw === 'string' && raw.trim() === '') return { depth: 0, malformed: false };
  const n = typeof raw === 'number' ? raw : Number(raw.trim());
  if (Number.isSafeInteger(n) && n >= 0) return { depth: n, malformed: false };
  return { depth: MALFORMED_DEPTH, malformed: true };
}

/** Coerce a parent id to the BIGINT-as-number the column takes, or null. */
function parseParentId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Derive the child's lineage fields from its parent.
 *
 * A null/absent parent yields a ROOT: `{ parent_task_id: null, generation: 0 }`.
 *
 * NOTE the deliberate asymmetry: an unknown parent ID does NOT reset the depth.
 * If a caller knows the parent's generation but not its row id, the child is
 * still generation+1. Resetting to 0 on a missing id would hand any spawner a
 * one-line way to launder its depth away, which is precisely the bypass this
 * breaker exists to prevent.
 *
 * A malformed parent depth propagates as MALFORMED_DEPTH so the guard refuses;
 * it is never silently written to the DB, because `guardedLineage` refuses
 * first and `deriveLineage`'s output is only used on the allowed path.
 */
export function deriveLineage(parent?: LineageParent | null): LineageFields {
  if (!parent) return { parent_task_id: null, generation: 0 };
  const { depth, malformed } = parseParentDepth(parent.generation);
  return {
    parent_task_id: parseParentId(parent.id),
    generation: malformed ? MALFORMED_DEPTH : depth + 1,
  };
}

/** The lineage of a task with no parent. Explicit beats implicit at a chokepoint. */
export function rootLineage(): LineageFields {
  return { parent_task_id: null, generation: 0 };
}

/**
 * Pure decision: is a child at this depth within budget?
 * Exceeded when `depth > maxDepth` (see the off-by-one note in the header).
 */
export function checkDepthBudget(
  depth: number,
  opts: { mode?: LineageMode; maxDepth?: number; malformed?: boolean } = {},
): DepthDecision {
  const mode = opts.mode ?? lineageMode();
  const maxDepth = opts.maxDepth ?? lineageMaxDepth();
  const malformed = opts.malformed ?? depth === MALFORMED_DEPTH;

  if (mode === 'off') {
    return {
      depth, maxDepth, exceeded: false, halted: false, mode, malformed,
      reason: 'mode=off',
    };
  }

  const exceeded = malformed || depth > maxDepth;
  const reason = malformed
    ? 'parent depth unreadable — refusing (fail-closed)'
    : exceeded
      ? `depth ${depth} > budget ${maxDepth}`
      : `ok: depth ${depth} <= budget ${maxDepth}`;

  return { depth, maxDepth, exceeded, halted: exceeded && mode === 'enforce', mode, malformed, reason };
}

/**
 * The chokepoint call: derive the child's lineage AND decide whether it is
 * allowed. Spread `fields` into the insert only when `decision.halted` is false.
 */
export function guardedLineage(
  parent?: LineageParent | null,
  opts: { mode?: LineageMode; maxDepth?: number } = {},
): { fields: LineageFields; decision: DepthDecision } {
  const fields = deriveLineage(parent);
  const malformed = fields.generation === MALFORMED_DEPTH;
  const decision = checkDepthBudget(fields.generation, { ...opts, malformed });
  return { fields, decision };
}

/** One-line fail-loud log body. `halted` vs `WOULD refuse` is the whole point. */
export function formatLineageLog(prefix: string, d: DepthDecision): string {
  const verb = d.halted ? 'REFUSED' : d.exceeded ? 'WOULD refuse' : 'allowed';
  const shown = d.malformed ? 'malformed' : String(d.depth);
  return `${prefix} lineage depth ${verb} (depth=${shown} budget=${d.maxDepth} mode=${d.mode}; ${d.reason}) (breaker 2.2)`;
}
