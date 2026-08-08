/**
 * task-purpose.ts — purpose-aware gate for RepID/HAL scoring.
 *
 * REPID_HONEST_SCORING_v1: a HAL hallucination-veto should only move RepID on REAL
 * deliverables. Internal cron, DB-fact/operational tasks (which cross-LLM literally
 * cannot verify — no world-knowledge ground truth for "count tasks by status"),
 * adversarial red-team drills (tests, not work), and peer-verify/monitoring chores
 * are NOT hallucination-veto surfaces. Vetoing them false-flagged agents to the floor.
 *
 * This is `w_purpose` in the §7.1 update chain — a weight, not a binary exclude:
 * real deliverable = 1.0; non-deliverable veto = 0 (logged for calibration, never scored).
 * Weights are epoch-tunable — Sean owns the final values.
 *
 * Pure + deterministic. No I/O. Keyed primarily off task_domain (reliable), prompt secondary.
 */

export type TaskPurpose =
  | 'deliverable'   // real work product — HAL cross-LLM veto applies, full weight
  | 'operational'   // internal cron / DB-fact (count/query/report) — cross-LLM cannot verify
  | 'drill'         // CAIT adversarial red-team test — logged, never scores RepID
  | 'peer_verify'   // routes to peer-verify scoring, not a hallucination veto
  | 'monitoring'    // review/monitoring chores — not a deliverable
  | 'verification'  // verify-a-claim task — cross-LLM cannot verify DB/code claims
  | 'generation'    // generating adversarial/test content — adversarial by design, not a hallucination
  | 'panel_review'  // BFT verification-panel review of a code artifact — scored via HANDOFF_COSIGN, not HAL veto
  | 'investigation'; // v3: research/critique/investigation/capability-gap — exploratory analysis, not a verifiable deliverable

export interface PurposeVerdict {
  purpose: TaskPurpose;
  halVetoApplies: boolean; // does a HAL cross-LLM veto legitimately move RepID here?
  weight: number;          // multiplier on a HAL penalty (0..1) — `w_purpose`
  reason: string;
}

/**
 * Explicit deliverable domains — pinned deliverable-FIRST (XC red-team F1).
 *
 * task_domain is the reliable signal; prompt text is secondary. A real contracted
 * deliverable whose prompt happens to contain operational vocabulary ("count", "report",
 * "verify") must NOT be downgraded to a suppressed purpose, or it gets silently excused
 * from HAL scoring. This is the highest-risk false-negative the gate can create.
 *
 * Matrix failure closed by this set: `service_contract + "count tasks by status"`
 * classified as `operational` (HAL suppressed) — it must be `deliverable` (HAL applies).
 *
 * Lean inclusive here: over-inclusion means MORE real work is scored (the safe direction);
 * under-inclusion re-opens the false-negative. Epoch-tunable — Sean owns the final set.
 */
const DELIVERABLE_DOMAINS = new Set<string>([
  'service_contract',
  'code',
  'build',
  'implement',
  'deploy',
  'development',
  'feature',
  'engineering',
  'code_contribution',
  'bugfix',
  'refactor',
]);

/**
 * True when task_domain is an explicit real-work-product domain (the set above).
 *
 * Used by the score-event REWARD gate — distinct from {@link classifyTaskPurpose}, which
 * DEFAULTS unknown domains to `deliverable` so a HAL *penalty* still applies (correct for the
 * penalty direction, since an unknown domain shouldn't dodge a veto). That same default is
 * WRONG for *earning*: a free-form advisory chat run (`task_domain: 'general'`) must not be
 * granted a positive reward just for being unrecognized. A positive reward needs an affirmative
 * work signal — this returning true, or a HAL fact-check that returned clean. See the /run
 * "+19 per prompt" theater fix.
 */
export function isDeliverableDomain(taskDomain: string | null | undefined): boolean {
  return DELIVERABLE_DOMAINS.has((taskDomain || 'general').toLowerCase());
}

