/**
 * lane-registry.ts — who may be asked to do what, as code rather than as a doc.
 *
 * WHY THIS EXISTS, from a measurement. 18 of 18 nightly smoke reports contained zero
 * real measurements, and every verdict column on `trinity_tasks` is 100 % cold. The
 * cause was not that the T12 swarm lied — it is that T12 agents have **no HTTP
 * client**, and we kept assigning them work that required one. An agent asked for a
 * number it cannot obtain will produce a plausible number. That is not a discipline
 * problem to be solved with a sterner prompt; it is a **capability mismatch**, and the
 * only fix that holds is to never route the task there in the first place.
 *
 * So a lane here declares CAPABILITIES, not aspirations, and the gate refuses the
 * assignment rather than trusting the output. Fabrication is prevented at dispatch,
 * not detected at review.
 *
 * WHAT IS BORROWED, AND WHAT IS NOT. The shape is adapted from garrytan/gstack (MIT),
 * which structures one Claude Code session into sequential specialist roles with a
 * second, independent model voice per phase. Two of its mechanics transplant cleanly
 * and are implemented here and in `handoff-gate.ts`:
 *
 *   1. a missing second voice is N/A, **never** CONFIRMED, and
 *   2. a phase does not advance until its required outputs provably exist.
 *
 * Two of its principles are deliberately NOT adopted, because they are wrong for a
 * system whose finished code must sometimes stay inert:
 *
 *   - "Bias toward action — merge > review cycles." We keep no-self-merge
 *     (CLAUDE_RULES 9). It is load-bearing: it is what caught the fabricating price
 *     fallback.
 *   - "Always choose completeness / boil the ocean." Correct for scope, wrong for
 *     flags. Original work that touches live state lands finished-and-inert
 *     (CLAUDE_RULES 23), which is the opposite of shipping the complete thing live.
 *
 * EVERY CAPABILITY BELOW IS SOURCED, not assigned by intuition. See each lane.
 */

/**
 * A concrete thing a lane can actually do. Deliberately about ACCESS, not skill —
 * skill is arguable, access is checkable.
 */
export type Capability =
  /** Can make outbound network calls (fetch a URL, hit an API, probe a key). */
  | 'http'
  /** Can read the production database. */
  | 'db_read'
  /** Can write to the production database, including DDL. */
  | 'db_write'
  /**
   * Can READ files in the repository it is working in.
   *
   * Added 2026-08-05 after wiring this registry to its first real caller. The
   * vocabulary had `repo_write` and no read, which made "can this agent look at
   * the code?" unaskable — and that is the precise question whose absence let a
   * reviewer be dispatched at a file it could not open.
   */
  | 'repo_read'
  /**
   * Can read files in a DIFFERENT repository than its own workspace.
   *
   * Deliberately separate from `repo_read`. Both CLI harnesses sandbox to a single
   * workspace root and refuse paths outside it — *"Path not in workspace"* — so an
   * agent that can read its own repo perfectly may be blind to the one under
   * review. Collapsing the two is what made the 2026-08-05 fabricated review
   * possible.
   */
  | 'cross_repo_read'
  /**
   * Can execute a shell command — run tests, run a build, run the thing.
   *
   * The capability that separates "I reviewed it" from "I ran it". A reviewer
   * without this cannot honour requirement 1 of the cross-family review contract
   * (PARALLEL_AGENT_LANES §3: *run it, do not read it*), and will report test
   * results it inferred.
   */
  | 'shell'
  /** Can create branches and commits in a repo. */
  | 'repo_write'
  /** Can merge a pull request. */
  | 'merge'
  /** Can read on-chain state (BaseScan, RPC). */
  | 'chain_read'
  /** Can broadcast a transaction that spends real or testnet funds. */
  | 'chain_send'
  /** Can change infrastructure: Railway, Vercel, DNS, secrets. */
  | 'infra'
  /** Reasoning over text supplied in the prompt. The floor — every lane has it. */
  | 'reasoning';

export type LaneId = 'CC' | 'GA' | 'XC' | 'T12' | 'SEAN';

