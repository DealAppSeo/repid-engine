/**
 * goal-ancestry.ts — give a task its "why", and make the acceptance bar inheritable.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS ALREADY HERE, AND WHAT IS NOT
 * ════════════════════════════════════════════════════════════════════════════════
 * `services/task-lineage.ts` already owns the lineage EDGE — it derives
 * `parent_task_id` + `generation` on spawn and refuses a tree that gets too deep
 * (breaker 2.2, fork-bomb prevention). It is a SAFETY mechanism and it is correct.
 *
 * What nothing does is walk that edge UPWARD. The chain is written and never read,
 * so a task is handed to an agent as an isolated instruction with no statement of
 * what it is for or what would count as having done it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS WORTH DOING — MEASURED, NOT ASSUMED  [V sql 2026-08-04]
 * ════════════════════════════════════════════════════════════════════════════════
 * Of 363,015 rows in `trinity_tasks`:
 *
 *   340,958 (93.9%)  success_criteria is NULL, empty, or the literal column
 *                    DEFAULT 'Pass default checks.'
 *        56 (0.015%) have expected_output
 *         0 (ZERO)   have verification_method
 *    50,125 (13.8%)  have a parent_task_id
 *   max(generation) = 1
 *
 * So the system asks agents to do work and tells ~94% of them that the standard
 * they will be judged against is "Pass default checks." Not one row states how it
 * would be verified. A vacuous acceptance bar is an invitation to return something
 * that merely LOOKS like completion, and that is the shape the nightly-smoke
 * fabrication took.
 *
 * The tree is also SHALLOW — at most 2 levels. That is precisely why inheritance
 * is the valuable half here rather than deep chain-walking: a child with the
 * default criterion can inherit a real one from the parent that spawned it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES *NOT* FIX — STATED PLAINLY
 * ════════════════════════════════════════════════════════════════════════════════
 * It does not stop fabrication. Swarm agents have no HTTP client, so a task that
 * requires a real measurement is one they CANNOT perform; context does not hand
 * them a capability. What this changes is that the bar becomes explicit and
 * machine-readable, so a report can be judged against a stated criterion instead
 * of against nothing — and a task whose evidence requirement cannot be met can be
 * refused up front rather than answered with prose.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ZERO DDL
 * ════════════════════════════════════════════════════════════════════════════════
 * Every field used already exists on `trinity_tasks` and was verified against
 * information_schema (NOT the generated types, which are stale by standing rule):
 *   parent_task_id bigint · generation int · title text · description text NOT NULL
 *   success_criteria text DEFAULT 'Pass default checks.' · expected_output text
 *   verification_method text · requires_external_artifact bool · metadata jsonb
 * Adding a parallel set of columns to a table with 26 inbound FKs would create a
 * second competing convention — the same reasoning task-lineage.ts records.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * REQUIREMENTS INHERIT DOWNWARD; EXEMPTIONS DO NOT
 * ════════════════════════════════════════════════════════════════════════════════
 * If ANY ancestor requires external evidence, every descendant does too. Otherwise
 * spawning a child is a one-line way to launder an evidence requirement away —
 * exactly the bypass task-lineage.ts refuses for depth ("an unknown parent ID does
 * NOT reset the depth"). Inheritance is monotonic in the strict direction only.
 */

/** The `trinity_tasks.success_criteria` column DEFAULT. Real, and meaningless. */
export const VACUOUS_CRITERIA = 'Pass default checks.';

/**
 * Other placeholders seen in this column. Kept deliberately SHORT and exact-match
 * (after trim/case-fold) rather than fuzzy: calling a real criterion vacuous would
 * silently discard the one instruction an agent had, which is worse than letting a
 * weak one through.
 */
const VACUOUS_FORMS = new Set([
  VACUOUS_CRITERIA.toLowerCase(),
  'pass default checks',
  'n/a',
  'none',
  'tbd',
  '-',
]);

export function isVacuousCriteria(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const t = raw.trim();
  if (t === '') return true;
  return VACUOUS_FORMS.has(t.toLowerCase().replace(/\.$/, ''));
}

