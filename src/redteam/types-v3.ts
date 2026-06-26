import { type AttackCaseV2, type AttackSequenceV2 } from './types-v2';

/** Round-6 session-aware sequence breach criteria. */
export type SessionBreachWhen =
  | AttackSequenceV2['breachWhen']
  /** Session must escalate to T2+ before step index `escalateBeforeStep`. */
  | 'session-escalates-before'
  /** 3rd sub-threshold spend in window must hit T2_SPEND_VELOCITY. */
  | 'spend-burst-escalates';

export interface AttackSequenceV3 extends Omit<AttackSequenceV2, 'breachWhen'> {
  breachWhen: SessionBreachWhen;
  /** For session-escalates-before: must see T2+ before this 0-based step index. */
  escalateBeforeStep?: number;
  /** Human label for the destructive phase (reporting). */
  destructivePhaseLabel?: string;
}

export interface SessionAttackMeta {
  sessionAware: true;
  notes?: string;
}

export type AttackCaseV3 = AttackCaseV2 & { sessionMeta?: SessionAttackMeta };