/**
 * Cost tier. Lower is cheaper and is tried FIRST — the cost cascade of
 * CLAUDE_RULES 18 ("free T12 for volume, cheap XC/GA for backend, reserve expensive
 * CC for frontier crypto") expressed as a number a function can sort on instead of a
 * sentence a human has to remember.
 *
 * 0 = free. 1 = cheap subscription CLI. 2 = expensive. 3 = human attention, the
 * scarcest resource in the system and the one this whole file exists to conserve.
 */
export type CostTier = 0 | 1 | 2 | 3;

export interface Lane {
  id: LaneId;
  /** One line. If a lane needs a paragraph, the lane is really two lanes. */
  role: string;
  capabilities: readonly Capability[];
  costTier: CostTier;
  /**
   * Where this lane's finished work goes for an independent check. A lane NEVER
   * appears in its own list — enforced by a test, not by care.
   */
  handsTo: readonly LaneId[];
  /** Why these capabilities and not others. A claim in this file needs a source. */
  source: string;
}

/**
 * THE LANES.
 *
 * Note what is absent: no lane is a generalist. The failure mode being corrected is
 * "enable every agent to do everything", which produces agents that attempt
 * everything and can verify nothing.
 */
export const LANES: readonly Lane[] = [
  {
    id: 'T12',
    role: 'Volume reasoning over material supplied in the prompt. Corpus, drafts, summaries.',
    // The whole point of this file. T12 has reasoning and NOTHING else.
    capabilities: ['reasoning'],
    costTier: 0,
    handsTo: ['GA', 'CC'],
    source:
      'Measured: swarm agents have no HTTP client; 18/18 nightly smoke reports contained ' +
      '0 real measurements and trinity_tasks verdict columns are 100% cold. Any task ' +
      'needing a tool must not be routed here — it comes back fabricated.',
  },
  {
    id: 'GA',
    role: 'Backend/frontend implementation on a branch, measurement harnesses, doc sweeps.',
    // CORRECTED 2026-08-05 — the previous list was over-broad and its source line
    // ("Headless CLI verified") is the exact over-generalisation this registry is
    // supposed to prevent: the CLI starting is not evidence of what it can reach.
    // `http` and `cross_repo_read` REMOVED, `repo_read` and `shell` recorded as
    // measured-absent. See `source`.
    capabilities: ['reasoning', 'repo_read', 'db_read', 'repo_write'],
    costTier: 1,
    handsTo: ['XC', 'CC'],
    source:
      'MEASURED 2026-08-05 from the gemini CLI’s own stderr during a live dispatch, ' +
      'not inferred: `run_shell_command` -> "not available to this agent" (NO shell); ' +
      '`web_fetch` -> "not available to this agent" (NO http); `read_file`/`grep` on a ' +
      'path outside the workspace root -> "Path not in workspace" (repo_read is ' +
      'workspace-scoped, so NO cross_repo_read). The prior entry claimed http and was ' +
      'sourced only to "`gemini -p` runs", which is a claim about the process starting, ' +
      'not about what it can reach — and dispatching a review on that basis produced a ' +
      'report with fabricated test output. db_write withheld: single-writer discipline ' +
      '(CLAUDE_RULES 5/6). repo_write is branch-only — merge is SEAN.',
  },
  {
    id: 'XC',
    role: 'Adversarial review, red-team, cross-family verification of another lane‘s claim.',
    // NOT db_read either: XC is DB-blind, so a DB claim from XC is unsourceable.
    capabilities: ['reasoning', 'repo_read', 'http', 'repo_write'],
    costTier: 1,
    handsTo: ['CC'],
    source:
      'CLAUDE_RULES 6: "XC is DB-blind — never delegate prod SQL to it." Its SQL piled ' +
      'up against a stale on-disk schema and was unsafe every time.',
  },
  {
    id: 'CC',
    role: 'Frontier work, prod SQL, security-sensitive changes, and final synthesis.',
    capabilities: ['reasoning', 'repo_read', 'cross_repo_read', 'shell', 'http', 'db_read', 'db_write', 'repo_write', 'chain_read'],
    costTier: 2,
    handsTo: ['XC', 'SEAN'],
    source:
      'CLAUDE_RULES 7: CC has its own prod MCP and may self-apply additive DDL. ' +
      'NO merge (rule 9), NO chain_send, NO infra — those are SEAN by rule.',
  },
  {
    id: 'SEAN',
    role: 'Merges, infrastructure, secrets, spending real money, and every original call.',
    capabilities: [
      'reasoning',
      'repo_read',
      'cross_repo_read',
      'shell',
      'http',
      'db_read',
      'db_write',
      'repo_write',
      'merge',
      'chain_read',
      'chain_send',
      'infra',
    ],
    costTier: 3,
    handsTo: [],
    source:
      'CLAUDE_RULES 9/13 + 23: merge authority, infra (Railway/Vercel/Porkbun/DNS), ' +
      'secrets, and anything ORIGINAL that can change live state.',
  },
] as const;

