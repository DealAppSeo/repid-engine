/**
 * Deterministic verify leg for `trinity_tasks`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `trinity_tasks` has carried `verification_method` / `verifier_verdict` /
 * `final_verdict` / `verified_output` since long before this file. All four are
 * cold: 0 non-null rows out of 362,965 all-time (measured 2026-07-27). Nothing
 * in this repo has ever written them. That is Pattern G — designed, shipped into
 * the schema, never wired — and its cost was measured: the nightly
 * `[E2E-SMOKE nightly]` task produced 18 runs and not one real measurement, yet
 * every one was `done` and RepID-bridged, because nothing downstream could tell
 * a measurement from a narration. See
 * `reports/2026-07-27/BEAT30_SWARM_ARTIFACT_FABRICATION_AUDIT.md`.
 *
 * This module is the missing leg for the task classes where a check needs no
 * tools at all: the task ships a machine-checkable contract in `expected_output`,
 * and the result is graded against it by code, not by an agent's say-so.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * - It is NOT peer verification, and it never touches `repid_verified`. That
 *   column means "an INDEPENDENT AGENT checked this and it passed"
 *   (`trinity-task-bridge.ts`), and a deterministic checker is not an agent.
 *   The two signals stay separable: this leg stamps
 *   `verification_method = 'deterministic-v1'`, so any consumer can filter.
 * - It NEVER invents a verdict for a task that shipped no contract. No contract
 *   → this returns null → the columns stay NULL. "Unverified" is the honest
 *   state for most rows and it stays that way.
 * - It refuses to grade a contract that cannot fail. A contract made only of
 *   assertions that can reject but never confirm (`min_length`, `contains_none`)
 *   yields `unclear`/`unverified`, not `approved`. A check that cannot fail
 *   proves nothing; a check that cannot confirm must not be read as confirming.
 *
 * DB VOCABULARY IS NOT FREE-FORM — this bit is load-bearing.
 * Both verdict columns carry CHECK constraints in prod (read 2026-07-27):
 *   trinity_tasks_verifier_verdict_check:
 *     verifier_verdict IS NULL OR verifier_verdict = ANY (ARRAY['approved','rejected','unclear'])
 *   trinity_tasks_final_verdict_check:
 *     final_verdict IS NULL OR final_verdict = ANY (ARRAY['verified_done','disputed_done','rejected','unverified','spot_audited'])
 * Writing 'pass' / 'verified' / 'fail' — the vocabulary the pre-existing bridge
 * test asserted against — raises 23514 on every write. The constants below are
 * the constraint, transcribed once, and a test pins every emitted value to them.
 */

import { matchWithBudget } from './regex-budget';

/** Exactly the values `trinity_tasks_verifier_verdict_check` permits. */
export const VERIFIER_VERDICTS = ['approved', 'rejected', 'unclear'] as const;
export type VerifierVerdict = (typeof VERIFIER_VERDICTS)[number];

/** Exactly the values `trinity_tasks_final_verdict_check` permits. */
export const FINAL_VERDICTS = [
  'verified_done',
  'disputed_done',
  'rejected',
  'unverified',
  'spot_audited',
] as const;
export type FinalVerdict = (typeof FINAL_VERDICTS)[number];

/** Stamped into `verification_method` so a deterministic pass is never mistaken for a peer pass. */
export const VERIFY_METHOD = 'deterministic-v1';

export type VerifyLegMode = 'off' | 'shadow' | 'enforce';

/**
 * Resolve `TASK_VERIFY_LEG_MODE`. Fail-safe: anything unrecognised — a typo, an
 * empty string, an unset var — resolves to `off`. The failure mode this guards
 * is `MODE=enfroce` silently behaving like `enforce`; it behaves like `off`.
 */
export function resolveVerifyLegMode(raw = process.env.TASK_VERIFY_LEG_MODE): VerifyLegMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === 'enforce') return 'enforce';
  return 'off';
}

/**
 * Markers that are, on their face, not a measurement. Every one of these was
 * observed in a swarm artifact that had been graded `done` (Beat 30 audit):
 * `abc123` was emitted as a 40-hex commit sha by six agents on six nights.
 */
