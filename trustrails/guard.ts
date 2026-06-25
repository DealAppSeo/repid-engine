/**
 * TrustRails — installable governance guardrail.
 *
 * Single public entry: `guard(action) → { tier, verdict, reason, log }`.
 * Composes the three governance pieces from the wired integration branch:
 *   - consequence-classifier (CC)  — deterministic T0/T1/T2 (spec v0.3 §3)
 *   - adversarial chamber (XC)      — T1 evidence-gated review (spec v0.3 §4)
 *   - the gate's decision/trace logic — expressed here as the packaging layer
 *
 * Pure runtime: imports only the classifier + chamber (fs/path), NO express, NO DB,
 * NO src/config. That keeps the package clean-clone runnable with a tiny install.
 */
import {
  type Action,
  type Tier,
  type ClassifierConfig,
  classifyAction,
} from '../src/services/consequence-classifier';
import {
  AdversarialRouter,
  scoreAttack,
  verifyObjection,
  type ProposedAction,
  type ChamberParticipant,
  type AdversarialObjection,
} from '../src/services/adversarial-router';
import { type ActionClass, lineagesAreDiverse } from '../src/config/adversarial-templates';

export const TRUSTRAILS_VERSION = '0.7.0';

/** ALLOW/PROCEED = permitted. BLOCK/ESCALATE/REVIEW = stopped (needs human or more scrutiny). */
export type GuardVerdict = 'ALLOW' | 'PROCEED' | 'REVIEW' | 'ESCALATE' | 'BLOCK';

export interface RuleTrace {
  ruleId: string;
  tier: Tier;
  reason: string;
}

export interface ChamberTrace {
  templateId: string;
  templateVersion: string;
  outcome: 'escalate' | 'proceed' | 'tie-break';
  decisionReason: string;
  objectionScore: 'substantive' | 'weak' | 'unverified' | 'empty';
  verifiedCitations: { kind: string; value: string; verified: boolean; detail: string }[];
  lineageDiverse: boolean;
}

/** The structured "why was this gated" record (Phase 3). */
export interface DecisionTrace {
  ts: string;
  trustrailsVersion: string;
  configVersion: string;
  action: { kind: string; summary?: string; refs?: string[] };
  tier: Tier;
  ruleFloor: Tier;
  failSafe: boolean;
  rulesFired: RuleTrace[];
  verdict: GuardVerdict;
  reason: string;
  humanSignOffRequired: boolean;
  chamber?: ChamberTrace;
}

export interface GuardResult {
  tier: Tier;
  verdict: GuardVerdict;
  reason: string;
  log: DecisionTrace;
}

/** Optional T1 chamber inputs — supply to let a verified adversarial objection resolve a T1. */
export interface ChamberInputs {
  actionClass: ActionClass;
  proposer: ChamberParticipant;
  adversary: ChamberParticipant;
  objection: AdversarialObjection;
}

export interface GuardOptions {
  /** Tunable consequence rules (from trustrails.config). Defaults to the classifier's DEFAULT_CONFIG. */
  config?: ClassifierConfig;
  /** Config version string for the trace (provenance). */
  configVersion?: string;
  /** Which tiers REQUIRE human sign-off (block). Default ['T2']. Add 'T1' to force review of all T1. */
  humanSignOffTiers?: Tier[];
  /** Optional T1 adversarial-chamber inputs. */
  chamber?: ChamberInputs;
  /** Repo root for non-LLM evidence verification (test-file existence checks). */
  repoRoot?: string;
  /** Optional sink to persist the trace (Phase 3). Never allowed to throw into the caller. */
  sink?: (trace: DecisionTrace) => void;
  /** ISO timestamp override (tests). */
  now?: string;
}

const ALLOWED_VERDICTS: ReadonlySet<GuardVerdict> = new Set(['ALLOW', 'PROCEED']);

/** True when the guard PERMITS the action (caller may proceed). */
export function isAllowed(result: GuardResult): boolean {
  return ALLOWED_VERDICTS.has(result.verdict);
}

/**
 * Govern a single action. Deterministic for T0/T2; T1 routes through the adversarial chamber
 * when chamber inputs are supplied, else returns REVIEW (consequential, needs scrutiny).
 */
