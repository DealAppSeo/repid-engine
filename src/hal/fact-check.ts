/**
 * HAL fact-check evaluator — question-shaped cross-LLM truth signal.
 *
 * WHY THIS EXISTS (CC2 calibration, 2026-05-23): the extractor (strictness:1)
 * cannot discriminate truth on short factual deliverables (harm/scope flat 0.00,
 * epistemic constant 0.45). And the canonical comma-BFT agreement lib
 * (src/hal/lib/*) compares provider *answers to a declarative prompt* — which
 * measures phrasing similarity, NOT truth (a false "Berlin is the capital of
 * France" scored HIGHER agreement than the true "Paris"). It also inflates the
 * score when a provider rate-limits (agreement→0).
 *
 * This module takes the opposite, question-shaped approach: ask each free
 * provider to VERIFY the claim (TRUE/FALSE/UNCERTAIN + confidence as JSON), then
 * aggregate verdicts into a 0..1 hal_score (higher = more likely false/risky).
 * It does NOT touch src/hal/lib/* (which stays the canonical comma-BFT path).
 *
 * Resilient (RULE-8): bounded per-provider timeout, Promise.allSettled, degrades
 * gracefully (3→2→1→0 providers); 0 providers → caller falls back to extractor.
 */

import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import { recordProviderCall } from '../cache/provider-health'; // S-CACHE — real-time provider health
import crypto from 'crypto';
// DATA-LOCALITY (self-host). The fact-check quorum sends the deliverable TEXT (content) to each
// provider — the verify path's prompt egress. LOCAL_LLM_BASE_URL redirects openai-compat endpoints
// to a local server; ONLY_ATTESTATIONS_LEAVE refuses any remaining cloud prompt egress. Both are
// default-OFF: unset → hosted behavior byte-identical.
import { resolveProviderEndpoint } from './local-llm';
import { assertPromptEgressAllowed } from '../selfhost/egress-guard';
// CROSS-FIX 2026-07-05 — hardened registry-family lookup (single source of family truth). resolveFamily
// is REGISTRY-ONLY and THROWS on an unmapped/ambiguous model. HAL is a LIVE scoring path and MUST NOT
// throw here, so it is consumed ONLY via familyOfResolved() below (registry-primary, regex-fallback,
// loud flag). This import is safe against the family-registry <-> fact-check cycle: family-registry
// imports the HOISTED familyOf() declaration at load time; fact-check calls resolveFamily() only at
// runtime (inside functions), never at module init. See familyOfResolved() for the fallback contract.
import { resolveFamily } from '../decisioning/family-registry';
// GROUND-TRUTH GATE — Trinity's own recorded facts, consulted after the quorum.
// The external quorum demonstrably vetoes TRUE claims about our private systems
// (measured 2026-08-13); see src/hal/ground-truth-gate.ts for the numbers.
import { checkGroundTruth, type GroundTruthResult } from './ground-truth-gate';
// BFT ANTI-SPOOF (audit item #4, 2026-08-07) — registry-hard-fail disjointness enforcement for the live
// quorum. selectDisjointQuorum() is the first LIVE caller of the src/decisioning/disjointness.ts module
// (assertDisjoint/assembleDisjointJudges previously had none). Imported inertly; only invoked under the
// BFT_DISJOINT_ENFORCE flag (default OFF) in factCheck(), so importing it changes nothing until enabled.
import { selectDisjointQuorum } from '../decisioning/disjointness';
// WEIGHT-DEDUP (2026-07-09, reports/2026-07-09 HAL eval): dedup the quorum by model CHECKPOINT
// (weights identity) so two hosts serving the SAME weights (e.g. Groq + DeepInfra Llama-3.1-8B, eval
// corr 0.881) can never count as two independent votes. Flag-gated (HAL_QUORUM_WEIGHT_DEDUP:
// off|shadow|on), SHADOW-first — off/shadow do NOT change the live quorum. See src/hal/checkpoint-registry.ts.
import {
  resolveCheckpoint,
  dedupByCheckpoint,
  stochasticCheckpointDiverseSubset,
  weightDedupMode,
  stochasticK,
  type WeightDedupMode,
} from './checkpoint-registry';
import {
  sbfaConsensus,
  votesFromVerdicts,
  ConstantReliabilityOracle,
  type SbfaDecision,
  type SbfaTrace,
  type StakesLevel,
  type ActionKind,
} from './sbfa-consensus';
// WS1.2a DUAL-PATH RETRIEVAL (2026-07-18, reports/2026-07-18/ANTIFRAGILE_PROVENANCE_PROGRAM_v0.md
// §ARCHITECTURE — SETTLED). The confidence-triggered SLOW PATH: when the fast parametric quorum is
// uncertain/high-stakes, retrieve web evidence and grade it (CRAG) to REFINE the decision. Entirely
// behind HAL_RETRIEVAL_ENABLED (default OFF/shadow) — importing these modules changes nothing until
// the flag is on, and both modules NEVER throw (failure → fast-path decision preserved). See the
// gated block near the end of factCheck() and src/hal/retrieval.ts + src/hal/crag.ts.
import { retrieveEvidence } from './retrieval';
import { grokApiKey } from '../providers/xai-key';
import { gradeEvidence, type CragResult, type CragGrade } from './crag';
import { publishDetectorSnapshot } from '../services/detector-coverage';

export interface FactCheckProviderCfg {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  family?: string; // R5 — independent model family (groq-Llama + cerebras-Llama = ONE family/vote)
  tier?: 'free' | 'cheap' | 'escalation'; // R6 — cost class for cheapest-first quorum assembly
}

/**
 * R6 — cost class for cheapest-first quorum assembly. free (groq/gemini/cerebras/mistral/qwen) →
 * cheap-paid (deepseek) → escalation (fireworks/anthropic/openai/asi1/togetherai/litellm). The quorum
 * stops escalating the moment >= 2 distinct families respond, so pricier providers are only paid for
 * when the free tier can't form a quorum.
 */
export function costTierOf(p: { name: string; family?: string }): 'free' | 'cheap' | 'escalation' {
  const k = `${p.name} ${p.family ?? ''}`.toLowerCase();
  if (/groq|gemini|gemma|cerebras|glm|zai|mistral|mixtral|qwen|llama/.test(k)) return 'free';
  if (/deepseek/.test(k)) return 'cheap';
  return 'escalation'; // fireworks/anthropic/openai/asi1/togetherai/litellm/cohere/kimi
}

/**
 * R5 — map a model name to its independent FAMILY. Quorum counts DISTINCT families, not hosts: two
 * hosts serving the same base model (e.g. groq + a mis-configured cerebras both on Llama) are ONE
 * independent vote, not two. Keyed by model so a host swapping models is reclassified automatically.
 */
export function familyOf(model: string): string {
  // V3 FIX 2026-07-05 (fuzz-hardening) — coerce to string at the root. `(model || '')` guards falsy
  // inputs but a TRUTHY non-string (number/object/Symbol) still reaches `.toLowerCase()` and THROWS,
  // escaping familyOfResolved()'s catch. `String(model ?? '')` makes familyOfResolved never-throw TOTAL
  // on ANY input. Zero behavior change on the string path.
  const m = String(model ?? '').toLowerCase();
  if (/deepseek/.test(m)) return 'deepseek';
  if (/llama/.test(m)) return 'llama';
  if (/glm|zai/.test(m)) return 'glm';
  if (/kimi|moonshot/.test(m)) return 'kimi';
  if (/gemini|gemma/.test(m)) return 'gemini';
  if (/mistral|mixtral|ministral/.test(m)) return 'mistral';
  if (/qwen/.test(m)) return 'qwen';
  if (/gpt|o1|o3|o4/.test(m)) return 'openai';
  if (/claude/.test(m)) return 'anthropic';
  return m.split(/[-/:]/)[0] || 'unknown';
}

/**
 * CROSS-FIX 2026-07-05 — REGISTRY-PRIMARY family resolution for HAL's LIVE quorum.
 *
 * WHY: `familyOf()` is a FIRST-MATCH substring regex. A compound/aliased model name that carries
 * tokens for >1 family (e.g. `deepseek-llama-3.3-70b` matches /deepseek/ BEFORE /llama/) silently
 * mis-classifies — weakening HAL's family-independence quorum (a Llama-lineage model could count as a
 * distinct 'deepseek' vote). The hardened `resolveFamily()` (src/decisioning/family-registry.ts) is a
 * registry-only lookup that is right for known models AND rejects ambiguous ones instead of guessing.
 *
 * BUT: `resolveFamily()` THROWS (`UnmappedFamilyError`) on an unmapped/ambiguous model, and HAL runs on
 * LIVE scoring — it must NEVER throw or hard-fail on an unmapped model (unlike the decisioning gate,
 * which is designed to hard-fail). So this wrapper:
 *   1) tries the REGISTRY first (accurate for the common, known case), and if that throws
 *   2) FALLS BACK to the legacy `familyOf()` regex so the live path always produces a family, BUT
 *   3) emits a LOUD degraded log AND flags the model via `onUnmapped(model, fallbackFamily)` so the
 *      unmapped model is visible in signals/metadata for later registration.
 * Registry-known models get accurate classification; unknowns still work (fallback) but are surfaced.
 * Never throws in the live path.
 *
 * `onUnmapped` is an optional collector the caller passes to accumulate the unmapped models seen in a
 * single quorum (so `families_unmapped` can be reported once, not logged per-lookup at high volume).
 */
export function familyOfResolved(
  model: string,
  onUnmapped?: (model: string, fallbackFamily: string) => void,
): string {
  try {
    return resolveFamily(model); // registry-only, accurate; throws on unmapped/ambiguous
  } catch {
    // LIVE PATH — never throw. Fall back to the legacy regex and flag the model loudly.
    const fallbackFamily = familyOf(model);
    if (onUnmapped) {
      onUnmapped(model, fallbackFamily);
    } else {
      // No collector supplied (e.g. boot audit) — log directly so the degrade is still visible.
      // V3 FIX 2026-07-05 (fuzz-hardening) — String(model) is Symbol-safe; a raw `${model}` template
      // interpolation THROWS on a Symbol input, which would re-escape this never-throw catch.
      console.warn(
        `[hal] hal_family_unmapped: model "${String(model)}" not in family registry — fell back to familyOf() regex -> "${fallbackFamily}". ` +
          `Register it in src/decisioning/family-registry.ts (+ the migration seed) so the quorum uses the accurate, non-spoofable family.`,
      );
    }
    return fallbackFamily;
  }
}

export type Verdict = 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'ERROR';

export interface ProviderVerdict {
  provider: string;
  // CC2: model is a first-class, declared field so the per-provider model string survives the
  // verdicts -> provider_responses -> hal_validation_runs path (the 06-08 model='unknown' was a
  // stale branch that predated model plumbing; declaring it here prevents a silent future drop).
  model?: string;
  verdict: Verdict;
  confidence: number; // 0..100
  note?: string;
  error?: string;
  latency_ms: number;
}

export type HalDecision = 'vetoed' | 'flagged' | 'clean' | 'abstain';

/**
 * Compress a provider failure to a short, enumerable token for the coverage record.
 *
 * The raw upstream message can be long and can quote the request, and this value lands in
 * `repid_score_events.metadata`, read by things that are not a human debugging one call. A
 * stable code is what a later reader needs to reconstruct the coverage regime.
 */
function shortFailureReason(err: string | undefined): string {
  const e = (err ?? '').toLowerCase();
  if (/\b402\b|insufficient|credit|quota|billing/.test(e)) return '402';
  if (/\b401\b|\b403\b|unauthor|invalid api key|forbidden/.test(e)) return '401';
  if (/\b429\b|rate.?limit|too many/.test(e)) return '429';
  if (/timeout|timed out|abort|etimedout/.test(e)) return 'timeout';
  if (/econnrefused|enotfound|network|socket|fetch failed/.test(e)) return 'network';
  if (/parse|json|schema|unexpected token/.test(e)) return 'badresponse';
  return 'error';
}