export const PLACEHOLDER_MARKERS = [
  'abc123',
  'lorem ipsum',
  'your-value-here',
  'todo:',
  'tbd',
  'xxx',
  '<sha>',
  '<insert',
  'placeholder',
  '[...]',
  '...redacted...',
  'example.com/artifact',
] as const;

/** Assertions that can CONFIRM a claim. A contract needs at least one. */
const SUBSTANTIVE_KINDS = ['matches', 'contains_all', 'json_keys'] as const;
/** Assertions that can only REJECT. Necessary, never sufficient. */
const NEGATIVE_KINDS = ['contains_none', 'min_length', 'no_placeholders'] as const;

const KNOWN_KINDS: readonly string[] = [...SUBSTANTIVE_KINDS, ...NEGATIVE_KINDS];

/** Bounds. The bridge polls every 30 s; a pathological pattern must not park it. */
const MAX_PATTERN_LEN = 200;
const MAX_SUBJECT_LEN = 20_000;

export interface VerifyContract {
  /** Regex the result must match (string form, applied case-insensitively unless flags given). */
  matches?: string;
  /** Every string must appear in the result (case-insensitive). */
  contains_all?: string[];
  /** No string may appear in the result (case-insensitive). */
  contains_none?: string[];
  /** Result must parse as JSON and contain every key (top level). */
  json_keys?: string[];
  /** Result must be at least this long after trimming. */
  min_length?: number;
  /** Reject known fabrication markers. Defaults to true whenever a contract exists. */
  no_placeholders?: boolean;
}

export interface CheckOutcome {
  kind: string;
  ok: boolean;
  detail: string;
  /**
   * False when the check COULD NOT BE RUN, as distinct from ran and failed.
   * Absent means it ran (the overwhelmingly common case).
   *
   * The distinction is not cosmetic — these verdicts feed RepID. `ok:false`
   * alone collapses "the agent's output was wrong" and "the operator wrote a
   * regex that does not terminate" into the same `rejected`/`assertion_failed`,
   * which debits the agent for someone else's mistake. Note that the SAME bad
   * pattern caught one layer earlier, by `hasBacktrackingRisk` at parse time,
   * already returns `unclear`/`unverified`; a pattern that slips the heuristic
   * and is caught by the budget instead must not be graded differently just
   * because a different guard caught it.
   */
  evaluated?: boolean;
}

export interface VerifyLegResult {
  verification_method: string;
  verifier_verdict: VerifierVerdict;
  final_verdict: FinalVerdict;
  verified_output: {
    method: string;
    checks: CheckOutcome[];
    substantive_checks: number;
    placeholders_found: string[];
    reason: string;
    checked_at: string;
  };
}

/**
 * Conservative catastrophic-backtracking detector. A REPEATED group whose body can
 * match the same text more than one way is the blow-up shape; rejecting these outright
 * (as `contract_invalid`, loudly) is cheaper than defending against them, and no honest
 * contract in this codebase needs one.
 *
 * Two ambiguity sources are flagged, both MEASURED on this Node build rather than
 * assumed (`i` flag, subject `'a'.repeat(n) + 'b'`):
 *   1. a quantifier inside the body — `(a+)+$` / `(a+){10}$` (33 chars: 2.8 s) /
 *      `(a+){2,}$` (29 chars: 61 s);
 *   2. an ALTERNATION inside the body — `(a|aa)+$` (43 chars: >30 s), which has no
 *      body quantifier at all.
 *
 * The repetition operator itself may be `*`, `+`, or a BRACED form `{n}` / `{n,}` /
 * `{n,m}` — the braced forms blow up exactly like `+` and an earlier version of this
 * function only looked for `*`/`+`, so `(a+){10}$` walked straight through.
 *
 * What makes a body ambiguous is VARIABLE width, so a FIXED brace is not flagged:
 * `([0-9a-f]{40})+` consumes exactly 40 characters per repetition and cannot blow up,
 * and it is a realistic contract pattern. `{n,}` / `{n,m}` are variable and are flagged.
 *
 * The body is scanned at EVERY nesting depth, not just the group's own level. An
 * earlier version skipped characters at depth > 1, which left a third bypass class
 * wide open: `((a+))+$` — a redundant double-wrap of case 1 above — was accepted and
 * MEASURED here at n=30 (24.6 s), n=27 (2.9 s), n=24 (0.37 s), clean exponential
 * growth, reachable straight through `parseContract`. `(((a+)))+$`, `((a|aa))+$`,
 * `((a*))*$` and `((a{2,}))+$` all walked through the same hole. Depth is not a
 * safety property: wrapping a dangerous body in parentheses does not tame it.
 *
 * Scanning all depths does mean the `?` in a GROUP PREFIX must not be mistaken for
 * the `?` quantifier, so `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>` are
 * stepped over wherever they occur. That also fixes a pre-existing false positive:
 * `(?:abc)+` — fixed-width, entirely safe — used to be rejected, because the `?`
 * opening the non-capturing group read as a quantifier. An unrecognised `(?…` is
 * left alone on purpose, so its `?` still counts as variable (fail closed).
 *
 * Still deliberately conservative elsewhere: `{` after a group counts as a repetition
 * even when it is a literal brace (JS allows `(ab){x}`), and a repeated alternation is
 * rejected even when its branches are disjoint (`(cat|dog)+`) or fixed-width
 * (`((a|b))+`). A false rejection surfaces as a loud `contract_invalid`; a false
 * acceptance parks the bridge poller, so the asymmetry is deliberate.
 * This remains a heuristic, not a proof of termination — which is why regexes are also
 * capped at MAX_PATTERN_LEN and subjects at MAX_SUBJECT_LEN.
 */