/**
 * CLASSIFIER v3 (CC-2) — PREFIX-AWARE tail non-deliverable domains.
 *
 * The v1 gate keyed off EXACT task_domain strings ('evergreen', 'cait', …). Live traffic
 * carries suffixed variants of the same families — 'EVERGREEN_AUDIT', 'diag_probe',
 * 'capability_gap', 'SHADOW_REJECT', 'cait_eval' — plus research/critique/investigation
 * chores. Exact-match let every one of those fall through to the DEFAULT (deliverable),
 * so a HAL cross-LLM veto could still drain RepID on a task that has no world-knowledge
 * ground truth (the same false-positive the purpose gate exists to stop).
 *
 * v3 matches a task_domain PREFIX. This is purely ADDITIVE: it only ever moves a task
 * from deliverable → non-deliverable (weight 0, both directions), never the reverse.
 * DELIVERABLE_DOMAINS is still checked FIRST (exact), so a real contracted deliverable
 * can never be down-classified by a prefix here. Epoch-tunable — Sean owns the final set.
 *
 * Rules are ordered longest/most-specific family first so a prefix never shadows a more
 * specific one (this table has no overlaps today, but the order documents the invariant).
 * Every prefix below is checked only against task_domain, never prompt text.
 */
interface DomainPrefixRule { prefixes: string[]; purpose: TaskPurpose; reason: string; }
const NON_DELIVERABLE_DOMAIN_PREFIXES: DomainPrefixRule[] = [
  // Operational / DB-fact / health-check / diagnostic — cross-LLM has no ground truth.
  // 'evergreen' also covers the v1 exact 'evergreen'; 'diag' covers diag_probe;
  // 'shadow_reject' covers a shadow-mode rejection record (telemetry, not a deliverable).
  { prefixes: ['evergreen', 'diag', 'shadow_reject'], purpose: 'operational',
    reason: 'operational/DB-fact/health-check/diagnostic domain — verify against source not cross-LLM; no world-knowledge ground truth' },
  // Adversarial CAIT evaluation — a test, not work. Distinct from the v1 exact 'cait' (drill)
  // so it never shadows that case; both are logged for calibration, never scored.
  { prefixes: ['cait_eval'], purpose: 'drill',
    reason: 'CAIT evaluation domain — adversarial drill; logged for calibration, not scored' },
  // Exploratory analysis — research / critique / investigation / capability-gap surveys.
  // No verifiable single-truth deliverable; a cross-LLM hallucination veto does not apply.
  { prefixes: ['capability_gap', 'research', 'critique', 'investigation'], purpose: 'investigation',
    reason: 'exploratory analysis (research/critique/investigation/capability-gap) — not a verifiable deliverable; cross-LLM veto does not apply' },
];

/** Prefix-aware lookup for a tail non-deliverable domain. Returns null when no family matches. */
function matchTailNonDeliverable(d: string): PurposeVerdict | null {
  for (const rule of NON_DELIVERABLE_DOMAIN_PREFIXES) {
    if (rule.prefixes.some((prefix) => d.startsWith(prefix))) {
      return { purpose: rule.purpose, halVetoApplies: false, weight: 0, reason: rule.reason };
    }
  }
  return null;
}

/**
 * Classify a task's scoring purpose from its domain (= task.task_type on the bridge)
 * and, secondarily, the prompt text. Default = real deliverable (full HAL scoring) so
 * an unknown/new domain is scored normally, not silently excused.
 *
 * `includeV3Tails` (default FALSE) gates the v3 CC-2 prefix-aware tail domains. Default
 * OFF keeps the output BYTE-IDENTICAL to v1 — SHADOW-FIRST: no live scoring delta changes
 * until Sean flips REPID_PURPOSE_GATE_V3=true (the pipeline reads the env; the classifier
 * stays a pure function of its arguments — no env access inside).
 */