export interface FactCheckResult {
  hal_score: number; // 0..1, higher = more likely false/risky (matches HAL convention)
  decision: HalDecision;
  // A1 — human-readable explanation of WHY (verdict mode), e.g. "2 of 3 independent model
  // families judged this claim FALSE (Groq/Llama, Gemini, DeepSeek)". The demo surface.
  decision_reason?: string;
  /**
   * What Trinity's own `ground_truth_facts` corpus said about this claim, and
   * whether it moved `decision`. Present whenever the gate ran (default on;
   * HAL_GROUND_TRUTH_GATE=false disables). Exposed rather than hidden because a
   * decision overridden by a local table must be visible to whoever reads the
   * verdict — an unexplained override is indistinguishable from a bug.
   */
  ground_truth?: GroundTruthResult;
  verdicts: ProviderVerdict[];
  providers_used: number; // non-error responses
  families_used?: number; // R5 — distinct independent families among the non-error responses
  families?: string[];    // R5 — the distinct families that voted
  // CROSS-FIX 2026-07-05 — models whose family came from the legacy familyOf() FALLBACK because they
  // are NOT in the hardened family registry. Registry-known models are absent here; a non-empty list
  // means at least one provider's family was regex-guessed (spoofable) and should be registered. Made
  // visible so unmapped models surface in signals/metadata for later registration. `[]`/undefined = all
  // families came from the accurate registry.
  families_unmapped?: string[];
  // WEIGHT-DEDUP (2026-07-09) — checkpoint-level dedup of the quorum. Present only when
  // HAL_QUORUM_WEIGHT_DEDUP != 'off'. In 'shadow' it reports what dedup/stochastic WOULD select vs the
  // current set (mode='shadow', mutated=false); in 'on' it reports the deduped set actually used
  // (mutated=true). `dropped_duplicates` = hosts removed for sharing a checkpoint with a kept host
  // (fake diversity). `unmapped_checkpoints` = host+model pairs not in the checkpoint registry (each a
  // distinct singleton — surfaced for registration, NEVER merged).
  weight_dedup?: {
    mode: Exclude<WeightDedupMode, 'off'>;
    mutated: boolean;
    stochastic_k: number;
    checkpoints_before: number;
    checkpoints_after: number;
    dropped_duplicates: Array<{ provider?: string; model: string; checkpoint: string }>;
    selected_checkpoints: string[];
    unmapped_checkpoints: Array<{ provider?: string; model: string; checkpoint: string }>;
  };
  agreement: number | null; // fraction sharing the modal non-error verdict
  degraded: boolean; // < 2 providers responded
  latency_ms: number;
  // --- CC1 2026-05-23 provider-failure hardening (additive, all optional →
  // backward-compatible; existing callers keep working unchanged). ---
  quorum?: 'full' | 'partial' | 'low' | 'outage'; // succeeded vs attempted
  provider_health?: {
    attempted: number;
    succeeded: number;
    failed: Array<{ name: string; error: string }>;
  };
  quorum_note?: string; // set only when the resilience gate downgraded a decision
  fallback_used?: 'local_slm';
  confidence?: 'degraded';
  // --- SBFA v0.2 shadow (additive; default-on SHADOW only, never changes `decision`). Exposes the
  // belief / ignorance / confidence the verdict event needs (§7 CC). The decision-replacement path is
  // a SEPARATE flag gated on the A6 co-sign with GA. See src/hal/sbfa-consensus.ts. ---
  sbfa?: {
    decision: SbfaDecision; // 'act' | 'hold' | 'abstain' | 'escalate' (shadow — advisory only)
    belief: number; // DST mass on {act warranted}
    belief_not: number; // DST mass on {no action}
    ignorance_mass: number; // DST mass on {uncertain} (Yager)
    confidence: number; // 1 − ignorance
    weighted_agreement: number;
    escalate_to: 'contested_bft' | null;
    correlated_warning: boolean;
    comma_conservative: boolean;
    reliability_source: string;
    enforced: boolean; // true only if SBFA actually changed the live decision (A6-gated)
    trace: SbfaTrace; // GLASS BOX — structured + human-readable decision trace (wrapper + HITL PWA)
  };
  // --- WS1.2a DUAL-PATH RETRIEVAL (additive; present ONLY when HAL_RETRIEVAL_ENABLED==='true' AND the
  // slow path was triggered). Reports the trigger, the CRAG grade + provenance, and whether the grade
  // refined the fast-path decision. Absent by default → live HAL is byte-identical when the flag is
  // off. ---
  retrieval?: {
    triggered: boolean;
    trigger_reason: string; // human-readable: which trigger(s) fired
    evidence_count: number; // snippets retrieved
    pre_retrieval_decision: HalDecision; // the fast-path decision before refinement
    refined: boolean; // did the CRAG grade change `decision`?
    latency_ms: number; // slow-path added latency (retrieval + grading)
    crag?: {
      grade: CragGrade;
      verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN';
      confidence: number;
      corroboration_count: number;
      contradiction_count: number;
      disclosure_flag: boolean;
      grader: 'model' | 'heuristic';
      grader_model?: string;
      reasons: string[];
      // provenance of the graded sources (url/domain/hash/timestamp) — the glass box for the CRAG call.
      sources: Array<{ url: string; registrable_domain: string; stance: string; content_hash: string; timestamp: string }>;
    };
  };
  // WS1.2a — the RRL scoring-hook record captured at the CRAG decision point (log only; no RepID write).
  rrl?: RrlHookRecord;
}

/**
 * SBFA shadow telemetry sink — pluggable, OFF the hot path. Default logs a structured one-liner
 * (visible in Railway logs, zero DB dependency). GA can replace it with a DB writer for the Gate-ON
 * measurement. NEVER called synchronously in the request path — see the sampled setImmediate below.
 */
export type SbfaTelemetry = (row: {
  live_decision: HalDecision;
  sbfa_decision: SbfaDecision;
  belief: number;
  ignorance_mass: number;
  weighted_agreement: number;
  enforced: boolean;
}) => void;
let sbfaTelemetrySink: SbfaTelemetry = (row) => {
  console.log(`[sbfa-shadow] live=${row.live_decision} sbfa=${row.sbfa_decision} belief=${row.belief.toFixed(3)} ign=${row.ignorance_mass.toFixed(3)} agree=${row.weighted_agreement.toFixed(3)} enforced=${row.enforced}`);
};
/** Test/GA seam to swap the telemetry sink (e.g. a DB writer). */
export function setSbfaTelemetrySink(sink: SbfaTelemetry): void {
  sbfaTelemetrySink = sink;
}

/** Map fact-check thresholds onto SBFA stakes/action. Reversible safety surface = protective. */
function sbfaStakes(): StakesLevel {
  const s = (process.env.HAL_SBFA_STAKES ?? 'medium').toLowerCase();
  return s === 'low' || s === 'high' || s === 'irreversible' ? (s as StakesLevel) : 'medium';
}
function sbfaAction(): ActionKind {
  // HAL veto is a reputation penalty (reversible via dispute) → protective by default; set
  // HAL_SBFA_ACTION=punitive to apply the irreversible-slash bar.
  return process.env.HAL_SBFA_ACTION === 'punitive' ? 'punitive' : 'protective';
}
/** ~10% sampling for the OFF-hot-path shadow telemetry. SBFA_SHADOW_SAMPLE_RATE in [0,1], default 0.1. */
function sbfaSampleHit(): boolean {
  const r = Number(process.env.SBFA_SHADOW_SAMPLE_RATE);
  const rate = Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.1;
  return Math.random() < rate;
}

export interface FactCheckOpts {
  vetoThreshold?: number; // default 0.5
  flagThreshold?: number; // default 0.35
  perProviderTimeoutMs?: number; // default 12000
  maxTokens?: number; // default 120
  // WS1.2a — SLOW-PATH controls (all optional; ignored unless HAL_RETRIEVAL_ENABLED==='true').
  forceRetrieval?: boolean; // explicit "verify this" — always trigger the slow path
  highStakes?: boolean; // caller-declared high-stakes (RepID/financial/code/on-chain) claim → trigger
  // BFT ANTI-SPOOF (audit item #4, 2026-08-07) — the model that PRODUCED the deliverable being judged.
  // When set AND BFT_DISJOINT_ENFORCE=true, any quorum judge that shares the producer's model family is
  // excluded as self-grading (a Llama judge grading Llama output is marking its own homework). Optional;
  // ignored while the flag is OFF, so existing callers are unaffected.
  producerModel?: string;
}

/**
 * WS1.2a — RRL SCORING HOOK record. Emitted at the CRAG decision point of the slow path — the exact
 * fields a future Response-Reputation-Layer delta (reports/2026-07-18/RRL_DESIGN_v0.md) will consume:
 * source credibility (the CRAG grade), how many INDEPENDENT sources corroborated, the grader's
 * confidence, and whether the disclosure/abstain protections fired. THIS IS A LOG ONLY — no RepID is
 * mutated here (WS2.x wires the delta). Surfaced so the signal is captured from day one.
 */
export interface RrlHookRecord {
  claim_hash: string; // sha256 of the deliverable — links the record to the claim without storing prose
  source_credibility_grade: CragGrade; // Correct | Ambiguous | Incorrect — the credibility signal
  crag_verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN';
  corroboration_count: number; // distinct INDEPENDENT domains that supported the claim (the ≥2 lever)
  contradiction_count: number;
  grader_confidence: number; // 0..100
  disclosure_fired: boolean; // single-source/uncorroborated → downstream must disclose uncertainty
  abstain_fired: boolean; // HAL abstained (not a checkable claim) at the CRAG point
  retrieval_source_count: number; // evidence snippets retrieved before grading
  hal_decision: HalDecision; // final live decision after any slow-path refinement
  refined: boolean; // did the CRAG grade change the fast-path decision?
}

/**
 * WS1.2a — RRL telemetry sink. Pluggable, OFF the hot path (default logs a structured one-liner, zero
 * DB dependency — same pattern as the SBFA shadow sink). GA/WS2.x can swap in a DB/repid_score_events
 * writer for the real RRL delta. NEVER mutates RepID here.
 */
export type RrlTelemetry = (row: RrlHookRecord) => void;
let rrlTelemetrySink: RrlTelemetry = (row) => {
  console.log(
    `[rrl-hook] grade=${row.source_credibility_grade} verdict=${row.crag_verdict} ` +
      `corroboration=${row.corroboration_count} contradiction=${row.contradiction_count} ` +
      `conf=${row.grader_confidence} disclosure=${row.disclosure_fired} abstain=${row.abstain_fired} ` +
      `sources=${row.retrieval_source_count} decision=${row.hal_decision} refined=${row.refined}`,
  );
};
/** Test/WS2.x seam to swap the RRL telemetry sink (e.g. a repid_score_events writer). */
export function setRrlTelemetrySink(sink: RrlTelemetry): void {
  rrlTelemetrySink = sink;
}

/** Default high-stakes trigger keywords (config-extensible via HAL_RETRIEVAL_STAKES_KEYWORDS). */
const DEFAULT_STAKES_KEYWORDS = [
  'repid', 'reputation', 'stake', 'staking',
  'financial', 'payment', 'usd', 'usdc', 'price', 'invest', 'trade', 'transfer', 'refund',
  'on-chain', 'onchain', 'transaction', 'wallet', 'contract address', 'erc-8004', 'erc8004', 'attestation',
  'exploit', 'vulnerability', 'cve', 'security', 'private key',
];