export function guard(action: Action, opts: GuardOptions = {}): GuardResult {
  const ts = opts.now ?? new Date().toISOString();
  const humanSignOffTiers = opts.humanSignOffTiers ?? ['T2'];
  const c = classifyAction(action, { config: opts.config });

  const rulesFired: RuleTrace[] = c.hits.map((h) => ({ ruleId: h.ruleId, tier: h.tier, reason: h.reason }));
  const base = {
    ts,
    trustrailsVersion: TRUSTRAILS_VERSION,
    configVersion: opts.configVersion ?? 'default',
    action: { kind: String(action.kind), summary: action.description, refs: action.paths },
    tier: c.tier,
    ruleFloor: c.ruleFloor,
    failSafe: c.failSafe,
    rulesFired,
  };

  let verdict: GuardVerdict;
  let reason: string;
  let humanSignOffRequired = false;
  let chamberTrace: ChamberTrace | undefined;

  const forcedSignOff = humanSignOffTiers.includes(c.tier);

  if (c.tier === 'T0') {
    verdict = 'ALLOW';
    reason = 'T0 trivial/reversible — act, no gate';
  } else if (c.tier === 'T2') {
    verdict = 'BLOCK';
    humanSignOffRequired = true;
    reason = c.failSafe
      ? 'T2 fail-safe — action matched no rule, blocked to human sign-off (no fail-open)'
      : `T2 critical/irreversible — human sign-off required (${rulesFired.map((r) => r.ruleId).join(', ')})`;
  } else {
    // T1
    if (forcedSignOff) {
      verdict = 'BLOCK';
      humanSignOffRequired = true;
      reason = 'T1 routed to human sign-off by config (humanSignOffTiers includes T1)';
    } else if (opts.chamber) {
      const ch = opts.chamber;
      const proposed: ProposedAction = {
        id: `act-${ts}`,
        actionClass: ch.actionClass,
        artifactSummary: action.description ?? String(action.kind),
        artifactRefs: action.paths,
      };
      const router = new AdversarialRouter({ repoRoot: opts.repoRoot });
      const verified = verifyObjection(ch.objection, opts.repoRoot);
      const objectionScore = scoreAttack(ch.objection, opts.repoRoot);
      const lineageDiverse = lineagesAreDiverse(ch.proposer.lineageProvider, ch.adversary.lineageProvider);
      try {
        const decision = router.decideT1(proposed, ch.proposer, ch.adversary, ch.objection);
        chamberTrace = {
          templateId: decision.templateId,
          templateVersion: '0.1.0',
          outcome: decision.outcome,
          decisionReason: decision.reason,
          objectionScore,
          verifiedCitations: verified.citations.map((v) => ({
            kind: v.kind, value: v.value, verified: v.verified, detail: v.verifyDetail,
          })),
          lineageDiverse,
        };
        if (decision.outcome === 'proceed') {
          verdict = 'PROCEED';
          reason = `T1 survived adversarial scrutiny: ${decision.reason}`;
        } else if (decision.outcome === 'escalate') {
          verdict = 'ESCALATE';
          humanSignOffRequired = true;
          reason = `T1 escalated to human: ${decision.reason}`;
        } else {
          verdict = 'REVIEW';
          humanSignOffRequired = true;
          reason = `T1 tie-break — third lineage required: ${decision.reason}`;
        }
      } catch (err) {
        // lineage violation / A1 tripwire — cannot trust the chamber; escalate.
        verdict = 'ESCALATE';
        humanSignOffRequired = true;
        reason = `T1 chamber invalid — ${err instanceof Error ? err.message : String(err)}`;
        chamberTrace = {
          templateId: 'n/a', templateVersion: '0.1.0', outcome: 'escalate',
          decisionReason: reason, objectionScore, lineageDiverse,
          verifiedCitations: verified.citations.map((v) => ({
            kind: v.kind, value: v.value, verified: v.verified, detail: v.verifyDetail,
          })),
        };
      }
    } else {
      verdict = 'REVIEW';
      humanSignOffRequired = true;
      reason = 'T1 consequential — adversarial review required (no chamber inputs supplied)';
    }
  }

  const log: DecisionTrace = { ...base, verdict, reason, humanSignOffRequired, ...(chamberTrace ? { chamber: chamberTrace } : {}) };

  if (opts.sink) {
    try { opts.sink(log); } catch { /* a trace sink must never break the gate */ }
  }

  return { tier: c.tier, verdict, reason, log };
}