export function classifyTaskPurpose(
  taskDomain: string | null | undefined,
  prompt?: string | null,
  includeV3Tails: boolean = false,
): PurposeVerdict {
  const d = (taskDomain || 'general').toLowerCase();
  const p = (prompt || '').toLowerCase();

  // F1 (XC red-team): explicit deliverable domains are pinned deliverable-FIRST — before any
  // prompt-text heuristic. task_domain is the reliable signal; prompt vocabulary is secondary
  // and must never override an explicit deliverable domain. Closes the service_contract false-negative.
  if (DELIVERABLE_DOMAINS.has(d)) {
    return { purpose: 'deliverable', halVetoApplies: true, weight: 1,
      reason: `explicit deliverable domain (${d}) — HAL cross-LLM veto applies at full weight; prompt heuristics do not override` };
  }

  // v3 (CC-2): PREFIX-AWARE tail non-deliverable domains. Runs after DELIVERABLE (so a real
  // deliverable is never down-classified) and before the prompt heuristics (task_domain is the
  // reliable signal). Additive — only tail families the v1 exact set missed (evergreen_audit,
  // diag_probe, capability_gap, shadow_reject, cait_eval, research/critique/investigation).
  // SHADOW-FIRST: gated OFF by default; enable via REPID_PURPOSE_GATE_V3 at the pipeline.
  if (includeV3Tails) {
    const tail = matchTailNonDeliverable(d);
    if (tail) return tail;
  }

  // Adversarial drills — tests. Never score reputation; keep telemetry for HAL calibration.
  if (d === 'cait' || /\bhal veto self-test|jailbreak|prompt.?injection|red.?team|adversarial\b/.test(p)) {
    return { purpose: 'drill', halVetoApplies: false, weight: 0,
      reason: 'adversarial drill (CAIT) — logged for calibration, not scored' };
  }

  // Internal cron / operational DB-fact / health-check — cross-LLM has no ground truth for operational data.
  if (d === 'evergreen' || d === 'system' || d === 'heal'
      || /\b(count|query|sample|monitor|report|review|check)\b[\s\S]{0,40}\b(task|registry|log|store|status|kv_store|cost|completion|queue|row)/.test(p)
      || /daily recurring[\s\S]{0,20}check https?:/.test(p)) {
    return { purpose: 'operational', halVetoApplies: false, weight: 0,
      reason: 'operational/DB-fact/health-check — verify against source not cross-LLM; no world-knowledge ground truth' };
  }

  // Verify-a-claim tasks — cross-LLM cannot verify a claim about OUR db/code. Route to verify scoring, not a hallucination veto.
  if (d === 'verification' || /\bindependently verify (the |that )/.test(p)) {
    return { purpose: 'verification', halVetoApplies: false, weight: 0,
      reason: 'verify-a-claim — cross-LLM cannot verify a claim about our DB/code; route to verify scoring' };
  }

  // Generating adversarial / test content — the content is adversarial BY DESIGN; not a hallucination.
  if (d === 'hal_corpus_generation' || d === 'corpus_generation'
      || /generate\b[\s\S]{0,30}\b(adversarial|test case)/.test(p)) {
    return { purpose: 'generation', halVetoApplies: false, weight: 0,
      reason: 'generating adversarial/test content — adversarial by design, not a hallucination' };
  }

  // Peer-verify / review — route to the peer-verify scoring surface, not a hallucination veto.
  if (d === 'peer_verify') {
    return { purpose: 'peer_verify', halVetoApplies: false, weight: 0,
      reason: 'peer_verify — routes to peer-verify scoring, not a hallucination veto' };
  }
  if (d === 'review' || d === 'monitoring') {
    return { purpose: 'monitoring', halVetoApplies: false, weight: 0,
      reason: `${d} — monitoring chore, not a deliverable` };
  }

  // BFT verification-panel review of a real code artifact (SHA-bound) — scored via the panel verdict /
  // HANDOFF_COSIGN path (+10 aligned / -5 diverged), NOT a cross-LLM hallucination veto. Suppress HAL here.
  if (d === 'verification_panel' || d === 'code_review_sha_bound') {
    return { purpose: 'panel_review', halVetoApplies: false, weight: 0,
      reason: 'BFT panel review of a code artifact — scored via panel verdict/HANDOFF_COSIGN, not cross-LLM fact-check' };
  }

  // Default: real deliverable — full HAL cross-LLM veto scoring.
  return { purpose: 'deliverable', halVetoApplies: true, weight: 1,
    reason: 'real deliverable — HAL cross-LLM veto applies at full weight' };
}
