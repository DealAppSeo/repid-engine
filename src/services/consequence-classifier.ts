/**
 * CONSEQUENCE CLASSIFIER — DRY-RUN (CC, 2026-06-24).
 * Implements §3 of agent-decision-governance-spec-v0.3 ("Consequence tiers"). This is the
 * deterministic, default-deny gate-keeper described as "boring, deterministic, default-deny" (§1):
 *
 *   T0  Trivial / reversible      → act, no gate
 *   T1  Consequential but bounded → adversarial gate (§4)
 *   T2  Critical / irreversible   → ALWAYS HITL
 *
 * FOUR LOCKS from the spec are baked in here:
 *   - [LOCK A5] T2 is a DETERMINISTIC RULE ALLOWLIST, never LLM judgment.
 *   - [LOCK A4] Any action matching NO rule → fail-to-HITL (treated as T2). No fail-open.
 *   - [§2 binding] Consequence is derived from action-type properties bound to INFRA FACTS
 *     (prod project id, migration path, secret surface, protected git ref, cost) — NEVER from
 *     self-reported agent intent. The `Action` shape below carries only infra-bound fields.
 *   - [LOCK A5 no-downgrade] An LLM may *suggest* a tier; it may NEVER downgrade below the rule
 *     floor. `classifyAction` enforces the floor deterministically; the LLM hook is advisory and
 *     can only ESCALATE (max-by-severity).
 *
 * Pure module: no I/O, no enforcement. The gate (consequence-gate.ts) decides what to do with the
 * verdict; in this sprint that is shadow-log only.
 *
 * r5 HARDENING (CC, 2026-06-24): the round-4 red-team breached 6 cases because the classifier
 * matched RAW strings. Fixed at the ROOT — every input is CANONICALIZED before matching:
 *   - DDL is scanned in any action carrying `sql`, regardless of declared `kind` (ddl-001).
 *   - git refs are canonicalized (trim / refs-heads / origin / case / homoglyph) (git-001/2/3).
 *   - prod identifiers appearing ANYWHERE in the action (incl. description) floor to T2 (path-005).
 *   - spend is governed by an aggregate cumulative + velocity cap, not just per-action (cost-001).
 */

import {
  canonicalizeText,
  canonicalizeGitRef,
  findDdlKeyword,
} from './canonicalize';
import {
  type SpendWindowSnapshot,
  type SpendTrackerConfig,
  DEFAULT_SPEND_TRACKER_CONFIG,
  spendBreachesWindow,
} from './spend-tracker';

export type Tier = 'T0' | 'T1' | 'T2';

/** Severity ordering so "floor" / "never downgrade" is unambiguous. T2 is the most severe. */
const TIER_SEVERITY: Record<Tier, number> = { T0: 0, T1: 1, T2: 2 };

/** The more-severe of two tiers (used to enforce the rule floor against any LLM suggestion). */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_SEVERITY[a] >= TIER_SEVERITY[b] ? a : b;
}

/**
 * An action to classify. EVERY field is an infra-bound fact about WHAT the action does — not an
 * agent's claim about how risky it thinks the action is. There is intentionally no `intent`,
 * `selfTier`, or `bounty` field: per §2/§7 those are ignored by the classifier.
 */
export interface Action {
  /** Coarse action type, bound to a real operation surface. */
  kind:
    | 'file_write'      // create/modify/delete a file
    | 'git'             // a git operation (push / merge / commit)
    | 'db'              // a database statement (DDL or DML)
    | 'platform'        // a hosting-platform mutation (Railway/Vercel/Supabase config)
    | 'secret'          // secret read/rotation
    | 'spend'           // a dollar-cost action
    | 'http'            // an outbound network call
    | 'shell'           // a shell command
    | 'read'            // a pure read / query
    | string;           // forward-compatible; unknown kinds fall through to the fail-safe
  /** Filesystem paths the action touches (repo-relative or absolute). */
  paths?: string[];
  /** Raw SQL, if kind === 'db'. Scanned for DDL keywords. */
  sql?: string;
  /** Git operation detail, if kind === 'git'. */
  git?: { operation?: 'push' | 'merge' | 'commit' | string; targetRef?: string | null };
  /** Infra/project identifier the action targets (e.g. a Supabase project id). */
  projectId?: string | null;
  /** Hosting platform + whether the target is a production surface. */
  platform?: { name?: string; isProd?: boolean } | null;
  /** Estimated dollar cost of the action, if any. */
  costUsd?: number | null;
  /** Whether the action targets a known-local / gitignored / test-only surface (reversible). */
  localOnly?: boolean;
  /** Free-form label for logging only — NEVER read by a classification rule. */
  description?: string;
}