/** True when the deliverable mentions a high-stakes term (RepID/financial/code/on-chain/security). */
function isHighStakesText(deliverable: string): boolean {
  const extra = (process.env.HAL_RETRIEVAL_STAKES_KEYWORDS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kws = [...DEFAULT_STAKES_KEYWORDS, ...extra];
  const t = String(deliverable ?? '').toLowerCase();
  return kws.some((k) => t.includes(k));
}

const FACT_CHECK_SYSTEM =
  'You are a meticulous fact-checker. Judge ONLY factual accuracy against widely-accepted references. Be decisive. Output ONLY compact JSON.';

function factCheckPrompt(deliverable: string): string {
  return (
    'Assess whether the following statement is factually true.\n' +
    `Statement: "${deliverable.replace(/"/g, "'").slice(0, 1200)}"\n\n` +
    'Reply with ONLY this JSON (no prose, no markdown):\n' +
    '{"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0-100,"note":"<=12 words"}\n' +
    '- TRUE: central factual claim is correct.\n' +
    '- FALSE: contains a factual error.\n' +
    '- UNCERTAIN: opinion, ambiguous, or not verifiable.'
  );
}

/** Extract a verdict from possibly-verbose model output (reasoning models emit prose THEN JSON). */
function parseVerdict(text: string): { verdict: Verdict; confidence: number; note?: string } {
  // Scan ALL brace-groups and prefer the one that actually carries a "verdict" key — a reasoning
  // model emits chain-of-thought (sometimes with braces) before the final JSON, so the first
  // match isn't reliably the answer.
  const candidates = text.match(/\{[\s\S]*?\}/g) ?? [];
  const ordered = [
    ...candidates.filter((c) => /verdict/i.test(c)),
    ...candidates.filter((c) => !/verdict/i.test(c)),
  ];
  for (const c of ordered) {
    try {
      const o = JSON.parse(c);
      if (o.verdict === undefined && o.confidence === undefined) continue;
      const v = String(o.verdict ?? '').toUpperCase();
      const verdict: Verdict = v === 'TRUE' || v === 'FALSE' || v === 'UNCERTAIN' ? (v as Verdict) : 'UNCERTAIN';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 50;
      confidence = Math.max(0, Math.min(100, confidence));
      return { verdict, confidence, note: typeof o.note === 'string' ? o.note.slice(0, 80) : undefined };
    } catch {
      /* try next candidate */
    }
  }
  // Fallback keyword scan if no parseable verdict JSON. Prefer an explicit "verdict": value over a
  // bare TRUE/FALSE token appearing in reasoning prose.
  const up = text.toUpperCase();
  const vm = up.match(/"VERDICT"\s*:\s*"(TRUE|FALSE|UNCERTAIN)"/);
  if (vm) return { verdict: vm[1] as Verdict, confidence: 60 };
  return { verdict: 'UNCERTAIN', confidence: 50 };
}

/**
 * POST to an OpenAI-compatible chat endpoint with a single jittered retry on HTTP 429.
 * Free tiers (esp. groq) rate-limit under burst; one short backoff turns a transient 429 into a
 * success without blowing the per-provider timeout. Honors a numeric Retry-After when present.
 */
async function postWith429Retry(cfg: FactCheckProviderCfg, body: string, signal: AbortSignal): Promise<Response> {
  let res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body, signal,
  });
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    const waitMs = Math.min(3000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800) + Math.floor(Math.random() * 400));
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body, signal,
    });
  }
  return res;
}

async function queryProvider(cfg: FactCheckProviderCfg, deliverable: string, maxTokens: number, quorumId?: string): Promise<ProviderVerdict> {
  const start = Date.now();
  const controller = new AbortController();
  // R5 — configurable per-call timeout so one slow provider can't stall the family quorum.
  const timeoutMs = cfg.timeoutMs ?? (Number(process.env.HAL_S2_TIMEOUT_MS) || 12_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call_id = crypto.randomUUID();
  try {
    // DATA-LOCALITY BOUNDARY (ONLY_ATTESTATIONS_LEAVE): the deliverable is content —
    // refuse to send it to a non-local host when the boundary is engaged. No-op when
    // the flag is off or the endpoint is local (LOCAL_LLM_BASE_URL). Throws → caught
    // below → returned as this provider's ERROR verdict (quorum degrades gracefully),
    // never a silent cloud call. Mirrors cross-llm-client.queryProvider's prompt guard.
    assertPromptEgressAllowed(cfg.endpoint, 'prompt');
    const res = await postWith429Retry(cfg, JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: FACT_CHECK_SYSTEM },
        { role: 'user', content: factCheckPrompt(deliverable) },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }), controller.signal);
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logLlmCall({
        call_id,
        provider: cfg.name,
        tier: '0a',
        model: cfg.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms,
        status: 'failed',
        error_message: `HTTP ${res.status}: ${body.slice(0, 120)}`,
        task_hint: 'hal_fact_check', quorum_id: quorumId
      }).catch(err => console.error('[fact-check] logLlmCall error:', err));
      return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error: `HTTP ${res.status}: ${body.slice(0, 120)}`, latency_ms };
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    // Reasoning models (cerebras zai-glm / gpt-oss) put output in `reasoning` or `reasoning_content`,
    // not `content` — fall through all three so they parse.
    const content: string = msg.content || msg.reasoning_content || msg.reasoning || '';
    
    const tokensIn = data.usage?.prompt_tokens || 0;
    const tokensOut = data.usage?.completion_tokens || 0;
    const cost_usd = calculateCost(cfg.name, cfg.model, tokensIn, tokensOut);

    if (!content.trim()) {
      logLlmCall({
        call_id,
        provider: cfg.name,
        tier: '0a',
        model: cfg.model,
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        cost_usd,
        latency_ms,
        status: 'failed',
        error_message: 'empty content',
        task_hint: 'hal_fact_check', quorum_id: quorumId
      }).catch(err => console.error('[fact-check] logLlmCall error:', err));
      return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error: 'empty content', latency_ms };
    }
    
    logLlmCall({
      call_id,
      provider: cfg.name,
      tier: '0a',
      model: cfg.model,
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      cost_usd,
      latency_ms,
      status: 'success',
      task_hint: 'hal_fact_check', quorum_id: quorumId
    }).catch(err => console.error('[fact-check] logLlmCall error:', err));

    const parsed = parseVerdict(content);
    return { provider: cfg.name, verdict: parsed.verdict, confidence: parsed.confidence, note: parsed.note, latency_ms };
  } catch (e: any) {
    const latency_ms = Date.now() - start;
    const error = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e);
    logLlmCall({
      call_id,
      provider: cfg.name,
      tier: '0a',
      model: cfg.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      latency_ms,
      status: e?.name === 'AbortError' ? 'rate_limited' : 'failed',
      error_message: error,
      task_hint: 'hal_fact_check', quorum_id: quorumId
    }).catch(err => console.error('[fact-check] logLlmCall error:', err));
    return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error, latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

/** Per-provider risk in [0,1]: high for confident-FALSE, low for confident-TRUE. */
function providerRisk(v: ProviderVerdict): number {
  const c = v.confidence / 100;
  if (v.verdict === 'FALSE') return 0.5 + 0.5 * c; // 0.5..1.0
  if (v.verdict === 'TRUE') return 0.5 - 0.5 * c; // 0.0..0.5
  return 0.5; // UNCERTAIN
}

/**
 * CYCLE2 (precision) — GROK TIEBREAK. Optional, env-gated `HAL_ESCALATE_GROK` (default OFF), additive.
 * Called ONLY when the responding families are EVENLY split (equal TRUE and FALSE family counts, no
 * plurality) — a single independent tiebreak vote from Grok (xAI, api.x.ai, OpenAI-compatible). Its
 * verdict is folded back into the quorum as one more 'grok'-family vote; the normal aggregation +
 * plurality guard then resolve the (now un-tied) decision.
 *
 * FAIL-SAFE: returns null if the flag is off or no key is present, and `queryProvider` NEVER throws
 * (it returns an ERROR verdict on any failure), so any Grok error simply falls back to the current
 * (tied) behavior with no effect on the live path. Small + self-contained; does NOT touch src/hal/lib/*.
 */
/**
 * xAI/Grok API key resolution — canonical `XAI_API_KEY`, legacy `GROK_API_KEY` fallback.
 *
 * Re-exported rather than defined here so that HAL, CRAG and the key probe cannot drift apart
 * again; see `src/providers/xai-key.ts` for why the definition lives in a leaf module and why the
 * order is what it is. Kept exported from this module because it is part of this module's public
 * surface already (`HAL_ESCALATE_GROK` gates and existing importers).
 */
export { grokApiKey };

async function grokTiebreak(
  deliverable: string,
  maxTokens: number,
  quorumId: string,
): Promise<ProviderVerdict | null> {
  const key = grokApiKey();
  if (!key) return null;
  const cfg: FactCheckProviderCfg = {
    name: 'grok',
    endpoint: process.env.HAL_ESCALATE_GROK_ENDPOINT ?? 'https://api.x.ai/v1/chat/completions',
    apiKey: key,
    model: process.env.HAL_ESCALATE_GROK_MODEL ?? 'grok-3-mini',
    family: 'grok',
    tier: 'escalation',
  };
  return queryProvider(cfg, deliverable, maxTokens, quorumId); // never throws → ERROR verdict on failure
}

/**
 * CC1 2026-05-23 — provider-failure hardening. Closes CC1's own launch-
 * verification RULE-4 caveat: strictness:2 was verified only on the happy path
 * (providers_used=2, agree=1.0); under partial provider outage (e.g. cerebras
 * 429 → a single surviving provider), a lone FALSE verdict could fire a veto
 * with no independent confirmation. A veto/flag now requires a real quorum
 * (>= MIN_QUORUM_FOR_VETO successful providers). With only one surviving
 * provider the decision defaults to 'clean' (degraded) — better a false-clean
 * (caught downstream by the F-series filter + dispute path) than a false-veto.
 *
 * This WRAPS the existing aggregation: hal_score and agreement math are
 * unchanged, and the canonical comma-BFT lib (src/hal/lib/*) is untouched. Note
 * the agreement/score were already computed over successful responses only
 * (ERROR providers filtered before aggregation), so failed providers never
 * inflated the score — this gate adds the missing quorum requirement.
 */
const MIN_QUORUM_FOR_VETO = 2;

function computeQuorum(succeeded: number, attempted: number): 'full' | 'partial' | 'low' | 'outage' {
  if (succeeded === 0) return 'outage';
  if (succeeded === 1) return 'low';
  return succeeded >= attempted ? 'full' : 'partial';
}

/**
 * Evaluate a deliverable's factual truth via cross-provider verdicts.
 * Falls back gracefully when providers fail; returns providers_used=0 (caller
 * should then use the extractor signal) when none respond.
 */
