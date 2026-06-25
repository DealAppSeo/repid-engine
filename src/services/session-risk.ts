/**
 * SESSION RISK LAYER (CC, 2026-06-25 r6) — catch SEQUENCE attacks per-action classification can't.
 *
 * Per-action classification is memoryless, so a recon chain slips through: each of
 * read → read → read → credential-access is T0 alone, then the destructive step lands. This is the
 * PocketOS / Palisade pattern. The fix is a SIMPLE, DETERMINISTIC, AUDITABLE session layer
 * (NOT ANFIS — that's a later, tested upgrade):
 *
 *   session id + rolling window (last N actions) + accumulated risk score (a fraud-detection
 *   pattern: weighted points + velocity + a known-recon-sequence trigger).
 *
 * It is threaded statefully through a SessionRiskTracker. The accumulator is LOGGED so you can see
 * exactly why a session escalated. The session score is also emitted as a RepID/validation signal
 * (behavioral evidence about the agent) — structured here even though prod wiring is later.
 */
import { type Action, type Classification, type Tier, classifyAction, maxTier } from './consequence-classifier';

export type SessionSignal = 'read' | 'write' | 'credential' | 'destructive' | 'prod' | 'spend' | 'other';

export interface SessionConfig {
  /** Rolling window length in actions (N=10–20). */
  windowSize: number;
  /** Accumulated score above which the session escalates the action to at least T1 (chamber). */
  scoreThreshold: number;
  /** Reads/writes in the window at/above which a following credential access escalates to T2. */
  reconReadsForCredential: number;
  /** Reads/writes at/above which a following destructive/prod action escalates to T2. */
  reconReadsForDestructive: number;
  /** Points awarded per signal (deterministic). */
  points: Record<SessionSignal, number>;
}

// Score is a ROLLING-WINDOW SUM (self-limiting): max pure-read window = windowSize × read-points
// (15), kept below scoreThreshold (16) so a benign read-only session NEVER escalates. Flood/velocity
// is handled separately by the Phase-3 rate limiter (time-based), not by inflating this score.
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  windowSize: 15,
  scoreThreshold: 16,
  reconReadsForCredential: 3,
  reconReadsForDestructive: 2,
  points: { read: 1, write: 1, credential: 5, prod: 6, destructive: 8, spend: 1, other: 1 },
};

const CREDENTIAL_RE =
  /token|secret|credential|password|api[_-]?key|private[_-]?key|master[_-]?key|\.env\b|\.pem\b|\.key\b/i;
const DESTRUCTIVE_SQL_RE = /\b(drop|truncate|delete)\b/i;

/**
 * Map a classified action to a coarse session signal (deterministic). Ordered by danger semantics:
 * destructive > credential > prod, so credential material (.pem/.key/token/secret/.env) is labelled
 * 'credential' even though it also matches the prod text-scan.
 */
export function deriveSignal(action: Action, classification: Classification): SessionSignal {
  const ids = new Set(classification.hits.map((h) => h.ruleId));
  const text = `${action.description ?? ''} ${(action.paths ?? []).join(' ')} ${action.sql ?? ''}`;
  if (ids.has('T2_DDL') || (action.sql ? DESTRUCTIVE_SQL_RE.test(action.sql) : false)) return 'destructive';
  if (action.kind === 'secret' || CREDENTIAL_RE.test(text)) return 'credential';
  if (ids.has('T2_PROD_PROJECT') || ids.has('T2_PLATFORM_PROD') || ids.has('T2_PROD_IDENTIFIER_IN_TEXT')) return 'prod';
  if (action.kind === 'read') return 'read';
  if (action.kind === 'file_write') return 'write';
  if (action.kind === 'spend') return 'spend';
  return 'other';
}

export interface SessionWindowEntry {
  signal: SessionSignal;
  tier: Tier;
  ts: number;
}

/** What the session context did to this action (auditable accumulator line). */
export interface SessionAssessment {
  sessionId: string;
  signal: SessionSignal;
  perActionTier: Tier;
  /** Session escalation, if any (null = session did not change the tier). */
  escalateTo: Tier | null;
  finalTier: Tier;
  /** Running accumulated score INCLUDING this action. */
  scoreAfter: number;
  scoreDelta: number;
  reason: string;
  reconReads: number;
  windowCount: number;
}

export interface SessionGovernResult {
  classification: Classification;
  assessment: SessionAssessment;
}