/** Tunable, infra-bound thresholds. Mirrored by governance/policy.yaml (Phase 4). */
export interface ClassifierConfig {
  /** Prod project ids that are always T2 (spec §3 names qnnpjhlxljtqyigedwkb). */
  prodProjectIds: string[];
  /** Git refs that are protected — push/merge to these is T2. */
  protectedRefs: string[];
  /** Path globs (substring/regex) that are always T2. */
  criticalPathPatterns: RegExp[];
  /** DDL keywords that make any sql-carrying action T2. */
  ddlKeywords: string[];
  /** Cost (USD) at or above which a spend is T2. Below it (but > 0) is T1. */
  costT2ThresholdUsd: number;
  /** Remote/heads prefixes stripped from a git ref before matching protectedRefs. Optional. */
  gitRefStripPrefixes?: string[];
  /** Aggregate spend cap (cumulative + velocity) applied when a spend-window snapshot is supplied. Optional. */
  spend?: SpendTrackerConfig;
}

/** [LOCK A5] The default allowlist — the literal surfaces enumerated in spec §3. */
export const DEFAULT_CONFIG: ClassifierConfig = {
  // [V] prod project id from spec §3 / repo CLAUDE.md.
  prodProjectIds: ['qnnpjhlxljtqyigedwkb'],
  protectedRefs: ['main', 'master', 'production', 'prod', 'release'],
  criticalPathPatterns: [
    /(^|\/)migrations\//i,       // DB migrations
    /(^|\/)\.env(\.|$)/i,        // secret files
    /(^|\/)keymap/i,             // keymap* per spec
    /(^|\/)secrets?\//i,         // secret directories
    /\.pem$|\.key$/i,            // key material
    /(^|\/)governance\/policy\./i, // the classifier policy is itself T2 (govern-the-governor)
  ],
  ddlKeywords: ['alter', 'drop', 'create', 'truncate', 'grant', 'revoke'],
  costT2ThresholdUsd: 1.0,
  gitRefStripPrefixes: ['refs/remotes/origin/', 'refs/heads/', 'refs/remotes/', 'origin/', 'upstream/'],
  spend: DEFAULT_SPEND_TRACKER_CONFIG,
};

export type RuleId =
  | 'T2_PROD_PROJECT' | 'T2_CRITICAL_PATH' | 'T2_DDL' | 'T2_PROTECTED_GIT'
  | 'T2_SECRET' | 'T2_PLATFORM_PROD' | 'T2_HIGH_COST'
  | 'T2_PROD_IDENTIFIER_IN_TEXT' | 'T2_SPEND_VELOCITY'
  | 'T1_MERGE' | 'T1_NONPROD_CONFIG' | 'T1_BOUNDED_SPEND' | 'T1_FEATURE_PUSH'
  | 'T0_LOCAL' | 'T0_READ'
  | 'UNMATCHED_FAILSAFE';

export interface RuleHit { ruleId: RuleId; tier: Tier; reason: string; }

export interface Classification {
  /** Final tier the gate should act on (rule floor, possibly escalated by an LLM suggestion). */
  tier: Tier;
  /** The deterministic floor — what the rules alone decided, ignoring any LLM input. */
  ruleFloor: Tier;
  /** Every rule that fired, for audit. Empty array ⇒ unmatched ⇒ fail-safe T2. */
  hits: RuleHit[];
  /** True when no classification rule matched and the action defaulted to T2 (§3 LOCK A4). */
  failSafe: boolean;
  /** What an LLM suggested, if a suggestion was provided (display/audit only). */
  llmSuggested?: Tier | null;
}

/** Canonicalize a path for matching: backslash→slash, fold homoglyphs, lowercase. */
function canonicalizePath(p: string): string {
  return canonicalizeText(p.replace(/\\/g, '/'));
}

function anyPattern(patterns: RegExp[], values: string[]): boolean {
  return values.some((v) => patterns.some((p) => p.test(v)));
}

/** Gather every free-form/identifier-bearing string on the action, canonicalized, for a text scan. */
function gatherText(action: Action): string {
  const parts: string[] = [];
  if (action.description) parts.push(action.description);
  if (action.projectId) parts.push(action.projectId);
  if (action.sql) parts.push(action.sql);
  if (action.git?.targetRef) parts.push(action.git.targetRef);
  if (action.platform?.name) parts.push(action.platform.name);
  for (const p of action.paths ?? []) parts.push(p.replace(/\\/g, '/'));
  return canonicalizeText(parts.join(' \n '));
}