export async function factCheck(
  deliverable: string,
  providers: FactCheckProviderCfg[],
  opts: FactCheckOpts = {},
): Promise<FactCheckResult> {
  const start = Date.now();
  const vetoThreshold = opts.vetoThreshold ?? 0.5;
  const flagThreshold = opts.flagThreshold ?? 0.35;
  // Reasoning models (cerebras zai-glm) spend tokens thinking before emitting the verdict JSON;
  // 120 truncated them mid-reasoning. 512 lets them finish while staying cheap for the terse models.
  const maxTokens = opts.maxTokens ?? 512;

  const quorumId = crypto.randomUUID(); // R5 — groups this quorum's provider calls in llm_call_log

  // WEIGHT-DEDUP GATE (2026-07-09, reports/2026-07-09 HAL eval) — flag-gated, SHADOW-FIRST.
  // Dedup the quorum by model CHECKPOINT so two hosts serving the SAME weights are never two votes.
  // off (default): activeProviders == providers, no change. shadow: compute + log the would-be set,
  // mutate nothing. on: replace the assembled set with the deduped (and optionally stochastic) subset.
  // Seed = quorumId (random per check → varies in prod / anti-gaming; deterministic under a fixed seed
  // in tests). NEVER throws: an unmapped host resolves to its own singleton checkpoint and is kept.
  const dedupMode = weightDedupMode();
  const kSubset = stochasticK();
  let activeProviders: FactCheckProviderCfg[] = providers;
  let weightDedupField: FactCheckResult['weight_dedup'];
  if (dedupMode !== 'off') {
    // Wrap each provider as a CheckpointRef whose `provider` is the HOST NAME (FactCheckProviderCfg
    // identifies the host via `name`, not `provider`), carrying the original cfg through selection.
    type Wrapped = { provider: string; model: string; cfg: FactCheckProviderCfg };
    const wrapped: Wrapped[] = providers.map((p) => ({ provider: p.name, model: p.model, cfg: p }));
    let sel: import('./checkpoint-registry').DedupResult<Wrapped>;
    let wouldSelect: Wrapped[];
    if (kSubset > 0) {
      const s = stochasticCheckpointDiverseSubset(wrapped, kSubset, quorumId);
      sel = s;
      wouldSelect = s.selected;
    } else {
      const d = dedupByCheckpoint(wrapped, quorumId);
      sel = d;
      wouldSelect = d.kept;
    }
    const ckOf = (w: Wrapped) => resolveCheckpoint(w.provider, w.model).checkpoint;
    const selectedCheckpoints = wouldSelect.map(ckOf);
    const checkpointsBefore = new Set(wrapped.map(ckOf)).size;
    const checkpointsAfter = new Set(selectedCheckpoints).size;
    const droppedDuplicates = sel.dropped.map((w) => ({ provider: w.provider, model: w.model, checkpoint: ckOf(w) }));
    const selectedDistinct = [...new Set(selectedCheckpoints)];
    weightDedupField = {
      mode: dedupMode,
      mutated: dedupMode === 'on',
      stochastic_k: kSubset,
      checkpoints_before: checkpointsBefore,
      checkpoints_after: checkpointsAfter,
      dropped_duplicates: droppedDuplicates,
      selected_checkpoints: selectedDistinct,
      unmapped_checkpoints: sel.unmapped,
    };
    // LOUD, once-per-quorum glass-box log (shadow AND on).
    console.warn(
      `[hal] hal_weight_dedup mode=${dedupMode} mutated=${dedupMode === 'on'} k=${kSubset} ` +
        `checkpoints ${checkpointsBefore}->${checkpointsAfter} ` +
        `dropped=[${droppedDuplicates.map((d) => `${d.provider}/${d.model}~${d.checkpoint}`).join(', ')}] ` +
        `selected=[${selectedDistinct.join(', ')}]` +
        (sel.unmapped.length
          ? ` UNMAPPED(register in checkpoint-registry.ts)=[${sel.unmapped.map((u) => `${u.provider ?? '?'}/${u.model}`).join(', ')}]`
          : ''),
    );
    if (dedupMode === 'on') activeProviders = wouldSelect.map((w) => w.cfg);
  }

  // BFT ANTI-SPOOF DISJOINTNESS ENFORCEMENT (audit item #4, 2026-08-07 — BFT_DISJOINT_ENFORCE, default
  // OFF → SHADOW-SAFE). Closes two gaps the audit found:
  //   (a) familyOfResolved() falls back to a SPOOFABLE regex (familyOf) for any model absent from the
  //       family registry, so an UNMAPPED model can vote under a GUESSED family and fake the
  //       family-independence the whole quorum rests on; and
  //   (b) the registry-hard-fail disjointness module (src/decisioning/disjointness.ts) had ZERO live
  //       callers ("nothing routes live by itself").
  // When the flag is ON, the assembled quorum is routed through selectDisjointQuorum(): unmapped judges
  // are EXCLUDED (never regex-guessed), any judge sharing the producer's family is dropped as
  // self-grading (assertDisjoint), and the survivors are collapsed to ONE registry-mapped judge per
  // family via assembleDisjointJudges. Default OFF leaves the live quorum byte-identical — this changes
  // the veto path, so it MUST be reviewed before the flag is enabled. Applied BEFORE family
  // classification / calling providers, so an excluded judge never even makes a request or a vote.
  if (process.env.BFT_DISJOINT_ENFORCE === 'true') {
    const beforeCount = activeProviders.length;
    const sel = selectDisjointQuorum(activeProviders, {
      seed: quorumId,
      producerModel: opts.producerModel,
      context: 'hal_fact_check_quorum',
    });
    if (sel.excludedUnmapped.length > 0) {
      console.warn(
        `[hal] bft_disjoint_enforce: EXCLUDED ${sel.excludedUnmapped.length} UNMAPPED provider(s) from the ` +
          `quorum (registry-hard-fail — NOT regex-guessed): ` +
          `[${sel.excludedUnmapped.map((p) => `${p.name}/${p.model}`).join(', ')}]. ` +
          `Register them in src/decisioning/family-registry.ts (+ migration seed) to let them vote.`,
      );
    }
    if (sel.excludedProducerFamily.length > 0) {
      console.warn(
        `[hal] bft_disjoint_enforce: EXCLUDED ${sel.excludedProducerFamily.length} judge(s) sharing the ` +
          `producer's family (self-grading): ` +
          `[${sel.excludedProducerFamily.map((e) => `${e.item.name}/${e.item.model}~${e.family}`).join(', ')}].`,
      );
    }
    if (sel.excludedSameFamily.length > 0) {
      console.warn(
        `[hal] bft_disjoint_enforce: COLLAPSED ${sel.excludedSameFamily.length} same-family provider(s) to one ` +
          `independent vote: [${sel.excludedSameFamily.map((e) => `${e.item.name}/${e.item.model}~${e.family}`).join(', ')}].`,
      );
    }
    console.warn(
      `[hal] bft_disjoint_enforce: quorum ${beforeCount} -> ${sel.kept.length} registry-mapped, ` +
        `mutually-family-disjoint judge(s) [${sel.keptFamilies.join(', ')}].`,
    );
    activeProviders = sel.kept;
  }

  // CROSS-FIX 2026-07-05 — REGISTRY-PRIMARY family classification for the live quorum. Each provider's
  // family is resolved via the hardened registry (familyOfResolved); a model missing from the registry
  // falls back to the legacy familyOf() regex and is collected into `unmappedModels` so it can be
  // surfaced (families_unmapped) for later registration. An explicit p.family (set by the builder, which
  // is itself now registry-primary) is honored first. LIVE PATH: familyOfResolved NEVER throws.
  const unmappedModels = new Set<string>();
  const flagUnmapped = (model: string, _fallback: string) => { unmappedModels.add(model); };
  // V3 FIX 2026-07-05 — resolve EVERY provider's model through the collector so `families_unmapped`
  // populates on the DEFAULT build→score path too. The prior `p.family ?? familyOfResolved(...)`
  // short-circuited whenever the builder had already pre-tagged `.family` (which it always does at
  // buildFactCheckProvidersWith:796), so flagUnmapped never ran and the field was theater. Now the
  // single resolution point ALWAYS runs the collector on `p.model`; the pre-tagged `.family` is still
  // honored for classification, but the unmapped set is authoritative regardless of entry path.
  const familyByName = new Map(
    activeProviders.map((p) => {
      const resolved = familyOfResolved(p.model, flagUnmapped); // always runs the collector
      return [p.name, p.family ?? resolved];
    }),
  );
  const familiesUnmapped = [...unmappedModels];
  if (familiesUnmapped.length > 0) {
    // LOUD, ONCE-per-quorum degrade log (the per-lookup path suppresses its own log via the collector).
    console.warn(
      `[hal] hal_family_unmapped: ${familiesUnmapped.length} model(s) not in the family registry — ` +
        `family regex-guessed via familyOf() (spoofable): [${familiesUnmapped.join(', ')}]. ` +
        `Register them in src/decisioning/family-registry.ts (+ migration seed) so the quorum's ` +
        `family-independence is registry-accurate.`,
    );
  }
  const callOne = (p: FactCheckProviderCfg) => queryProvider(p, deliverable, maxTokens, quorumId);
  const settle = async (ps: FactCheckProviderCfg[]): Promise<ProviderVerdict[]> => {
    const s = await Promise.allSettled(ps.map(callOne));
    return s.map((r, i) => r.status === 'fulfilled' ? r.value
      : { provider: ps[i]!.name, model: ps[i]!.model, verdict: 'ERROR' as Verdict, confidence: 0, error: String((r as PromiseRejectedResult).reason), latency_ms: 0 });
  };
  const distinctFamilies = (vs: ProviderVerdict[]) =>
    new Set(vs.filter((v) => v.verdict !== 'ERROR').map((v) => familyByName.get(v.provider) ?? v.provider)).size;

  // R6 — CHEAPEST-FIRST quorum assembly: call free → cheap → escalation in waves, stopping the moment
  // >= MIN_QUORUM_FOR_VETO distinct families respond (so paid providers are only hit when free can't
  // form a quorum). Revertible via HAL_QUORUM_COST_ORDERED=false (→ all providers in parallel, prior).
  const costOrdered = process.env.HAL_QUORUM_COST_ORDERED !== 'false';
  let verdicts: ProviderVerdict[] = [];
  let attempted = 0;
  if (costOrdered) {
    const rank = (p: FactCheckProviderCfg) => ({ free: 0, cheap: 1, escalation: 2 })[p.tier ?? costTierOf({ name: p.name, family: familyByName.get(p.name) })];
    const waves = [0, 1, 2].map((r) => activeProviders.filter((p) => rank(p) === r)).filter((w) => w.length > 0);
    for (const wave of waves) {
      verdicts.push(...(await settle(wave)));
      attempted += wave.length;
      if (distinctFamilies(verdicts) >= MIN_QUORUM_FOR_VETO) break; // quorum formed — don't escalate to pricier tiers
    }
  } else {
    verdicts = await settle(activeProviders);
    attempted = activeProviders.length;
  }

  verdicts.forEach(v => {
    if (v.verdict === 'ERROR') {
      console.log(`  - Provider ${v.provider} FAILED in ${v.latency_ms}ms: ${v.error}`);
    } else {
      console.log(`  - Provider ${v.provider} returned ${v.verdict} (confidence ${v.confidence}%) in ${v.latency_ms}ms`);
    }
  });

  // CYCLE2 (precision) — GROK TIEBREAK. When the responding families are EVENLY split (equal distinct
  // TRUE and FALSE family counts, ≥1 each → no plurality), escalate ONCE to Grok for a single
  // independent tiebreak vote, folded in as a 'grok'-family verdict before the quorum is tallied.
  // Env-gated (HAL_ESCALATE_GROK, default off) and FAIL-SAFE (flag off / no key / Grok error → no-op,
  // current tied behavior preserved). Done here so the tiebreak vote flows through ALL downstream math.
  if (process.env.HAL_ESCALATE_GROK === 'true' && grokApiKey()) {
    const okPre = verdicts.filter((v) => v.verdict !== 'ERROR');
    const famCount = (want: Verdict) =>
      new Set(okPre.filter((v) => v.verdict === want).map((v) => familyByName.get(v.provider) ?? v.provider)).size;
    const fN = famCount('FALSE');
    const tN = famCount('TRUE');
    if (fN >= 1 && fN === tN) {
      console.log(`  - [grok-tiebreak] evenly split (${tN} TRUE / ${fN} FALSE families) — escalating to Grok`);
      const gv = await grokTiebreak(deliverable, maxTokens, quorumId);
      attempted += 1;
      if (gv && gv.verdict !== 'ERROR') {
        familyByName.set(gv.provider, 'grok'); // distinct family → breaks the tie
        verdicts.push(gv);
        console.log(`  - Provider grok (tiebreak) returned ${gv.verdict} (confidence ${gv.confidence}%) in ${gv.latency_ms}ms`);
      } else {
        console.warn(`  - [grok-tiebreak] Grok unavailable/errored — falling back to current (tied) behavior`);
      }
    }
  }

  const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
  const providers_used = ok.length;
  const latency_ms = Date.now() - start;

  // R5 — distinct independent FAMILIES among the successful providers (groq-Llama + cerebras-Llama = 1).
  const familiesSet = new Set(ok.map((v) => familyByName.get(v.provider) ?? v.provider));
  const families = [...familiesSet];
  const families_used = families.length;
  // Quorum is counted in families by default; HAL_QUORUM_FAMILY_AWARE=false reverts to host count.
  const familyAware = process.env.HAL_QUORUM_FAMILY_AWARE !== 'false';
  const quorumCount = familyAware ? families_used : providers_used;

  // S-CACHE Phase 5 — record real-time provider health from the quorum (no-op without REDIS_URL).
  for (const v of verdicts) void recordProviderCall(v.provider, v.verdict !== 'ERROR', v.latency_ms);

  // CC1 provider-failure hardening: surface per-provider health + quorum.
  const failed = verdicts
    .filter((v) => v.verdict === 'ERROR')
    .map((v) => ({ name: v.provider, error: v.error ?? 'unknown' }));
  const quorum = computeQuorum(providers_used, attempted);

  // ── PUBLISH DETECTOR COVERAGE ────────────────────────────────────────────────────────
  // Every RepID score event records what was watching when it moved (detector-coverage.ts).
  // This is the one place that actually knows: 99.86% of negative reputation events come
  // from HAL, so without this the ledger cannot tell "agents got better" from "the thing
  // that notices stopped noticing" — the two have identical signatures.
  //
  // BUILT FROM `verdicts`, NOT FROM THE CONFIGURED FLEET, and the distinction is load-bearing.
  // With cost-ordered waves a cheap quorum deliberately SKIPS the expensive tier. Those
  // providers were never asked, so counting them as down would report an outage every time
  // the system worked exactly as designed — a false alarm that trains everyone to ignore the
  // real one. `verdicts` holds exactly the providers that were attempted, each with whether
  // it answered.
  //
  // Distinct from recordProviderCall above: that is Redis-backed health (a no-op without
  // REDIS_URL). This is in-process, always present, and feeds the score-event stamp.
  publishDetectorSnapshot(
    verdicts.map((v) => ({
      name: v.provider,
      live: v.verdict !== 'ERROR',
      // Short, enumerable code — never the raw upstream prose, which can be long and can
      // quote the request. The full text stays in the logs.
      ...(v.verdict === 'ERROR' ? { reason: shortFailureReason(v.error) } : {}),
    })),
  );

  if (providers_used === 0) {
    // Degrade LOUDLY: no fact-check provider produced a usable verdict. Both
    // branches below already set structured markers (degraded / fallback_used /
    // quorum_note); this adds the missing LOG line so the degrade is visible in
    // Railway logs, not just in the returned object.
    console.warn(`[hal] DEGRADED (loud fallback): fact-check quorum unavailable — 0/${attempted} providers responded${failed.length ? ` (failures: ${failed.map((f) => f.name).join(', ')})` : ''}; ${process.env.HAL_LOCAL_FALLBACK_ENABLED === 'true' ? 'using local_slm heuristic (NOT a cross-LLM fact-check)' : 'returning neutral 0.5, caller falls back to extractor'}`);
    if (process.env.HAL_LOCAL_FALLBACK_ENABLED === 'true') {
      const localVerdict: Verdict = deliverable.toLowerCase().includes('false') || deliverable.toLowerCase().includes('error') ? 'FALSE' : 'TRUE';
      const localScore = localVerdict === 'FALSE' ? 0.8 : 0.2;
      const localDecision = localScore >= vetoThreshold ? 'vetoed' : localScore >= flagThreshold ? 'flagged' : 'clean';
      return {
        hal_score: localScore,
        decision: localDecision,
        verdicts: [{
          provider: 'local_slm',
          verdict: localVerdict,
          confidence: 70,
          note: 'local slm fallback heuristic',
          latency_ms: Date.now() - start,
        }],
        providers_used: 1,
        agreement: 1.0,
        degraded: true,
        latency_ms: Date.now() - start,
        quorum,
        provider_health: { attempted: attempted, succeeded: 0, failed },
        fallback_used: 'local_slm',
        confidence: 'degraded',
      };
    }

    // No truth signal available — neutral score; caller falls back to extractor.
    return {
      hal_score: 0.5, decision: 'flagged', verdicts, providers_used: 0, agreement: null, degraded: true, latency_ms,
      quorum, provider_health: { attempted: attempted, succeeded: 0, failed },
      quorum_note: `No provider responded (0/${attempted}); neutral score, caller falls back to extractor.`,
      ...(familiesUnmapped.length ? { families_unmapped: familiesUnmapped } : {}),
      ...(weightDedupField ? { weight_dedup: weightDedupField } : {}),
    };
  }

  const hal_score = ok.reduce((s, v) => s + providerRisk(v), 0) / providers_used;
  // Modal verdict agreement (TRUE/FALSE/UNCERTAIN).
  const counts: Record<string, number> = {};
  for (const v of ok) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  const modal = Math.max(...Object.values(counts));
  const agreement = modal / providers_used;

  // Family-aware verdict tallies (the explainability primitive).
  const famsOf = (want: Verdict) =>
    [...new Set(ok.filter((v) => v.verdict === want).map((v) => familyByName.get(v.provider) ?? v.provider))];
  const falseFams = famsOf('FALSE');
  const trueFams = famsOf('TRUE');

  let decision: HalDecision;
  let decision_reason: string | undefined;
  let quorum_note: string | undefined;

  if (process.env.HAL_DECISION_MODE === 'verdict') {
    // A1 — VERDICT-COUNT as the PRIMARY decision (explainability refactor). Family-aware verdict
    // counts drive the decision; hal_score is demoted to a logged secondary signal. Counting
    // distinct FALSE families (not a 0.5 score on UNCERTAIN) is what a non-expert can read.
    const falseN = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
    const trueN = familyAware ? trueFams.length : ok.filter((v) => v.verdict === 'TRUE').length;
    if (falseN >= MIN_QUORUM_FOR_VETO) {
      decision = 'vetoed';
      decision_reason = `${falseN} of ${familyAware ? families_used : providers_used} independent model ${familyAware ? 'families' : 'providers'} judged this claim FALSE (${falseFams.join('/')}).`;
    } else if (falseN === 1) {
      decision = 'flagged';
      decision_reason = `Only 1 ${familyAware ? 'family' : 'provider'} judged this FALSE (${falseFams.join('/')}) — no independent quorum. Flagged for review, not vetoed.`;
    } else if (trueN >= MIN_QUORUM_FOR_VETO) {
      decision = 'clean';
      decision_reason = `${trueN} independent ${familyAware ? 'families' : 'providers'} judged this claim TRUE (${trueFams.join('/')}); no FALSE verdicts.`;
    } else {
      // 0 FALSE and no TRUE quorum → nothing checkable was confirmed either way.
      decision = 'abstain';
      decision_reason = `No model family judged this claim FALSE, and there is no TRUE quorum — not a checkable factual claim (likely an opinion or a question). HAL did not judge it.`;
    }
  } else {
    // SCORE mode (default — byte-identical to prior behavior): hal_score thresholds + the
    // resilience gate + the CC1 verdict-driven gate.
    const baseDecision: HalDecision =
      hal_score >= vetoThreshold ? 'vetoed' : hal_score >= flagThreshold ? 'flagged' : 'clean';
    decision = baseDecision;

    // RESILIENCE GATE (CC1 2026-05-23): a veto/flag requires >= MIN_QUORUM_FOR_VETO successful
    // providers; a lone provider downgrades to 'clean'. hal_score preserved; only decision changes.
    if (quorumCount < MIN_QUORUM_FOR_VETO && baseDecision !== 'clean') {
      decision = 'clean';
      quorum_note = `Low quorum (${familyAware ? families_used + ' famil' + (families_used === 1 ? 'y' : 'ies') + ' [' + families.join(',') + ']' : providers_used + ' providers'}/${attempted} attempted): would-be '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'clean' — need >= ${MIN_QUORUM_FOR_VETO} independent ${familyAware ? 'families' : 'providers'}.`;
    }

    // CC1 verdict-driven gate (HAL_VERDICT_DRIVEN_VETO, default OFF): a 'vetoed' baseDecision with
    // no FALSE quorum downgrades to 'flagged' (the all-UNCERTAIN @0.5 over-veto W6 found).
    if (process.env.HAL_VERDICT_DRIVEN_VETO === 'true' && decision === 'vetoed') {
      const falseQuorum = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
      if (falseQuorum < MIN_QUORUM_FOR_VETO) {
        decision = 'flagged';
        quorum_note = `Verdict-driven gate: no FALSE quorum (${falseQuorum} FALSE < ${MIN_QUORUM_FOR_VETO}); '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'flagged' — UNCERTAIN/opinion, not a confirmed factual error.`;
      }
    }
  }

  // --- CYCLE2 (precision) — PLURALITY GUARD. A FALSE minority must NEVER veto a TRUE plurality.
  // After the aggregate decision, if it is 'vetoed' but among the responding (non-ERROR) families
  // MORE voted TRUE than FALSE, downgrade the veto: to 'clean' when TRUE is an outright majority of the
  // responding families (trueN*2 > units), else to 'flagged'. This is a principled vote-count rule
  // (not a per-case lookup / no tuning to a test set); hal_score and the canonical comma-BFT lib
  // (src/hal/lib/*) are untouched — only `decision` changes. Reversible via HAL_PLURALITY_GUARD=false.
  // Uses the SAME family-aware tallies (falseFams/trueFams) already computed above. Applies in BOTH
  // decision modes. ---
  if (decision === 'vetoed' && process.env.HAL_PLURALITY_GUARD !== 'false') {
    const falseN = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
    const trueN = familyAware ? trueFams.length : ok.filter((v) => v.verdict === 'TRUE').length;
    const units = familyAware ? families_used : providers_used;
    if (trueN > falseN) {
      const label = familyAware ? 'families' : 'providers';
      const downgraded: HalDecision = trueN * 2 > units ? 'clean' : 'flagged';
      decision = downgraded;
      decision_reason = `${trueN} of ${units} independent model ${label} judged this claim TRUE and only ${falseN} judged it FALSE — a minority may not veto a TRUE plurality (downgraded to '${downgraded}').`;
      quorum_note = `Plurality guard: TRUE plurality (${trueN} TRUE > ${falseN} FALSE of ${units} ${label}) overruled a FALSE-minority veto; would-be 'vetoed' downgraded to '${downgraded}'.`;
    }
  }

  // --- CYCLE3 (precision) — CONFIDENCE-GATED PRE-VETO GROK OVERRIDE. Env-gated (HAL_ESCALATE_GROK,
  // the SAME flag as the cycle-2 tiebreak; default OFF) and FAIL-SAFE. Targets the residual false
  // positives that cycle-2's plurality guard CANNOT help: genuine FREE-PANEL ERRORS where the free 8B
  // models agree FALSE on an obscure-but-true fact — there is NO TRUE plurality to protect, so the guard
  // above is a no-op. When the aggregate decision IS 'vetoed' but the veto is WEAK/UNCERTAIN, escalate
  // ONCE to a stronger model (Grok, reusing grokTiebreak→queryProvider, grok-3-mini) as a HIGHER-WEIGHT
  // override vote; a confident Grok TRUE downgrades the veto.
  //
  // WEAK veto := the aggregate hal_score is only MARGINALLY over vetoThreshold (score − veto <= BAND,
  // default HAL_UNCERTAIN_VETO_BAND=0.15), OR the responding families do NOT reach a strong FALSE
  // consensus (FALSE families < ceil(0.75 * responding families)). A STRONG-consensus veto
  // (>= 75% families FALSE AND score comfortably over threshold) is NEVER escalated/overridden — those
  // are real hallucinations, so recall is protected. Reuses the SAME family-aware tallies
  // (falseFams/trueFams) already computed above. Applies in BOTH decision modes. hal_score and the
  // canonical comma-BFT lib (src/hal/lib/*) are untouched — only `decision` (and its reason/quorum_note)
  // changes. Escalate-ONCE: skipped if Grok already voted via the cycle-2 even-split tiebreak (a 'grok'
  // family is already present). FAIL-SAFE: flag off / no key / Grok error / non-confident-TRUE → veto
  // STANDS unchanged (queryProvider never throws → ERROR verdict → no-op). Reversible via HAL_ESCALATE_GROK.
  if (
    decision === 'vetoed' &&
    process.env.HAL_ESCALATE_GROK === 'true' &&
    grokApiKey() &&
    !families.includes('grok') // escalate-once — the cycle-2 tiebreak may have already cast a grok vote
  ) {
    // Local, clamped env parse (no redeploy to tune). BAND in [0,1]; confidences in [0,100].
    const bandNum = Number(process.env.HAL_UNCERTAIN_VETO_BAND);
    const band = Number.isFinite(bandNum) && bandNum >= 0 && bandNum <= 1 ? bandNum : 0.15;
    const confNum = Number(process.env.HAL_GROK_OVERRIDE_CONF);
    const overrideConf = Number.isFinite(confNum) && confNum >= 0 && confNum <= 100 ? confNum : 80;
    const cleanNum = Number(process.env.HAL_GROK_OVERRIDE_CLEAN_CONF);
    const cleanConf = Number.isFinite(cleanNum) && cleanNum >= 0 && cleanNum <= 100 ? cleanNum : 95;

    const units = familyAware ? families_used : providers_used;
    const falseN = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
    const strongFalseCount = falseN >= Math.ceil(0.75 * units); // >= 75% of responding families said FALSE
    const weakByScore = hal_score - vetoThreshold <= band; // veto is only marginally over threshold
    const isWeakVeto = weakByScore || !strongFalseCount;

    if (isWeakVeto) {
      console.log(
        `  - [grok-override] WEAK veto (score ${hal_score.toFixed(3)} vs veto ${vetoThreshold.toFixed(3)}, ` +
          `margin ${(hal_score - vetoThreshold).toFixed(3)} <= band ${band} ? ${weakByScore}; ` +
          `FALSE ${falseN}/${units} >= ceil(0.75*${units})=${Math.ceil(0.75 * units)} ? ${strongFalseCount}) — escalating ONCE to Grok`,
      );
      const gv = await grokTiebreak(deliverable, maxTokens, quorumId); // never throws → ERROR verdict on failure
      attempted += 1;
      if (gv && gv.verdict === 'TRUE' && gv.confidence >= overrideConf) {
        // Grok (higher-weight) confidently confirms TRUE → override the weak veto. clean if VERY
        // confident (>= cleanConf), else flagged (keep a soft signal for review).
        const downgraded: HalDecision = gv.confidence >= cleanConf ? 'clean' : 'flagged';
        console.log(`  - [grok-override] Grok says TRUE @${gv.confidence}% (>= ${overrideConf}) — downgrading veto -> '${downgraded}'`);
        decision = downgraded;
        decision_reason = `A higher-weight verifier (Grok) judged this claim TRUE at ${gv.confidence}% confidence, overriding a WEAK free-panel FALSE veto (${falseN} of ${units} ${familyAware ? 'families' : 'providers'} FALSE, score ${hal_score.toFixed(3)}). Downgraded to '${downgraded}'.`;
        quorum_note = `Cycle3 Grok override: weak veto (score ${hal_score.toFixed(3)}, FALSE ${falseN}/${units}) overridden by Grok TRUE @${gv.confidence}% → '${downgraded}'.`;
      } else if (gv && gv.verdict !== 'ERROR') {
        console.log(`  - [grok-override] Grok did NOT confidently confirm TRUE (verdict ${gv.verdict} @${gv.confidence}%) — veto STANDS`);
      } else {
        console.warn(`  - [grok-override] Grok unavailable/errored — veto STANDS (fail-safe, no-op)`);
      }
    }
  }

  // --- SBFA v0.2 SHADOW + GLASS BOX (default ON). ZERO extra inference: it reuses the per-provider
  // verdicts already computed and makes NO new LLM calls. The decision trace is pure DST math (sub-ms),
  // attached to EVERY decision so the wrapper + HITL PWA always have the Glass Box (§7 CC, task 3).
  // The live `decision` is NOT changed unless HAL_SBFA_ENFORCE=true (A6-gated, defer-only). Telemetry
  // persistence for the Gate-ON measurement is SAMPLED (~10%) and fired OFF the hot path (setImmediate,
  // never awaited) — so prod never eats latency and the shadow can never block a live decision. ---
  let sbfaField: FactCheckResult['sbfa'];
  if (process.env.HAL_SBFA_SHADOW !== 'false') {
    try {
      const votes = votesFromVerdicts(verdicts);
      // Placeholder oracle until GA wires the verified-outcome oracle (§2.1). NOT a real reliability source.
      const oracle = new ConstantReliabilityOracle(0.7, 4);
      const v = sbfaConsensus({ votes, stakes: sbfaStakes(), action: sbfaAction(), category: 'factual', oracle });
      let enforced = false;
      if (process.env.HAL_SBFA_ENFORCE === 'true' && decision === 'vetoed' && (v.decision === 'abstain' || v.decision === 'escalate')) {
        // A6-gated: SBFA says "insufficient consensus / defer" → downgrade the veto to flagged (defer,
        // do not punish). Never the reverse. Logged loudly so the override is auditable.
        decision = 'flagged';
        enforced = true;
        quorum_note = `SBFA v0.2 ${v.decision} (belief ${v.belief_act.toFixed(3)}, ignorance ${v.ignorance_mass.toFixed(3)}): would-be 'vetoed' deferred to 'flagged'. ${v.reason}`;
      }
      sbfaField = {
        decision: v.decision,
        belief: v.belief_act,
        belief_not: v.belief_not,
        ignorance_mass: v.ignorance_mass,
        confidence: v.confidence,
        weighted_agreement: v.weighted_agreement,
        escalate_to: v.escalate_to,
        correlated_warning: v.correlated_warning,
        comma_conservative: v.comma_conservative,
        reliability_source: v.reliability_source,
        enforced,
        trace: v.trace,
      };
      // SAMPLED (~10%), OFF-HOT-PATH telemetry for the Gate-ON measurement — fire-and-forget, never awaited.
      if (sbfaSampleHit()) {
        const liveDecision = decision; // final live decision (post-enforce)
        setImmediate(() => {
          try {
            sbfaTelemetrySink({
              live_decision: liveDecision,
              sbfa_decision: v.decision,
              belief: v.belief_act,
              ignorance_mass: v.ignorance_mass,
              weighted_agreement: v.weighted_agreement,
              enforced,
            });
          } catch {
            /* telemetry must never affect the request */
          }
        });
      }
    } catch {
      // Shadow must never break the live path — swallow and continue without the field.
      sbfaField = undefined;
    }
  }

  // --- WS1.2a DUAL-PATH RETRIEVAL SLOW PATH (gated, additive). After the FAST parametric quorum has
  // produced its decision above, when HAL_RETRIEVAL_ENABLED==='true' AND this case is a SLOW-PATH
  // TRIGGER, retrieve web evidence and CRAG-grade it to REFINE the decision (upgrade a low-confidence
  // veto/flag to clean on ≥2-independent-source corroboration; downgrade a clean/flag to vetoed on
  // ≥2-independent contradiction). The fast path is UNCHANGED when the trigger is not met or the flag
  // is off. Thresholds are env/config with safe defaults. retrieveEvidence + gradeEvidence NEVER throw;
  // the whole block is additionally try/guarded so the slow path can never break a live decision.
  // Also emits the RRL scoring-hook record at the CRAG decision point (log only — no RepID mutation). ---
  let retrievalField: FactCheckResult['retrieval'];
  let rrlField: RrlHookRecord | undefined;
  if (process.env.HAL_RETRIEVAL_ENABLED === 'true') {
    const slowStart = Date.now();
    try {
      const ctNum = Number(process.env.HAL_RETRIEVAL_CONF_TRIGGER);
      const confTrigger = Number.isFinite(ctNum) && ctNum >= 0 && ctNum <= 1 ? ctNum : 0.67;
      // Trigger 1 — low panel confidence / no strong quorum.
      const lowConfidence =
        (agreement !== null && agreement < confTrigger) || decision === 'abstain' || quorum === 'low' || quorum === 'outage';
      // Trigger 2 — family disagreement (both TRUE and FALSE families present → no strong quorum).
      const familyDisagreement = falseFams.length > 0 && trueFams.length > 0;
      // Trigger 3 — high-stakes flag (caller-declared OR a high-stakes keyword in the claim).
      const highStakes = opts.highStakes === true || isHighStakesText(deliverable);
      // Trigger 4 — explicit forceRetrieval.
      const force = opts.forceRetrieval === true;

      const triggers: string[] = [];
      if (force) triggers.push('forceRetrieval');
      if (lowConfidence)
        triggers.push(`low-confidence(agree=${agreement === null ? 'n/a' : agreement.toFixed(2)}<${confTrigger}|decision=${decision}|quorum=${quorum})`);
      if (familyDisagreement) triggers.push(`family-disagreement(${trueFams.length}T/${falseFams.length}F)`);
      if (highStakes) triggers.push('high-stakes');

      if (triggers.length > 0) {
        const preDecision = decision;
        const evidence = await retrieveEvidence(deliverable);
        let crag: CragResult | undefined;
        let refined = false;

        if (evidence.length > 0) {
          crag = await gradeEvidence(deliverable, evidence);
          // REFINE: a confident CRAG grade (Correct/Incorrect, each already gated on ≥2 independent
          // domains) overrides the fast-path decision. Ambiguous never changes the decision (only sets
          // the disclosure flag). hal_score and the canonical comma-BFT lib (src/hal/lib/*) are untouched.
          if (crag.grade === 'Correct' && (decision === 'vetoed' || decision === 'flagged' || decision === 'abstain')) {
            decision = 'clean';
            refined = true;
            decision_reason = `Slow-path retrieval: ${crag.corroboration_count} INDEPENDENT web source(s) corroborate this claim (CRAG Correct, ${crag.grader} verdict ${crag.verdict} @${crag.confidence}%) — upgraded '${preDecision}' → 'clean'.`;
            quorum_note = `WS1.2a retrieval refine: CRAG Correct (${crag.corroboration_count} independent domains) upgraded '${preDecision}' → 'clean'.`;
            console.log(`  - [hal-retrieval] REFINE Correct: '${preDecision}' → 'clean' (${crag.corroboration_count} independent sources)`);
          } else if (crag.grade === 'Incorrect' && decision !== 'vetoed') {
            decision = 'vetoed';
            refined = true;
            decision_reason = `Slow-path retrieval: ${crag.contradiction_count} INDEPENDENT web source(s) contradict this claim (CRAG Incorrect, ${crag.grader} verdict ${crag.verdict} @${crag.confidence}%) — downgraded '${preDecision}' → 'vetoed'.`;
            quorum_note = `WS1.2a retrieval refine: CRAG Incorrect (${crag.contradiction_count} independent domains) downgraded '${preDecision}' → 'vetoed'.`;
            console.log(`  - [hal-retrieval] REFINE Incorrect: '${preDecision}' → 'vetoed' (${crag.contradiction_count} independent sources)`);
          } else {
            console.log(`  - [hal-retrieval] CRAG ${crag.grade} (verdict ${crag.verdict} @${crag.confidence}%) — decision '${decision}' unchanged${crag.disclosure_flag ? ' (disclosure flagged)' : ''}`);
          }
        } else {
          console.log(`  - [hal-retrieval] triggered (${triggers.join('; ')}) but 0 evidence retrieved — decision '${decision}' unchanged`);
        }

        retrievalField = {
          triggered: true,
          trigger_reason: triggers.join('; '),
          evidence_count: evidence.length,
          pre_retrieval_decision: preDecision,
          refined,
          latency_ms: Date.now() - slowStart,
          ...(crag
            ? {
                crag: {
                  grade: crag.grade,
                  verdict: crag.verdict,
                  confidence: crag.confidence,
                  corroboration_count: crag.corroboration_count,
                  contradiction_count: crag.contradiction_count,
                  disclosure_flag: crag.disclosure_flag,
                  grader: crag.grader,
                  ...(crag.grader_model ? { grader_model: crag.grader_model } : {}),
                  reasons: crag.reasons,
                  sources: crag.graded_sources.map((g) => ({
                    url: g.url,
                    registrable_domain: g.registrable_domain,
                    stance: g.stance,
                    content_hash: g.content_hash,
                    timestamp: g.timestamp,
                  })),
                },
              }
            : {}),
        };

        // RRL SCORING HOOK — capture the fields a future RRL delta consumes (log only, no RepID write).
        rrlField = {
          claim_hash: crypto.createHash('sha256').update(String(deliverable ?? '')).digest('hex'),
          source_credibility_grade: crag?.grade ?? 'Ambiguous',
          crag_verdict: crag?.verdict ?? 'UNCERTAIN',
          corroboration_count: crag?.corroboration_count ?? 0,
          contradiction_count: crag?.contradiction_count ?? 0,
          grader_confidence: crag?.confidence ?? 0,
          disclosure_fired: crag?.disclosure_flag ?? true,
          abstain_fired: decision === 'abstain',
          retrieval_source_count: evidence.length,
          hal_decision: decision,
          refined,
        };
        try {
          rrlTelemetrySink(rrlField);
        } catch {
          /* telemetry must never affect the request */
        }
      }
    } catch (e) {
      // The slow path must NEVER break the live decision. Any unexpected error → keep the fast path.
      console.warn(`[hal-retrieval] slow path degraded (ignored, fast-path decision kept): ${(e as Error)?.message ?? String(e)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // GROUND-TRUTH GATE — our own facts get the last word about our own systems.
  //
  // Runs AFTER the quorum, not instead of it: the quorum's hal_score and verdicts
  // stay intact and observable, and only `decision` can move. That costs the
  // provider calls even when the corpus decides, which is the price of keeping
  // the two signals independently auditable.
  //
  // Two directions, both real:
  //   contradicted → force 'vetoed'. Catches internal falsehoods the external
  //                  quorum cannot detect, e.g. "contracts are on Ethereum
  //                  mainnet" (recorded wrong_value). This makes HAL STRICTER.
  //   corroborated → lift 'vetoed'/'flagged' to 'clean'. This is the false-
  //                  positive fix; it never touches an already-'clean' verdict.
  //
  // Kill switch: HAL_GROUND_TRUTH_GATE=false. A degraded lookup changes nothing.
  let groundTruthField: GroundTruthResult | undefined;
  if (process.env.HAL_GROUND_TRUTH_GATE !== 'false') {
    try {
      const gt = await checkGroundTruth(deliverable);
      groundTruthField = gt;

      if (gt.degraded) {
        console.warn(`[ground-truth-gate] degraded (decision '${decision}' unchanged): ${gt.reason}`);
      } else if (gt.verdict === 'contradicted' && decision !== 'vetoed') {
        console.log(`[ground-truth-gate] '${decision}' -> 'vetoed': ${gt.reason}`);
        decision = 'vetoed';
        decision_reason = gt.reason;
      } else if (gt.verdict === 'corroborated' && (decision === 'vetoed' || decision === 'flagged')) {
        console.log(`[ground-truth-gate] '${decision}' -> 'clean': ${gt.reason}`);
        decision = 'clean';
        decision_reason = gt.reason;
      }
    } catch (e: any) {
      // Belt and braces: checkGroundTruth already never throws.
      console.warn(`[ground-truth-gate] threw (ignored, decision kept): ${e?.message ?? String(e)}`);
    }
  }

  return {
    hal_score, decision, verdicts, providers_used, families_used, families, agreement, degraded: quorumCount < 2, latency_ms,
    quorum, provider_health: { attempted: attempted, succeeded: providers_used, failed },
    ...(groundTruthField ? { ground_truth: groundTruthField } : {}),
    ...(decision_reason ? { decision_reason } : {}),
    ...(quorum_note ? { quorum_note } : {}),
    ...(sbfaField ? { sbfa: sbfaField } : {}),
    ...(familiesUnmapped.length ? { families_unmapped: familiesUnmapped } : {}),
    ...(weightDedupField ? { weight_dedup: weightDedupField } : {}),
    ...(retrievalField ? { retrieval: retrievalField } : {}),
    ...(rrlField ? { rrl: rrlField } : {}),
  };
}

/**
 * Resolve fact-check thresholds from env (Phase 1 — runtime-tunable, no
 * redeploy). Defaults: veto 0.5 (clear majority confidently-false), flag 0.35.
 * Calibration max-F1 was veto≈0.30 (more aggressive); set HAL_VETO_THRESHOLD
 * to tune. Clamped to [0,1]; flag never above veto.
 */
export function factCheckOptsFromEnv(): { vetoThreshold: number; flagThreshold: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d;
  };
  const vetoThreshold = num(process.env.HAL_VETO_THRESHOLD, 0.5);
  const flagThreshold = Math.min(num(process.env.HAL_FLAG_THRESHOLD, 0.35), vetoThreshold);
  return { vetoThreshold, flagThreshold };
}

/**
 * Build the free-tier fact-check provider set from env (groq + cerebras +
 * fireworks). 3 providers → majority vote + non-degraded agreement. Only
 * key-present providers are included. Models overridable via HAL_S2_*_MODEL.
 * (Fireworks default kimi-k2p5 is verbose but populates `content`; gpt-oss-120b
 * is a reasoning model with empty content — avoid.)
 */
/**
 * Per-provider enablement map for the fact-check quorum. Keys mirror the
 * HAL_S2_ENABLE_<X> env flags. groq is the only PURE always-on host (key-
 * presence only). cerebras is gated by HAL_S2_ENABLE_CEREBRAS but defaults ON
 * (flag unset → on) so today's behavior is unchanged; everything else is opt-in
 * (default OFF). `buildFactCheckProviders()` derives this from env; the runtime-
 * config layer (`src/hal/config.ts`) derives it from repid_config → env →
 * default and passes it here, so a provider can be flipped from mobile/SQL with
 * no redeploy.
 */
export interface FactCheckProviderEnable {
  groq: boolean;
  cerebras: boolean;
  fireworks: boolean;
  deepseek: boolean;
  gemini: boolean;
  mistral: boolean;
  qwen: boolean;
  /** OpenRouter (aggregator) — last-resort backfill family; optional so existing callers compile. */
  openrouter?: boolean;
}

/**
 * HAL QUORUM AUTO-BACKFILL (2026-07-07, HAL_QUORUM_AUTOBACKFILL, default true).
 * When groq AND cerebras both 429 under burst the base quorum drops below
 * MIN_QUORUM_FOR_VETO=2 and NO verdict can form. To keep the quorum alive we
 * auto-include the next cheapest LIVE families whenever their KEY is present —
 * deepseek → gemini → mistral → openrouter (cheapest-first, so the R6
 * cost-ordered assembly still only PAYS for them when the free tier can't form a
 * quorum). A provider is only ever added if its API key is present.
 * Reversible: set HAL_QUORUM_AUTOBACKFILL=false to restore pure per-provider
 * gating (a passed `enabled.X=true` / HAL_S2_ENABLE_<X>=true still force-includes).
 */
function quorumAutoBackfillOn(): boolean {
  return process.env.HAL_QUORUM_AUTOBACKFILL !== 'false';
}

/**
 * Build the fact-check provider set for a given enablement map. A provider is
 * included only when it is BOTH enabled AND its API key is present. Model
 * defaults / overrides are unchanged (HAL_S2_*_MODEL still apply).
 */
export function buildFactCheckProvidersWith(enabled: FactCheckProviderEnable): FactCheckProviderCfg[] {
  const out: FactCheckProviderCfg[] = [];
  // Auto-backfill: OR the passed enable flag with the default-on backfill so a backfill family is
  // included when EITHER it was explicitly enabled OR (autobackfill on AND its key is present). This
  // preserves cheapest-first ordering (deepseek → gemini → mistral → openrouter appear in that order).
  const ab = quorumAutoBackfillOn();
  // S-QUORUM (2026-06-02): groq llama-3.3-70b-versatile 429s on the free tier under any burst;
  // llama-3.1-8b-instant has a far higher free RPM and returns the same clean JSON verdict.
  const g = process.env.GROQ_API_KEY?.trim();
  if (g && enabled.groq) out.push({ name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: g, model: process.env.HAL_S2_GROQ_MODEL ?? 'llama-3.1-8b-instant' });
  // cerebras `llama3.1-8b` 404s on this key (no access); `zai-glm-4.7` is available and returns a
  // correct verdict (in the `reasoning` field — handled in queryProvider) given enough max_tokens.
  const c = process.env.CEREBRAS_API_KEY?.trim();
  if (c && enabled.cerebras) out.push({ name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: c, model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'zai-glm-4.7' });
  // R6/2026-06-04 — fireworks DROPPED from the quorum (account suspended 2026-06-04 → 100% fail, ~31%
  // of calls wasted). Opt-in only (default OFF); never auto-backfilled. Reversible: flip the flag.
  const f = process.env.FIREWORKS_API_KEY?.trim();
  if (f && enabled.fireworks) out.push({ name: 'fireworks', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', apiKey: f, model: process.env.HAL_S2_FIREWORKS_MODEL ?? 'accounts/fireworks/models/kimi-k2p5' });
  // R4 — DeepSeek (cheap paid) is the most reliable quorum anchor so a >= 2-family quorum forms even
  // when the free tiers (groq/cerebras) throttle under prod burst. Cheapest backfill member → first.
  const d = process.env.DEEPSEEK_API_KEY?.trim();
  if (d && (enabled.deepseek || ab)) {
    out.push({ name: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: d, model: process.env.HAL_S2_DEEPSEEK_MODEL ?? 'deepseek-chat', family: 'deepseek' });
  }
  // R5 — additional independent families so >= 2 families assemble even when groq/cerebras throttle.
  // Auto-backfilled when their key is present (HAL_QUORUM_AUTOBACKFILL); else opt-in per enable flag.
  //
  // GEMINI RE-ROUTE (2026-07-08): the DIRECT Gemini endpoint 429s "credits depleted" (paid Gemini
  // credits exhausted), so the gemini family contributed 0 real votes. When an OpenRouter key is
  // present we re-route the gemini family THROUGH OpenRouter (funded, ~$9.68 balance) — same
  // OpenAI-compatible shape, family stays 'gemini'. `google/gemini-3.5-flash` is verified LIVE on the
  // OpenRouter /models list and returns real content (200, not the direct API's 429). This revives the
  // second family without a separate provider. Falls back to the direct endpoint when no OpenRouter key
  // (using the direct API's own default model). Reversible: HAL_S2_GEMINI_VIA_OPENROUTER=false forces
  // the direct endpoint. Model override: HAL_S2_GEMINI_MODEL (must match the chosen endpoint's slugs).
  const gm = process.env.GEMINI_API_KEY?.trim();
  const orForGemini = process.env.OPENROUTER_API_KEY?.trim();
  const geminiViaOpenRouter = orForGemini && process.env.HAL_S2_GEMINI_VIA_OPENROUTER !== 'false';
  if ((gm || orForGemini) && (enabled.gemini || ab)) {
    if (geminiViaOpenRouter) {
      out.push({ name: 'gemini', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: orForGemini!, model: process.env.HAL_S2_GEMINI_MODEL ?? 'google/gemini-3.5-flash', family: 'gemini' });
    } else if (gm) {
      // RETIRED-MODEL FIX 2026-08-04. The default was `gemini-2.0-flash`, which Google
      // has retired: every call on this endpoint returns HTTP 404 "This model is no
      // longer available". So the gemini family was keyed, enabled, correctly
      // registered — and contributed ZERO votes to every quorum, silently. That is one
      // of the reasons live quorum width fell from 5 families to 3 (see
      // `hal/quorum-width-monitor.ts`), and nothing surfaced it because a provider that
      // always fails looks identical to a provider that was never configured.
      //
      // Verified on THIS endpoint 2026-08-04: gemini-2.5-flash, gemini-flash-latest,
      // gemini-2.5-flash-lite and gemini-3.5-flash all return 200; gemini-2.0-flash
      // returns 404. Note the /models list still ADVERTISES the retired slug, so the
      // list endpoint cannot be used to check this — only a real call can.
      //
      // PINNED, not `-latest`, deliberately. HAL's frozen accuracy claims are stated at
      // a fixed configuration; a floating alias silently changes the model underneath
      // them and turns every comparison into a measurement without its ruler
      // (CLAUDE_RULES 24). Bump it explicitly when re-measuring.
      out.push({ name: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: gm, model: process.env.HAL_S2_GEMINI_MODEL ?? 'gemini-2.5-flash', family: 'gemini' });
    }
  }
  const ms = process.env.MISTRAL_API_KEY?.trim();
  if (ms && (enabled.mistral || ab)) {
    out.push({ name: 'mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: ms, model: process.env.HAL_S2_MISTRAL_MODEL ?? 'mistral-small-latest', family: 'mistral' });
  }
  // OpenRouter — LAST backfill resort (aggregator). Its family derives from the configured model, so the
  // DEFAULT is a QWEN model — a family distinct from the always-on hosts (groq=llama, cerebras=glm) and
  // the other backfill families (deepseek/gemini/mistral). A llama default would collapse with groq and
  // break the family-independence quorum.
  //
  // DEAD-SLUG FIX (2026-07-08): the prior default `qwen/qwen-2.5-72b-instruct:free` was RETIRED and 404s
  // on the OpenRouter API (verified against the live /models list + a real completion call — 404), so
  // OpenRouter contributed 0 votes and the quorum fell back to the extractor ~half the time. The live
  // slugs are the PAID `qwen/qwen-2.5-72b-instruct` (verified 200 + real content) and the `:free`
  // qwen3 variants — but the free variants 429 hard under any load (verified), which defeats a backfill
  // whose whole job is to fire when the free tiers throttle. So the default is the cheap PAID qwen
  // ($0.36/M in, ~$0 per verdict; we have OpenRouter balance). Override via HAL_S2_OPENROUTER_MODEL
  // (pick a family not already present, else it counts as ONE vote with it) — verify the slug is on the
  // live /models list first.
  const or = process.env.OPENROUTER_API_KEY?.trim();
  if (or && (enabled.openrouter || ab)) {
    out.push({ name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: or, model: process.env.HAL_S2_OPENROUTER_MODEL ?? 'qwen/qwen-2.5-72b-instruct' });
  }
  // qwen stays opt-in (endpoint region varies per key) — NOT auto-backfilled.
  const qw = (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY)?.trim();
  if (qw && enabled.qwen) {
    out.push({ name: 'qwen', endpoint: process.env.HAL_S2_QWEN_ENDPOINT ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: qw, model: process.env.HAL_S2_QWEN_MODEL ?? 'qwen-plus', family: 'qwen' });
  }
  // FRONTIER PANEL (opt-in, HAL_S2_ENABLE_FRONTIER, default OFF → prod unchanged). Adds STRONG models
  // as standing quorum members — the panel's ceiling is set by its members, and the free 8B panel's
  // confident-wrong errors on obscure facts are exactly what a frontier voter corrects. Routed through
  // OpenRouter (OpenAI-compatible; ANTHROPIC's own API is not) — verified LIVE 2026-08-09: openai/gpt-4o
  // + anthropic/claude-sonnet-4 both 200 on this key. Distinct families (openai, anthropic) not otherwise
  // in the panel. tier 'escalation' → only fire in the standing panel when cost-ordering is OFF
  // (HAL_QUORUM_COST_ORDERED=false), which is the measured "frontier standing panel" config.
  const orFront = process.env.OPENROUTER_API_KEY?.trim();
  const frontierOn = process.env.HAL_S2_ENABLE_FRONTIER === 'true';
  if (orFront && frontierOn) {
    out.push({ name: 'or-gpt', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: orFront, model: process.env.HAL_S2_FRONTIER_OPENAI_MODEL ?? 'openai/gpt-4o', family: 'openai', tier: 'escalation' });
    out.push({ name: 'or-claude', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: orFront, model: process.env.HAL_S2_FRONTIER_ANTHROPIC_MODEL ?? 'anthropic/claude-sonnet-4', family: 'anthropic', tier: 'escalation' });
  }
  // FREE FRONTIER MEMBER (opt-in, HAL_S2_ENABLE_FRONTIER_FREE, default OFF → prod unchanged).
  // DELIBERATELY INDEPENDENT of HAL_S2_ENABLE_FRONTIER: that flag's two-member panel is already a
  // MEASURED configuration (F1 0.9183 mean, n=3, rigorous-v1@596f10de18d0). Folding a third member
  // into it would silently redefine what "+ frontier" means and invalidate that recorded number —
  // the ruler problem of CLAUDE_RULES 24. A separate flag keeps the measured arm byte-identical and
  // makes this a NEW configuration width that must earn its own baseline.
  //
  // MODEL: nvidia/nemotron-3-ultra-550b-a55b:free — 550B MoE, 1M context, $0 prompt AND completion.
  // Verified LIVE 2026-08-09 against OpenRouter /api/v1/models (present, pricing 0/0) on this key.
  // The point of the experiment: the paid frontier panel bought only ~+0.01 F1 at real cost, so the
  // question is whether a frontier-CLASS voter at ZERO marginal cost reaches the same lift.
  //
  // FAMILY 'nvidia' is declared EXPLICITLY (not regex-derived) and is distinct from every other panel
  // family — groq=llama, cerebras=glm, deepseek, gemini, mistral, openrouter=qwen, or-gpt=openai,
  // or-claude=anthropic. A collision would make this ONE vote with an existing member rather than an
  // independent one, which is exactly what the family-independence quorum forbids. Not yet in
  // family-registry.ts (same gap as gpt-4o/sonnet-4 — logged as hal_family_unmapped); the explicit
  // field wins at runtime, and registering all three together is a separate, DB-touching change.
  //
  // RATE-LIMIT CAVEAT: `:free` slugs 429 hard under load (see the OpenRouter backfill note above).
  // A run where this voter 429s measures NOTHING about quality — check its vote count before reading
  // any F1 delta, per CLAUDE_RULES 24 (a dead provider is a provider failure, not a regression).
  if (orFront && process.env.HAL_S2_ENABLE_FRONTIER_FREE === 'true') {
    out.push({ name: 'or-nemotron', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: orFront, model: process.env.HAL_S2_FRONTIER_FREE_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free', family: 'nvidia', tier: 'escalation' });
  }
  // DATA-LOCALITY: when LOCAL_LLM_BASE_URL (or OPENAI_BASE_URL) is set, redirect every openai-compat
  // fact-check provider to the local base (Ollama/vLLM/LiteLLM can host several model names on one
  // endpoint), so the verify path's prompt egress stays on the operator's own box. Every provider in
  // this builder is openai-compat, so all are redirected. Unset → endpoints unchanged (hosted path).
  const localBase = (process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  if (localBase) {
    for (const p of out) p.endpoint = resolveProviderEndpoint(p.endpoint, localBase, 'openai-compat');
  }
  // Tag the always-on hosts with their family (model-derived; explicit for clarity). CROSS-FIX
  // 2026-07-05 — registry-primary (familyOfResolved): accurate for registered models, legacy-regex
  // fallback + hal_family_unmapped log for unknowns (never throws). Providers that already declared a
  // .family above keep it.
  for (const p of out) if (!p.family) p.family = familyOfResolved(p.model);
  return out;
}

/**
 * Env-driven provider set. groq is the only PURE always-on host (key-presence
 * only). cerebras is now an opt-in FAMILY gated by HAL_S2_ENABLE_CEREBRAS,
 * exactly like deepseek/gemini/mistral — but it DEFAULTS ON (flag unset → on)
 * so today's behavior is preserved; set HAL_S2_ENABLE_CEREBRAS='false' to drop
 * it. This is what lets the cheapest-first assembly escalate past the free wave:
 * with cerebras OFF, groq is a 1-family free wave, so the quorum reaches the
 * deepseek (cheap) wave and groq+deepseek forms. The rest require an explicit
 * =true opt-in. Thin wrapper over buildFactCheckProvidersWith() so the env path
 * and the runtime-config path share one builder.
 */
export function buildFactCheckProviders(): FactCheckProviderCfg[] {
  return buildFactCheckProvidersWith({
    groq: true,
    // default ON (unset → on), OFF only on an explicit 'false' — mirrors
    // PROVIDER_DEFAULTS.HAL_S2_ENABLE_CEREBRAS=true in src/hal/config.ts.
    cerebras: process.env.HAL_S2_ENABLE_CEREBRAS !== 'false',
    fireworks: process.env.HAL_S2_ENABLE_FIREWORKS === 'true',
    deepseek: process.env.HAL_S2_ENABLE_DEEPSEEK === 'true',
    gemini: process.env.HAL_S2_ENABLE_GEMINI === 'true',
    mistral: process.env.HAL_S2_ENABLE_MISTRAL === 'true',
    qwen: process.env.HAL_S2_ENABLE_QWEN === 'true',
    openrouter: process.env.HAL_S2_ENABLE_OPENROUTER === 'true',
  });
}

/**
 * A3 — FAMILY-INDEPENDENCE AUDIT. Two providers serving the same base model FAMILY (e.g. two
 * Llama endpoints) are ONE independent vote, not two; counting them as two would let a single
 * model's error form a fake "quorum" and break the dissent guarantee the whole gate rests on.
 * Returns the families that cover more than one configured provider.
 */
export function auditFamilyIndependence(providers: FactCheckProviderCfg[]): {
  independent: boolean;
  families: string[];
  collapsed: Array<{ family: string; providers: string[] }>;
} {
  const byFam = new Map<string, string[]>();
  for (const p of providers) {
    // CROSS-FIX 2026-07-05 — registry-primary family classification so the independence audit sees the
    // accurate (non-spoofable) family; unmapped models fall back to familyOf() + log (never throw).
    const fam = p.family ?? familyOfResolved(p.model);
    byFam.set(fam, [...(byFam.get(fam) ?? []), p.name]);
  }
  const collapsed = [...byFam.entries()].filter(([, ps]) => ps.length > 1).map(([family, ps]) => ({ family, providers: ps }));
  return { independent: collapsed.length === 0, families: [...byFam.keys()], collapsed };
}

/**
 * A3 — loud boot-time assertion. Logs the live family map; on a collapse it logs a LOUD error and,
 * when HAL_STRICT_FAMILY_INDEPENDENCE=true, throws (default = warn-not-crash so a misconfig is
 * visible without taking the service down).
 */
export function assertFamilyIndependenceAtBoot(providers: FactCheckProviderCfg[] = buildFactCheckProviders()): void {
  const a = auditFamilyIndependence(providers);
  console.log(`[hal] fact-check quorum: ${providers.length} providers across ${a.families.length} families [${a.families.join(', ')}]`);
  if (!a.independent) {
    const msg = `[hal] *** FAMILY-INDEPENDENCE VIOLATION *** these families back >1 provider and count as ONE vote, not several — quorum dissent guarantee broken: ${a.collapsed.map((c) => `${c.family}=[${c.providers.join(',')}]`).join('; ')}`;
    console.error(msg);
    if (process.env.HAL_STRICT_FAMILY_INDEPENDENCE === 'true') throw new Error(msg);
  }
}