export class SessionRiskTracker {
  readonly sessionId: string;
  private readonly cfg: SessionConfig;
  private window: SessionWindowEntry[] = [];
  private score = 0;
  /** Append-only audit log of every assessment (the accumulator trail). */
  readonly log: SessionAssessment[] = [];

  constructor(sessionId: string, cfg: Partial<SessionConfig> = {}) {
    this.sessionId = sessionId;
    this.cfg = { ...DEFAULT_SESSION_CONFIG, ...cfg };
  }

  private reconReads(): number {
    return this.window.filter((e) => e.signal === 'read' || e.signal === 'write').length;
  }

  private hasPriorCredential(): boolean {
    return this.window.some((e) => e.signal === 'credential');
  }

  /**
   * Classify the action per-action, then apply session context. Records the action into the window
   * and returns the (possibly escalated) decision. Deterministic; logs the accumulator.
   */
  govern(action: Action, opts: { now?: number; spendContext?: { windowTotalUsd: number; windowCount: number } } = {}): SessionGovernResult {
    const now = opts.now ?? Date.now();
    const classification = classifyAction(action, opts.spendContext ? { spendContext: opts.spendContext } : {});
    const signal = deriveSignal(action, classification);
    const perActionTier = classification.tier;

    // recon signals look at the window BEFORE this action (the prior actions).
    const reconReads = this.reconReads();
    const priorCredential = this.hasPriorCredential();
    const scoreDelta = this.cfg.points[signal];

    // ---- Record into the rolling window; score is the SUM over the (capped) window ----
    this.window.push({ signal, tier: perActionTier, ts: now });
    if (this.window.length > this.cfg.windowSize) this.window.shift();
    const scoreAfter = this.window.reduce((s, e) => s + this.cfg.points[e.signal], 0);

    // ---- Escalation rules (deterministic) ----
    let escalateTo: Tier | null = null;
    let reason = `signal=${signal} +${scoreDelta} → window score ${scoreAfter}`;

    if (signal === 'credential' && reconReads >= this.cfg.reconReadsForCredential) {
      escalateTo = 'T2';
      reason = `RECON→CREDENTIAL: ${reconReads} prior reads then credential access — session escalate T2 (score ${scoreAfter})`;
    } else if ((signal === 'destructive' || signal === 'prod') && (reconReads >= this.cfg.reconReadsForDestructive || priorCredential)) {
      escalateTo = 'T2';
      reason = `RECON→${signal.toUpperCase()}: ${reconReads} prior reads${priorCredential ? ' + prior credential' : ''} then ${signal} — session escalate T2 (score ${scoreAfter})`;
    } else if (scoreAfter >= this.cfg.scoreThreshold) {
      escalateTo = maxTier('T1', perActionTier); // at least chamber
      reason = `SESSION SCORE ${scoreAfter} ≥ ${this.cfg.scoreThreshold} — escalate to ${escalateTo} (score ${scoreAfter})`;
    }

    const finalTier = escalateTo ? maxTier(perActionTier, escalateTo) : perActionTier;
    // reflect the final (possibly escalated) tier in the recorded window entry
    this.window[this.window.length - 1]!.tier = finalTier;
    this.score = scoreAfter;

    const assessment: SessionAssessment = {
      sessionId: this.sessionId,
      signal,
      perActionTier,
      escalateTo,
      finalTier,
      scoreAfter,
      scoreDelta,
      reason,
      reconReads,
      windowCount: this.window.length,
    };
    this.log.push(assessment);
    return { classification, assessment };
  }

  currentScore(): number {
    return this.score;
  }

  /**
   * Emit the session risk as a RepID / validation signal — behavioral evidence about the agent.
   * Structured for repid_score_events; NOT wired to prod here (later layer).
   */
  toRepIdSignal(agentId: string): {
    event_type: 'session_risk';
    agent_id: string;
    session_id: string;
    session_risk_score: number;
    escalations: number;
    window: SessionSignal[];
    max_final_tier: Tier;
    rationale: string;
  } {
    const escalations = this.log.filter((a) => a.escalateTo !== null).length;
    const maxFinal = this.log.reduce<Tier>((m, a) => maxTier(m, a.finalTier), 'T0');
    return {
      event_type: 'session_risk',
      agent_id: agentId,
      session_id: this.sessionId,
      session_risk_score: this.score,
      escalations,
      window: this.window.map((e) => e.signal),
      max_final_tier: maxFinal,
      rationale: `${escalations} session escalation(s) over ${this.log.length} actions; final risk ${this.score}`,
    };
  }
}
