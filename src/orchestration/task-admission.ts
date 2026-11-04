/**
 * orchestration/task-admission.ts — equip-or-abstain admission for a swarm task. Decide, BEFORE a task is
 * claimed, which grounding capabilities it needs; if the agent does not hold them, ABSTAIN — never fabricate.
 *
 * THE FAILURE IT CLOSES [V 2026-11-03]. Three T12 tasks were marked "done" and were fabricated. The root cause
 * was setup, not malice: each needed a grounding tool the agent did not have, and instead of saying "I can't,"
 * the agent invented output. The SY-15 "audit" needed to READ THE REPO and SEARCH CODE — it had neither, so it
 * cited `src/engine/config.js` (a .js file in a .ts-only repo). The disclosure audit needed GITHUB + the WEB —
 * it had neither, so it declared "no public disclosures" of a public repo. The prior-art task needed WEB SEARCH
 * and simply failed. An agent that knew the task needed `web_search` and that it held none would have abstained.
 * This module is that knowledge, made mechanical: classify the required capabilities, compare to what is held,
 * and gate acceptance on being fully equipped.
 *
 * ABSTAIN BEATS FABRICATE — the whole point. A missing capability yields a REFUSAL to accept with a named gap
 * ("missing: web_search"), which the runtime surfaces as an honest abstention. Rewarding abstention and
 * penalizing fabrication is the scoring layer's job (the integrity-event axis), not this module's; here we only
 * make the honest path the available one. An abstention is a correct outcome, never an error.
 *
 * COMPOSES WITH THE ANTIBODY. The classifier is CONSERVATIVE: it requires a capability only when the need is
 * clear, and a task matching nothing requires nothing (so a pure reasoning/generation task is never blocked).
 * That leaves a gap — a grounding need the keywords miss — which the provenance antibody (immune/provenance-
 * antibody.ts) backstops post-hoc by rejecting any citation that does not resolve. Admission PREVENTS the known
 * fabrications at the source; the antibody CATCHES the rest after. Defense in depth.
 *
 * PURE + INERT. `requiredCapabilities`, `admitWithCapabilities` and `admitTask` are pure, total, deterministic —
 * no I/O, no DB, no clock. A caller wires `admitTask` into the T12 wave before a row is claimed and records
 * `manifest` on the receipt; nothing here claims, scores, or writes. Rules are keyed off task_domain (reliable)
 * and prompt (secondary), exactly as scoring/task-purpose.ts is, and are EPOCH-TUNABLE — Sean owns the final set.
 *
 * THE CLASSIFIER IS PLUGGABLE; LAYA IS THE CAPABLE PATH. The gate is split from the classifier: `requiredCapabilities`
 * (this keyword/domain classifier) produces the required set, and `admitWithCapabilities` is the pure decision over
 * it. The keyword classifier is the DETERMINISTIC, FAIL-CLOSED FALLBACK — it runs offline, is testable, and never
 * depends on a model being up. The capable path is Laya (github.com/NandhaKishorM/laya), the non-autoregressive
 * System-1 decision engine the repo already speaks to via jevClassify (src/jev/classify.ts → loopback `laya-serve`,
 * `POST /v1/systemone`): it answers one typed `noul` per capability ("does this task require web_search?") in a
 * single forward pass, multilingual. Wiring it is the same shape as jev — behind a flag, loopback-only, and
 * FALLING BACK to this keyword classifier whenever Laya is unavailable, times out, or returns nothing (never fail
 * open). That wiring is a separate (owner-gated) piece; this module is the inert gate + fallback it falls back to.
 */

/** A grounding capability a task may require — a source of truth an LLM cannot supply by itself. The absence of
 * one of these, met with fabrication instead of abstention, is what produced the 2026-11-03 failures. */
export type Capability =
  | 'repo_read' // read the actual repository files
  | 'code_search' // search code / symbols / callers
  | 'web_search' // fetch or search the live web
  | 'github' // query GitHub — repo visibility, PRs, issues, commits
  | 'package_registry' // npm / pypi version + release lookups
  | 'db_read' // query the live database (Supabase)
  | 'chain_read'; // read on-chain state (BaseScan / Base Sepolia)

export const ALL_CAPABILITIES: readonly Capability[] = [
  'repo_read', 'code_search', 'web_search', 'github', 'package_registry', 'db_read', 'chain_read',
];

/** What the classifier sees. task_domain is the reliable signal; prompt is secondary (same as task-purpose.ts). */
export interface TaskDescriptor {
  task_domain?: string | null;
  prompt: string;
}

export interface AdmissionDecision {
  /** true ⇒ the agent holds every required capability and may accept the task. */
  accepted: boolean;
  /** capabilities the task requires (sorted, deduped). */
  required: Capability[];
  /** required capabilities the agent does NOT hold — the reason to abstain (empty when accepted). */
  missing: Capability[];
  /** the equipped manifest to record on the receipt when accepted (= required); empty on abstain. */
  manifest: Capability[];
  /** human/agent-facing line: what was equipped, or what is missing and that it must abstain not fabricate. */
  reason: string;
}

/** A classifier rule: a capability, the task_domain prefixes that imply it, and a prompt pattern that implies it.
 * Grounded in the real tasks — the comment on each names the failure it would have caught. Epoch-tunable. */
interface CapabilityRule {
  cap: Capability;
  domainPrefixes: string[];
  prompt: RegExp;
}