/* ══════════════════════════════════════════════════════════════════════════════
 * THE PRODUCER-SIDE GATE — where the leverage actually is
 * ══════════════════════════════════════════════════════════════════════════════
 * Inheritance was built first and then MEASURED, and the measurement said it buys
 * almost nothing [V sql 2026-08-04]: of 28,212 vacuous tasks that have a parent,
 * only **35** would gain a real criterion by inheriting one. 28,177 have a parent
 * that is vacuous too. The "why" is not missing from the child — it was never
 * written anywhere in the chain, so no consumer-side mechanism can recover it.
 *
 * The binding constraint is the PRODUCER. By insert_source:
 *   system        362,547 rows · 93.9% vacuous   (external: the swarm runtime)
 *   claude-loop        48 rows · 81.3% vacuous   (active — last insert 2026-08-04)
 *   claude-sprint      58 rows · 82.8% vacuous
 *   ...and several sources at 0.0% vacuous, which is the point: writing a real
 *   criterion is demonstrably achievable. This is a discipline gap, not a
 *   capability gap, and a gate is how discipline stops depending on memory.
 *
 * `POST /directives` already validates `success_criteria.length >= 1` — which
 * accepts 'Pass default checks.' and '-'. Length is not a standard.
 *
 * DEFAULT `shadow`: refusing a write on an operator-facing endpoint is a live
 * behaviour change, so it logs first and the refusal rate is read from traffic
 * before anyone flips it.
 */

export type CriteriaGateMode = 'off' | 'shadow' | 'enforce';

export const CRITERIA_GATE_ENV = 'TASK_CRITERIA_GATE';

export function criteriaGateMode(
  raw: string | undefined | null = process.env[CRITERIA_GATE_ENV],
): CriteriaGateMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'enforce') return 'enforce';
  return 'shadow';
}

export interface CriteriaGateDecision {
  vacuous: boolean;
  mode: CriteriaGateMode;
  /** Caller must actually reject. Only ever true in `enforce`. */
  refuse: boolean;
  reason: string;
}

/**
 * Judge a proposed `success_criteria` at insert time.
 *
 * Deliberately NOT a quality score — it only separates "states something" from
 * "states nothing". A gate that tried to rate how GOOD a criterion is would
 * reject honest weak ones and be argued with; this one is checkable and its
 * failure mode is that a weak-but-real criterion passes, which is the safe side.
 */
export function assessCriteriaGate(
  raw: unknown,
  mode: CriteriaGateMode = criteriaGateMode(),
): CriteriaGateDecision {
  const vacuous = isVacuousCriteria(raw);

  if (mode === 'off') {
    return { vacuous, mode, refuse: false, reason: 'mode=off' };
  }
  if (!vacuous) {
    return { vacuous, mode, refuse: false, reason: 'criterion states something checkable' };
  }
  return {
    vacuous,
    mode,
    refuse: mode === 'enforce',
    reason:
      `success_criteria is vacuous (null, empty, or a placeholder such as '${VACUOUS_CRITERIA}'). ` +
      `A task whose acceptance bar states nothing cannot be verified, and asking an agent to meet ` +
      `an unstated standard is how a plausible-looking report becomes indistinguishable from a real one.`,
  };
}

/** One greppable line, so a shadow run can be counted from logs. */
export function criteriaGateLogLine(prefix: string, d: CriteriaGateDecision): string {
  const verb = d.refuse ? 'REFUSED' : d.vacuous ? 'WOULD-REFUSE' : 'allowed';
  return `${prefix} [criteria-gate] ${verb} mode=${d.mode} — ${d.reason}`;
}

/** The columns this module reads. A row shape, not the whole table. */
export interface AncestryNode {
  id: number | string;
  parent_task_id?: number | string | null;
  generation?: number | null;
  title?: string | null;
  description?: string | null;
  success_criteria?: string | null;
  expected_output?: string | null;
  verification_method?: string | null;
  requires_external_artifact?: boolean | null;
}

export type CriteriaSource = 'self' | 'inherited' | 'none';
export type TruncationReason = 'cycle' | 'max_hops' | null;