/** Context the classifier may use beyond the action's own fields (e.g. the live spend window). */
export interface EvalContext {
  /** Rolling spend-window snapshot BEFORE this action (from a SpendTracker). Enables velocity cap. */
  spendContext?: SpendWindowSnapshot;
}

/**
 * Evaluate every deterministic rule against the action and return all hits. Order does not matter:
 * the final floor is the MAX severity across hits (a single T2 hit dominates any T0/T1 hits).
 * All string inputs are CANONICALIZED before matching (r5).
 */
export function evaluateRules(
  action: Action,
  config: ClassifierConfig = DEFAULT_CONFIG,
  ctx: EvalContext = {},
): RuleHit[] {
  const hits: RuleHit[] = [];
  const canonPaths = (action.paths ?? []).map(canonicalizePath);
  const stripPrefixes = config.gitRefStripPrefixes ?? DEFAULT_CONFIG.gitRefStripPrefixes;
  const spendCfg = config.spend ?? DEFAULT_SPEND_TRACKER_CONFIG;

  // ---- T2 rules (deterministic critical allowlist) ----
  if (action.projectId && config.prodProjectIds.some((id) => canonicalizeText(action.projectId!) === canonicalizeText(id))) {
    hits.push({ ruleId: 'T2_PROD_PROJECT', tier: 'T2', reason: `targets prod project ${action.projectId}` });
  }
  if (canonPaths.length && anyPattern(config.criticalPathPatterns, canonPaths)) {
    hits.push({ ruleId: 'T2_CRITICAL_PATH', tier: 'T2', reason: `touches critical path pattern (${(action.paths ?? []).join(', ')})` });
  }
  // [r5 ddl-001] DDL is scanned in ANY action carrying sql, regardless of declared kind.
  if (action.sql) {
    const kw = findDdlKeyword(action.sql, config.ddlKeywords);
    if (kw) hits.push({ ruleId: 'T2_DDL', tier: 'T2', reason: `DDL keyword "${kw}" in sql (kind=${action.kind})` });
  }
  // [r5 git-001/2/3] canonicalize the ref (trim / refs-heads / origin / case / homoglyph) before matching.
  if (action.kind === 'git' && (action.git?.operation === 'push' || action.git?.operation === 'merge')) {
    const ref = canonicalizeGitRef(action.git.targetRef ?? '', stripPrefixes);
    if (config.protectedRefs.map((r) => canonicalizeText(r)).includes(ref)) {
      hits.push({ ruleId: 'T2_PROTECTED_GIT', tier: 'T2', reason: `git ${action.git.operation} to protected ref "${ref}" (raw "${action.git.targetRef}")` });
    }
  }
  if (action.kind === 'secret') {
    hits.push({ ruleId: 'T2_SECRET', tier: 'T2', reason: 'secret read/rotation surface' });
  }
  if (action.kind === 'platform' && action.platform?.isProd) {
    hits.push({ ruleId: 'T2_PLATFORM_PROD', tier: 'T2', reason: `prod platform mutation (${action.platform.name ?? 'unknown'})` });
  }
  if (typeof action.costUsd === 'number' && action.costUsd >= config.costT2ThresholdUsd) {
    hits.push({ ruleId: 'T2_HIGH_COST', tier: 'T2', reason: `cost $${action.costUsd} ≥ T2 threshold $${config.costT2ThresholdUsd}` });
  }
  // [r5 path-005] prod identifiers (project id / critical path) appearing ANYWHERE in the action's
  // text (incl. description) floor to T2. Scoped to high-specificity identifiers only — NOT DDL
  // keywords or git refs — so prose / code comments don't over-block (XC Class-7 safe).
  {
    const text = gatherText(action);
    const idHit = config.prodProjectIds.find((id) => text.includes(canonicalizeText(id)));
    const pathHit = config.criticalPathPatterns.some((p) => p.test(text));
    if (idHit || pathHit) {
      hits.push({
        ruleId: 'T2_PROD_IDENTIFIER_IN_TEXT', tier: 'T2',
        reason: idHit ? `prod project id "${idHit}" present in action text` : 'critical path identifier present in action text',
      });
    }
  }
  // [r5 cost-001] aggregate spend cap — a sub-threshold spend that would breach cumulative/velocity
  // in the rolling window is T2 (cost-splitting). A lone one-off sub-threshold spend stays T1.
  if (typeof action.costUsd === 'number' && action.costUsd > 0 && ctx.spendContext) {
    const breach = spendBreachesWindow(action.costUsd, ctx.spendContext, spendCfg);
    if (breach) hits.push({ ruleId: 'T2_SPEND_VELOCITY', tier: 'T2', reason: breach });
  }

  // ---- T1 rules (consequential but bounded) ----
  if (action.kind === 'git' && action.git?.operation === 'merge') {
    const ref = canonicalizeGitRef(action.git.targetRef ?? '', stripPrefixes);
    if (!config.protectedRefs.map((r) => canonicalizeText(r)).includes(ref)) {
      hits.push({ ruleId: 'T1_MERGE', tier: 'T1', reason: `merge to non-protected ref "${ref || 'unspecified'}"` });
    }
  }
  if (action.kind === 'platform' && action.platform && !action.platform.isProd) {
    hits.push({ ruleId: 'T1_NONPROD_CONFIG', tier: 'T1', reason: `non-prod config change (${action.platform.name ?? 'unknown'})` });
  }
  if (typeof action.costUsd === 'number' && action.costUsd > 0 && action.costUsd < config.costT2ThresholdUsd) {
    hits.push({ ruleId: 'T1_BOUNDED_SPEND', tier: 'T1', reason: `bounded spend $${action.costUsd} < $${config.costT2ThresholdUsd}` });
  }
  if (action.kind === 'git' && action.git?.operation === 'push') {
    const ref = canonicalizeGitRef(action.git.targetRef ?? '', stripPrefixes);
    if (!config.protectedRefs.map((r) => canonicalizeText(r)).includes(ref)) {
      hits.push({ ruleId: 'T1_FEATURE_PUSH', tier: 'T1', reason: `push to feature ref "${ref || 'unspecified'}"` });
    }
  }

  // ---- T0 rules (trivial / reversible) ----
  if (action.kind === 'read') {
    hits.push({ ruleId: 'T0_READ', tier: 'T0', reason: 'pure read / query' });
  }
  if (action.localOnly === true && (action.kind === 'file_write' || action.kind === 'shell')) {
    hits.push({ ruleId: 'T0_LOCAL', tier: 'T0', reason: 'local-only / gitignored / reversible surface' });
  }

  return hits;
}