const RULES: CapabilityRule[] = [
  // SY-15 "audit": reviewed a config loader + HAL verifier it never read → cited nonexistent .js files.
  { cap: 'repo_read', domainPrefixes: ['security_audit', 'code_audit', 'audit', 'sy-', 'sy_'],
    prompt: /\b(audit|review|inspect|examine|read|trace)\b[\s\S]{0,40}\b(code|source|file|repo|repositor|codebase|implementation|loader|verifier|module|function|class)\b|(^|[\s"'`(])src\//i },
  { cap: 'code_search', domainPrefixes: ['security_audit', 'code_audit'],
    prompt: /\b(grep|callers?|usages?|references?|call\s*sites?)\b|\b(find|locate|search|where\s+is)\b[\s\S]{0,30}\b(code|function|symbol|method|class|variable|definition|implementation|in\s+the\s+(repo|codebase|source))\b|\b(file|function|symbol)\b[\s\S]{0,20}:\d+/i },
  // prior-art task: needed the live web; had nothing, failed.
  { cap: 'web_search', domainPrefixes: ['research', 'prior_art', 'literature', 'news', 'market', 'competitor'],
    prompt: /\b(prior[\s-]?art|patent|literature|state[\s-]of[\s-]the[\s-]art|novelty|search\s+the\s+web|competitor|market\s+(research|scan)|latest\s+news|benchmark\s+against|external\s+sources?)\b/i },
  // disclosure audit: concluded "no public disclosures" of a PUBLIC repo it never checked on GitHub.
  { cap: 'github', domainPrefixes: ['disclosure', 'ip', 'patent'],
    prompt: /\b(disclos\w*|publicly\s+(available|disclosed|visible)|repositor\w*\s+(is|was|are)\s+public|pull\s+requests?|\bPRs?\b|\bissues?\b|github|commit\s+history|stargazers?)\b/i },
  { cap: 'web_search', domainPrefixes: ['disclosure'],
    prompt: /\b(disclos\w*|publicly\s+(available|disclosed))\b/i },
  // version lookups: "what is the npm version" — must hit the registry, not guess.
  { cap: 'package_registry', domainPrefixes: ['release', 'version'],
    prompt: /\b(npm|pypi|cargo|package\s+(version|name)|latest\s+(version|release)|dependency\s+version|published\s+version|on\s+the\s+registry|semver)\b/i },
  // live-state questions: cross-LLM has no ground truth; must query the DB (CLAUDE_RULES r1).
  { cap: 'db_read', domainPrefixes: ['operational', 'db_fact', 'evergreen', 'diag'],
    prompt: /\b(right\s+now|currently|live\s+(count|state)|as\s+of\s+today|how\s+many\b[\s\S]{0,40}\b(in|are)\b[\s\S]{0,20}\b(db|database|supabase|table|rows?)|query\s+the\s+(db|database|supabase)|is\b[\s\S]{0,40}\btrue\s+(right\s+)?now)\b/i },
  // on-chain claims: must read the chain, not assert.
  { cap: 'chain_read', domainPrefixes: ['onchain', 'on_chain', 'chain', 'attestation'],
    prompt: /\b(on[\s-]?chain|attestation|transaction\s+hash|\btx\b|basescan|base\s+sepolia|anchored|erc[\s-]?8004|block\s*(number|height))\b/i },
];

/**
 * The required grounding capabilities for a task. Pure: keyed off task_domain prefix (reliable) and prompt
 * keywords (secondary). Conservative — a task matching no rule requires nothing (pure reasoning/generation is
 * never blocked; the provenance antibody backstops any citation it later makes). Sorted + deduped, stable order.
 */
export function requiredCapabilities(task: TaskDescriptor): Capability[] {
  const domain = (task.task_domain ?? '').toLowerCase();
  const prompt = typeof task.prompt === 'string' ? task.prompt : '';
  const need = new Set<Capability>();
  for (const rule of RULES) {
    if (rule.domainPrefixes.some((p) => domain.startsWith(p)) || rule.prompt.test(prompt)) need.add(rule.cap);
  }
  return ALL_CAPABILITIES.filter((c) => need.has(c)); // stable canonical order
}

/**
 * The pure gate over an already-classified required set — the seam a Laya-backed classifier plugs into. Fully
 * equipped ⇒ accept, carrying the equipped manifest for the receipt. Any missing required capability ⇒ do not
 * accept; abstain with the gap named. Pure, total, never throws.
 */
export function admitWithCapabilities(input: { required: readonly Capability[]; held: readonly Capability[] }): AdmissionDecision {
  const required = [...input.required];
  const heldSet = new Set(input.held);
  const missing = required.filter((c) => !heldSet.has(c));
  if (missing.length === 0) {
    return {
      accepted: true,
      required,
      missing,
      manifest: required,
      reason: required.length === 0 ? 'no external capability required' : `equipped: ${required.join(', ')}`,
    };
  }
  return {
    accepted: false,
    required,
    missing,
    manifest: [],
    reason: `missing: ${missing.join(', ')} — abstain, do not fabricate`,
  };
}

/**
 * Equip-or-abstain for a task, using the deterministic keyword classifier. The convenience entry point; a
 * Laya-backed wiring would compute `required` via Laya (falling back to {@link requiredCapabilities}) and call
 * {@link admitWithCapabilities} directly. Pure, total, never throws.
 */
export function admitTask(input: { task: TaskDescriptor; held: readonly Capability[] }): AdmissionDecision {
  return admitWithCapabilities({ required: requiredCapabilities(input.task), held: input.held });
}