export const laneById = (id: LaneId): Lane | undefined => LANES.find((l) => l.id === id);

/** Does this lane actually have every capability the work needs? */
export function laneHas(lane: Lane, required: readonly Capability[]): boolean {
  return required.every((c) => lane.capabilities.includes(c));
}

/** The capabilities the work needs that this lane does not have. */
export function missingCapabilities(
  lane: Lane,
  required: readonly Capability[],
): Capability[] {
  return required.filter((c) => !lane.capabilities.includes(c));
}

export interface Assignment {
  assignable: boolean;
  lane: LaneId;
  missing: Capability[];
  /** Plain-language reason, suitable for a dispatch log. */
  reason: string;
}

/**
 * May this lane be given this work?
 *
 * A refusal here is the product, not an error. "T12 cannot take this because it needs
 * `http`" is infinitely more useful than a report from T12 containing a number it
 * could not have obtained.
 */
export function canAssign(laneId: LaneId, required: readonly Capability[]): Assignment {
  const lane = laneById(laneId);
  if (!lane) {
    return { assignable: false, lane: laneId, missing: [...required], reason: `unknown lane ${laneId}` };
  }
  const missing = missingCapabilities(lane, required);
  return missing.length === 0
    ? { assignable: true, lane: laneId, missing: [], reason: `${laneId} has all required capabilities` }
    : {
        assignable: false,
        lane: laneId,
        missing,
        reason:
          `${laneId} lacks ${missing.join(', ')} — routing this here yields a fabricated ` +
          `answer, not a failed one. Escalate to a lane that has it.`,
      };
}

/**
 * FREE-FIRST ROUTING. The cheapest lane that can genuinely do the work.
 *
 * This is the executable form of "prioritize the best free LLMs first": the sort is by
 * cost, so T12 is always tried first — but the capability fence means it is only
 * *reached* for work it can actually complete. Free-first without the fence is how
 * fabricated reports happen; the fence is what makes free-first safe.
 *
 * Returns undefined when nothing can do it, which is itself a finding: the work needs
 * a capability no lane has, and that is a gap to close rather than a task to dispatch.
 */
export function cheapestCapableLane(
  required: readonly Capability[],
  opts: { exclude?: readonly LaneId[] } = {},
): Lane | undefined {
  const excluded = new Set(opts.exclude ?? []);
  return [...LANES]
    .filter((l) => !excluded.has(l.id))
    .sort((a, b) => a.costTier - b.costTier)
    .find((l) => laneHas(l, required));
}

/**
 * Who may check this lane's work.
 *
 * Never the producer — self-verification is the failure this whole system is built
 * against. A verifier must also be able to *reach* the evidence: verifying a database
 * claim requires `db_read`, so XC cannot co-sign one no matter how good its reasoning
 * is. A confident review of evidence the reviewer never saw is worse than no review,
 * because it carries a signature.
 */
export function eligibleVerifiers(
  producer: LaneId,
  evidenceNeeds: readonly Capability[] = [],
): Lane[] {
  return LANES.filter((l) => l.id !== producer && laneHas(l, evidenceNeeds));
}
