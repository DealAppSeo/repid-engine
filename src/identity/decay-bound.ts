/**
 * decay-bound.ts — LOOP C9. Bound entities do not silently rot.
 *
 * L5: bound (ABT/SBT/IBT) skip decay; last_verified_action is the public
 * staleness signal. Unclaimed DBTs still decay, and every application writes
 * a typed event. Shadow-first: default does not move current_repid.
 */
import { assessDecay, type DecayAssessment, type DecayMode } from '../scoring/decay-bridge';
import { isBoundKind, type AgentKind } from './kind-custody';

export type TypedDecayEvent = 'DECAY_APPLIED' | 'DECAY_HELD_BOUND' | 'DECAY_WOULD_APPLY';

export interface BoundDecayInput {
  agentId: string;
  kind: AgentKind;
  currentRepid: number;
  activity30d: number;
  lastVerifiedAction: string | null;
  now?: Date;
  mode?: DecayMode;
}

export interface BoundDecayResult {
  bound: boolean;
  score_after: number;
  last_verified_action: string | null;
  idle_days: number | null;
  assessment: DecayAssessment;
  event: { type: TypedDecayEvent; delta: number } | null;
}

export function idleDaysSince(lastVerifiedAction: string | null, now: Date): number | null {
  if (!lastVerifiedAction) return null;
  const t = Date.parse(lastVerifiedAction);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}

export function applyBoundAwareDecay(input: BoundDecayInput): BoundDecayResult {
  const now = input.now ?? new Date();
  const bound = isBoundKind(input.kind);
  const idle_days = idleDaysSince(input.lastVerifiedAction, now);
  const assessment = assessDecay({
    currentRepid: input.currentRepid,
    activity30d: input.activity30d,
    mode: bound ? 'off' : input.mode ?? 'enforce',
  });

  if (bound) {
    return {
      bound: true,
      score_after: input.currentRepid,
      last_verified_action: input.lastVerifiedAction,
      idle_days,
      assessment: {
        ...assessment,
        would_remove: 0,
        decayed_to: input.currentRepid,
        applied: false,
      },
      event: { type: 'DECAY_HELD_BOUND', delta: 0 },
    };
  }

  const mode = input.mode ?? 'shadow';
  const would = assessDecay({
    currentRepid: input.currentRepid,
    activity30d: input.activity30d,
    mode: 'enforce',
  });

  if (mode === 'enforce' && would.would_remove > 0) {
    return {
      bound: false,
      score_after: would.decayed_to,
      last_verified_action: input.lastVerifiedAction,
      idle_days,
      assessment: would,
      event: { type: 'DECAY_APPLIED', delta: -would.would_remove },
    };
  }

  return {
    bound: false,
    score_after: input.currentRepid,
    last_verified_action: input.lastVerifiedAction,
    idle_days,
    assessment: would,
    event: would.would_remove > 0 ? { type: 'DECAY_WOULD_APPLY', delta: -would.would_remove } : null,
  };
}

export function whoWouldStopDecaying<T extends { id: string; kind: AgentKind; would_remove: number }>(
  roster: T[],
): T[] {
  return roster.filter((r) => isBoundKind(r.kind) && r.would_remove > 0);
}