/**
 * Index of the first character of a group's BODY, given `k` = the index just after
 * its `(`. Steps over `?:`, `?=`, `?!`, `?<=`, `?<!` and `?<name>`. An unrecognised
 * `?` is not stepped over, so it keeps counting as a quantifier (fail closed).
 */
function groupBodyStart(pattern: string, k: number): number {
  if (pattern[k] !== '?') return k;
  const c = pattern[k + 1];
  if (c === ':' || c === '=' || c === '!') return k + 2;
  if (c === '<') {
    const c2 = pattern[k + 2];
    if (c2 === '=' || c2 === '!') return k + 3; // lookbehind
    const close = pattern.indexOf('>', k + 2); // named group
    if (close !== -1) return close + 1;
  }
  return k;
}

export function hasBacktrackingRisk(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(') continue;
    if (i > 0 && pattern[i - 1] === '\\') continue;
    let depth = 1;
    let bodyVariable = false;
    let bodyAlternation = false;
    let j = groupBodyStart(pattern, i + 1);
    for (; j < pattern.length && depth > 0; j++) {
      const c = pattern[j];
      if (c === '\\') { j++; continue; }
      // Nested group: descend, and step past ITS prefix so `(?:` contributes no `?`.
      if (c === '(') { depth++; j = groupBodyStart(pattern, j + 1) - 1; continue; }
      if (c === ')') { depth--; continue; }
      // Everything below is counted at ANY depth — see the depth note above.
      if (c === '*' || c === '+' || c === '?') bodyVariable = true;
      else if (c === '|') bodyAlternation = true;
      else if (c === '{') {
        const close = pattern.indexOf('}', j);
        // A variable brace (`{n,}` / `{n,m}`) is a risk; a fixed `{n}` is not; anything
        // else is a literal brace and consumes exactly itself.
        if (close !== -1 && /^\d+,\d*$/.test(pattern.slice(j + 1, close))) bodyVariable = true;
      }
    }
    const after = pattern[j];
    const repeated = after === '*' || after === '+' || after === '{';
    if (depth === 0 && repeated && (bodyVariable || bodyAlternation)) return true;
  }
  return false;
}

/**
 * Parse `expected_output` as a contract. Returns null when the field is absent
 * or is plain prose (the overwhelmingly common case — 52 of 362,965 rows carry
 * anything at all here), and throws nothing: an unparseable *object* is a
 * different thing from prose and is reported as `contract_invalid` by the
 * caller, because a malformed contract is an operator error worth surfacing.
 */