/** The deterministic floor: max-severity tier across rule hits, or T2 if nothing matched (A4). */
export function ruleFloor(hits: RuleHit[]): { tier: Tier; failSafe: boolean } {
  if (hits.length === 0) return { tier: 'T2', failSafe: true }; // [LOCK A4] unmatched → fail-to-HITL
  let floor: Tier = 'T0';
  for (const h of hits) floor = maxTier(floor, h.tier);
  return { tier: floor, failSafe: false };
}

/**
 * The advisory LLM hook. In this dry-run it is a STUB returning null (no suggestion). Wiring a
 * real model later must keep this contract: the return value is ONLY ever used to ESCALATE via
 * `maxTier`. It can never lower the deterministic floor. [LOCK A5 no-downgrade]
 */
export type LlmSuggestHook = (action: Action) => Tier | null;
export const noopLlmSuggest: LlmSuggestHook = () => null;

/**
 * Classify an action into T0/T1/T2.
 * @param action       infra-bound action facts
 * @param opts.config  rule allowlist (defaults to DEFAULT_CONFIG)
 * @param opts.llmSuggest advisory hook (defaults to no-op). Can only escalate, never downgrade.
 */
export function classifyAction(
  action: Action,
  opts: { config?: ClassifierConfig; llmSuggest?: LlmSuggestHook; spendContext?: SpendWindowSnapshot } = {},
): Classification {
  const config = opts.config ?? DEFAULT_CONFIG;
  const llmSuggest = opts.llmSuggest ?? noopLlmSuggest;

  const hits = evaluateRules(action, config, { spendContext: opts.spendContext });
  const floor = ruleFloor(hits);

  // The LLM may only raise the tier. max(floor, suggestion) by severity guarantees no downgrade.
  const suggested = llmSuggest(action);
  const tier = suggested ? maxTier(floor.tier, suggested) : floor.tier;

  return {
    tier,
    ruleFloor: floor.tier,
    hits,
    failSafe: floor.failSafe,
    llmSuggested: suggested ?? null,
  };
}