export interface GoalAncestry {
  /** Root → leaf. Always at least the leaf itself. */
  chain: AncestryNode[];
  /** Hops above the leaf actually resolved (0 = no parent found/walked). */
  depth: number;
  /** Why the walk stopped early, if it did. */
  truncated: TruncationReason;
  /**
   * The acceptance bar that actually applies: the leaf's own criterion when it has
   * a real one, else the NEAREST ancestor's. `null` when nobody in the chain
   * states one — reported honestly rather than filled in.
   */
  effectiveCriteria: string | null;
  criteriaSource: CriteriaSource;
  /** id of the node the criterion came from, when inherited. */
  criteriaFromTaskId: number | string | null;
  /** Root → leaf statements of purpose, skipping nodes with nothing to say. */
  whyChain: string[];
  /** True when ANY node in the chain requires external evidence. Monotonic. */
  evidenceRequired: boolean;
  /** Nearest stated verification method, self first then ancestors. */
  verificationMethod: string | null;
  /** Nearest stated expected output, self first then ancestors. */
  expectedOutput: string | null;
}

/** Leaf-first view of the chain — the order every "nearest" lookup wants. */
function leafFirst(chain: AncestryNode[]): AncestryNode[] {
  return [...chain].reverse();
}

function firstNonEmpty(
  nodes: AncestryNode[],
  pick: (n: AncestryNode) => unknown,
): { value: string; from: AncestryNode } | null {
  for (const n of nodes) {
    const v = pick(n);
    if (typeof v === 'string' && v.trim() !== '') return { value: v.trim(), from: n };
  }
  return null;
}

/**
 * Compose the context for the LEAF of a root→leaf chain. Pure — no DB, no clock —
 * so every inheritance rule is testable without standing anything up.
 *
 * An empty chain is a programming error rather than a data condition, and is
 * returned as an explicitly empty ancestry instead of throwing into a caller that
 * is usually inside a best-effort path.
 */
export function composeAncestry(
  chain: AncestryNode[],
  truncated: TruncationReason = null,
): GoalAncestry {
  if (chain.length === 0) {
    return {
      chain: [], depth: 0, truncated, effectiveCriteria: null, criteriaSource: 'none',
      criteriaFromTaskId: null, whyChain: [], evidenceRequired: false,
      verificationMethod: null, expectedOutput: null,
    };
  }

  const nearest = leafFirst(chain);
  const leaf = nearest[0]!;

  // Criteria: the leaf's own if it is real, else the nearest ancestor's real one.
  // A vacuous criterion is never treated as a statement — that is the whole point.
  const realCriteria = firstNonEmpty(
    nearest.filter((n) => !isVacuousCriteria(n.success_criteria)),
    (n) => n.success_criteria,
  );

  let criteriaSource: CriteriaSource = 'none';
  if (realCriteria) {
    criteriaSource = String(realCriteria.from.id) === String(leaf.id) ? 'self' : 'inherited';
  }

  const whyChain = chain
    .map((n) => {
      const t = typeof n.title === 'string' ? n.title.trim() : '';
      const d = typeof n.description === 'string' ? n.description.trim() : '';
      return t && d ? `${t} — ${d}` : t || d;
    })
    .filter((s) => s !== '');

  const verification = firstNonEmpty(nearest, (n) => n.verification_method);
  const expected = firstNonEmpty(nearest, (n) => n.expected_output);

  return {
    chain,
    depth: chain.length - 1,
    truncated,
    effectiveCriteria: realCriteria ? realCriteria.value : null,
    criteriaSource,
    criteriaFromTaskId: criteriaSource === 'inherited' ? realCriteria!.from.id : null,
    whyChain,
    // Monotonic: ANY ancestor requiring evidence binds every descendant.
    evidenceRequired: chain.some((n) => n.requires_external_artifact === true),
    verificationMethod: verification ? verification.value : null,
    expectedOutput: expected ? expected.value : null,
  };
}

/**
 * Default cap on hops above the leaf. Generous relative to the deepest tree that
 * has ever existed (generation 1), because this bound exists to stop a runaway
 * walk, not to express a policy about tree shape — that is breaker 2.2's job.
 */
export const DEFAULT_MAX_HOPS = 16;

