/**
 * SESSION GUARD (CC, 2026-06-25 ship) — the packaged, sequence-aware entry point.
 *
 * `guard()` is memoryless (per-action). `SessionGuard` threads a SessionRiskTracker across a chain
 * of actions so recon→credential / recon→destructive escalate even though each step alone is T0 —
 * i.e. it catches the PocketOS chain FROM THE PACKAGE, not just in the repo's internal loop.
 *
 *   const sg = new SessionGuard('agent-session-1');
 *   sg.guard({ kind: 'read', ... });   // ×3 → T0 each
 *   sg.guard({ kind: 'read', paths: ['config/master.token'] }); // → BLOCK (T2) in recon context
 */
import { SessionRiskTracker } from '../src/services/session-risk';
import { maxTier, type Action, type Tier } from '../src/services/consequence-classifier';
import { guard, type GuardResult, type GuardOptions, type GuardVerdict } from './guard';

const VERDICT_FOR_TIER: Record<Tier, GuardVerdict> = { T0: 'ALLOW', T1: 'REVIEW', T2: 'BLOCK' };

export interface SessionGuardResult extends GuardResult {
  /** Tier from per-action classification alone (memoryless). */
  perActionTier: Tier;
  /** Tier after the session layer (≥ perActionTier). */
  sessionTier: Tier;
  /** True when the session context raised the tier above the per-action verdict. */
  sessionEscalated: boolean;
  sessionScore: number;
  sessionReason: string;
}

export class SessionGuard {
  readonly session: SessionRiskTracker;
  constructor(public readonly sessionId: string) {
    this.session = new SessionRiskTracker(sessionId);
  }

  /** Govern one action in the session's context. Same result shape as guard(), plus session fields. */
  guard(action: Action, opts: GuardOptions = {}): SessionGuardResult {
    const { assessment } = this.session.govern(
      action,
      opts.spendContext ? { spendContext: opts.spendContext } : {}
    );
    const base = guard(action, opts); // per-action verdict + trace (hardened classifier + chamber)
    const finalTier = maxTier(base.tier, assessment.finalTier);
    const escalated = finalTier !== base.tier;
    const verdict: GuardVerdict = escalated ? VERDICT_FOR_TIER[finalTier] : base.verdict;
    const reason = escalated ? `${assessment.reason} [session] | per-action: ${base.reason}` : base.reason;

    return {
      ...base,
      tier: finalTier,
      verdict,
      reason,
      perActionTier: assessment.perActionTier,
      sessionTier: assessment.finalTier,
      sessionEscalated: escalated,
      sessionScore: this.session.currentScore(),
      sessionReason: assessment.reason,
      log: { ...base.log, tier: finalTier, verdict, reason },
    };
  }

  /** Emit the session risk as a RepID/validation signal (behavioral evidence). */
  toRepIdSignal(agentId: string) {
    return this.session.toRepIdSignal(agentId);
  }
}