export function parseContract(
  expectedOutput: string | null | undefined
): { contract: VerifyContract } | { invalid: string } | null {
  const raw = String(expectedOutput ?? '').trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) return null; // prose, not a contract — not an error
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalid: 'expected_output starts with { but is not valid JSON' };
  }
  // No `typeof parsed === 'object'` guard here on purpose: any valid JSON text
  // beginning with `{` parses to a plain object, so such a guard could never
  // fire. A branch that cannot be reached is the same species of lie as a check
  // that cannot fail, and this module exists to stop those.
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  const unknown = keys.filter((k) => !KNOWN_KINDS.includes(k));
  if (unknown.length > 0) {
    return { invalid: `unknown assertion(s): ${unknown.join(', ')}` };
  }
  if (keys.length === 0) return { invalid: 'contract is empty' };

  const c: VerifyContract = {};
  if ('matches' in obj) {
    if (typeof obj.matches !== 'string' || obj.matches.length === 0) {
      return { invalid: 'matches must be a non-empty string' };
    }
    if (obj.matches.length > MAX_PATTERN_LEN) {
      return { invalid: `matches exceeds ${MAX_PATTERN_LEN} chars` };
    }
    if (hasBacktrackingRisk(obj.matches)) {
      return { invalid: 'matches has catastrophic-backtracking risk (repeated variable-width or alternating group)' };
    }
    try {
      new RegExp(obj.matches, 'i');
    } catch {
      return { invalid: 'matches is not a valid regular expression' };
    }
    c.matches = obj.matches;
  }
  for (const k of ['contains_all', 'contains_none', 'json_keys'] as const) {
    if (k in obj) {
      const v = obj[k];
      if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== 'string' || s.length === 0)) {
        return { invalid: `${k} must be a non-empty array of non-empty strings` };
      }
      c[k] = v as string[];
    }
  }
  if ('min_length' in obj) {
    if (typeof obj.min_length !== 'number' || !Number.isFinite(obj.min_length) || obj.min_length < 0) {
      return { invalid: 'min_length must be a non-negative number' };
    }
    c.min_length = obj.min_length;
  }
  if ('no_placeholders' in obj) {
    if (typeof obj.no_placeholders !== 'boolean') {
      return { invalid: 'no_placeholders must be a boolean' };
    }
    c.no_placeholders = obj.no_placeholders;
  }
  return { contract: c };
}

function findPlaceholders(subject: string): string[] {
  const lower = subject.toLowerCase();
  return PLACEHOLDER_MARKERS.filter((m) => lower.includes(m));
}

/**
 * Grade a task result against its contract.
 *
 * Returns null when there is nothing to grade (no contract) — the caller must
 * then leave all four columns NULL rather than writing a manufactured verdict.
 */