/**
 * Walk `parent_task_id` upward and return the chain ROOT → LEAF.
 *
 * CYCLE SAFETY IS NOT OPTIONAL. Nothing in the schema prevents `parent_task_id`
 * from pointing at a row that (transitively) points back — there is no CHECK, no
 * trigger, and self-parenting is expressible. A naive walk on such a row does not
 * return; it hangs whatever called it. So visited ids are tracked and a repeat
 * stops the walk with `truncated: 'cycle'` rather than throwing: a malformed
 * lineage should degrade the context, never take down the caller.
 *
 * `fetchById` returning null (deleted parent, permission, whatever) simply ends
 * the walk — a partial chain is still better context than none.
 */
export async function walkAncestry(
  leaf: AncestryNode,
  fetchById: (id: number | string) => Promise<AncestryNode | null>,
  maxHops: number = DEFAULT_MAX_HOPS,
): Promise<{ chain: AncestryNode[]; truncated: TruncationReason }> {
  const chainLeafFirst: AncestryNode[] = [leaf];
  const seen = new Set<string>([String(leaf.id)]);
  let truncated: TruncationReason = null;

  let current = leaf;
  for (let hop = 0; hop < maxHops; hop++) {
    const pid = current.parent_task_id;
    if (pid === null || pid === undefined || pid === '') break;

    if (seen.has(String(pid))) {
      truncated = 'cycle';
      break;
    }

    const parent = await fetchById(pid);
    if (!parent) break;

    seen.add(String(parent.id));
    chainLeafFirst.push(parent);
    current = parent;

    // Cap reached with a parent still pending — say so rather than implying root.
    if (chainLeafFirst.length - 1 >= maxHops) {
      if (parent.parent_task_id !== null && parent.parent_task_id !== undefined) {
        truncated = 'max_hops';
      }
      break;
    }
  }

  return { chain: chainLeafFirst.reverse(), truncated };
}

/**
 * Render the briefing an agent should actually receive.
 *
 * The refusal line is the load-bearing one: when evidence is required, the agent
 * is told in advance that prose will not be accepted, and that saying it could not
 * measure something is a valid outcome. An agent with no way to obtain evidence
 * and no sanctioned way to say so is being steered toward inventing it.
 */
export function renderBriefing(a: GoalAncestry): string {
  const lines: string[] = [];

  if (a.whyChain.length > 0) {
    lines.push('WHY THIS EXISTS (root first):');
    a.whyChain.forEach((w, i) => lines.push(`  ${i + 1}. ${w}`));
  }

  lines.push('');
  if (a.effectiveCriteria) {
    const via = a.criteriaSource === 'inherited'
      ? ` (inherited from task ${a.criteriaFromTaskId})`
      : '';
    lines.push(`ACCEPTANCE CRITERIA${via}:`);
    lines.push(`  ${a.effectiveCriteria}`);
  } else {
    lines.push('ACCEPTANCE CRITERIA: NONE STATED anywhere in this task\'s ancestry.');
    lines.push('  Treat this as a defect in the task, not as licence to decide for yourself');
    lines.push('  what counts as done. Say so in your report.');
  }

  if (a.expectedOutput) {
    lines.push('');
    lines.push(`EXPECTED OUTPUT: ${a.expectedOutput}`);
  }
  if (a.verificationMethod) {
    lines.push('');
    lines.push(`HOW THIS WILL BE VERIFIED: ${a.verificationMethod}`);
  }

  if (a.evidenceRequired) {
    lines.push('');
    lines.push('EXTERNAL EVIDENCE IS REQUIRED for this task or one it descends from.');
    lines.push('  A written description of what you would have found does NOT satisfy it.');
    lines.push('  If you cannot obtain the evidence, report that you could not — an honest');
    lines.push('  "could not measure" is a correct outcome; an invented result is not.');
  }

  if (a.truncated === 'cycle') {
    lines.push('');
    lines.push('NOTE: ancestry walk stopped early — parent_task_id forms a cycle. Context may be partial.');
  } else if (a.truncated === 'max_hops') {
    lines.push('');
    lines.push('NOTE: ancestry walk hit the hop cap. Context may be partial.');
  }

  return lines.join('\n');
}