export async function verifyTaskDeterministically(task: {
  expected_output?: string | null;
  result?: string | null;
}): Promise<VerifyLegResult | null> {
  const parsedContract = parseContract(task.expected_output);
  if (parsedContract === null) return null;

  const checkedAt = new Date().toISOString();
  const subject = String(task.result ?? '').slice(0, MAX_SUBJECT_LEN);

  if ('invalid' in parsedContract) {
    return {
      verification_method: `${VERIFY_METHOD}:contract_invalid`,
      verifier_verdict: 'unclear',
      final_verdict: 'unverified',
      verified_output: {
        method: VERIFY_METHOD,
        checks: [{ kind: 'contract', ok: false, detail: parsedContract.invalid }],
        substantive_checks: 0,
        placeholders_found: [],
        reason: 'contract_invalid',
        checked_at: checkedAt,
      },
    };
  }

  const c = parsedContract.contract;
  const checks: CheckOutcome[] = [];
  let substantive = 0;

  if (c.matches !== undefined) {
    substantive++;
    // Run under a hard wall-clock budget in a terminable worker. The pattern is
    // operator-supplied — anything that can insert a task can write it — and a
    // catastrophically-backtracking regex against a 20 KB subject does not fail,
    // it pegs the event loop and takes the bridge poller with it.
    // `hasBacktrackingRisk` already rejected the shapes it recognises at parse
    // time, but it has been bypassed four times across Beats 32/33/38, so it is
    // the advisory layer and this is the guarantee. See `regex-budget.ts`.
    const outcome = await matchWithBudget(c.matches, 'i', subject);
    let ok = false;
    let evaluated = true;
    let detail: string;
    if (outcome.status === 'ok') {
      ok = outcome.matched;
      detail = ok ? `result matches /${c.matches}/i` : `result does not match /${c.matches}/i`;
    } else if (outcome.status === 'timeout') {
      // NOT a failed match. `ok` stays false so this can never read as passed,
      // and `evaluated` is false so it does not read as the agent's failure
      // either — the pattern is pathological, which is the operator's problem.
      evaluated = false;
      detail = `regex exceeded the ${outcome.budgetMs}ms budget (catastrophic backtracking) — pattern not evaluable`;
    } else {
      // Worker fault or a pattern that only fails at construction inside the
      // thread. Also not evidence about the agent's output.
      evaluated = false;
      detail = `regex could not be run: ${outcome.message}`;
    }
    checks.push({ kind: 'matches', ok, detail, evaluated });
  }

  if (c.contains_all !== undefined) {
    substantive++;
    const lower = subject.toLowerCase();
    const missing = c.contains_all.filter((s) => !lower.includes(s.toLowerCase()));
    checks.push({
      kind: 'contains_all',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `all ${c.contains_all.length} present` : `missing: ${missing.join(', ')}`,
    });
  }

  if (c.json_keys !== undefined) {
    substantive++;
    let ok = false;
    let detail: string;
    try {
      const obj = JSON.parse(subject);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        detail = 'result parsed but is not a JSON object';
      } else {
        const missing = c.json_keys.filter((k) => !(k in (obj as Record<string, unknown>)));
        ok = missing.length === 0;
        detail = ok ? `all ${c.json_keys.length} keys present` : `missing keys: ${missing.join(', ')}`;
      }
    } catch {
      detail = 'result is not valid JSON';
    }
    checks.push({ kind: 'json_keys', ok, detail });
  }

  if (c.contains_none !== undefined) {
    const lower = subject.toLowerCase();
    const present = c.contains_none.filter((s) => lower.includes(s.toLowerCase()));
    checks.push({
      kind: 'contains_none',
      ok: present.length === 0,
      detail: present.length === 0 ? 'none present' : `forbidden present: ${present.join(', ')}`,
    });
  }

  if (c.min_length !== undefined) {
    const len = subject.trim().length;
    checks.push({
      kind: 'min_length',
      ok: len >= c.min_length,
      detail: `length ${len} vs min ${c.min_length}`,
    });
  }

  // Default ON: a contract exists, so this result is being read as evidence.
  const placeholderCheck = c.no_placeholders !== false;
  const placeholders = placeholderCheck ? findPlaceholders(subject) : [];
  if (placeholderCheck) {
    checks.push({
      kind: 'no_placeholders',
      ok: placeholders.length === 0,
      detail: placeholders.length === 0 ? 'no known placeholders' : `found: ${placeholders.join(', ')}`,
    });
  }

  // An unevaluable check DOMINATES a failed one. Both refuse to approve, so the
  // safety property is identical either way; the difference is who gets blamed,
  // and the grading was incomplete, so nobody can be. Reporting `rejected` here
  // would assert a complete grade that never happened — and would hand the same
  // outcome to a task whose output was genuinely wrong and to one whose operator
  // wrote a non-terminating pattern. It also keeps this path identical to the
  // heuristic's `contract_invalid` path for the very same bad pattern.
  const notEvaluated = checks.filter((k) => k.evaluated === false);
  const anyFailed = checks.some((k) => !k.ok);
  let verifier: VerifierVerdict;
  let final: FinalVerdict;
  let reason: string;

  if (notEvaluated.length > 0) {
    verifier = 'unclear';
    final = 'unverified';
    reason = `check_not_evaluable:${notEvaluated.map((k) => k.kind).join(',')}`;
  } else if (anyFailed) {
    verifier = 'rejected';
    final = 'rejected';
    reason = 'assertion_failed';
  } else if (substantive === 0) {
    // Everything passed, but nothing here could ever have confirmed anything.
    verifier = 'unclear';
    final = 'unverified';
    reason = 'no_substantive_assertion';
  } else {
    verifier = 'approved';
    final = 'verified_done';
    reason = 'all_assertions_passed';
  }

  return {
    verification_method: VERIFY_METHOD,
    verifier_verdict: verifier,
    final_verdict: final,
    verified_output: {
      method: VERIFY_METHOD,
      checks,
      substantive_checks: substantive,
      placeholders_found: placeholders,
      reason,
      checked_at: checkedAt,
    },
  };
}
