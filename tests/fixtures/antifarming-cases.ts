/**
 * antifarming-cases.ts — the threat and honest fixtures for src/shadow/antifarming-eligibility.ts.
 *
 * Each case is one or more events plus the record the shadow function MUST produce for the event
 * named by `subject`. Threat cases are farming patterns; honest cases are the participants the
 * rule must not punish. `two_wallet_sybil_no_trace` is a threat the record CANNOT tell apart from
 * an honest newcomer, and is here to show the outcome is UNKNOWN (no credit, no blame), not a miss
 * dressed as a catch.
 *
 * OwnerLink values are exactly what `ownerRelation` returns (tests check that on real claims).
 */
import type { EligibilityEvent, EvidenceTier, Independence, DimensionStatus, ReasonCode, OwnerLink } from '../../src/shadow/antifarming-eligibility';

export const SAME_STRONG: OwnerLink = { relation: 'same', evidence: 'strong' };
export const SAME_ADMIN: OwnerLink = { relation: 'same', evidence: 'administrative' };
export const DISTINCT_STRONG: OwnerLink = { relation: 'distinct', evidence: 'strong' };
export const DISTINCT_ADMIN: OwnerLink = { relation: 'distinct', evidence: 'administrative' };
export const UNKNOWN: OwnerLink = { relation: 'unknown', evidence: 'none' };

const settled = (receipt_id: string, bound_event_id: string | null) => ({ receipt_id, server_settled: true, bound_event_id });

export interface AntifarmingCase {
  name: string;
  kind: 'threat' | 'honest';
  /** What the case simulates, in one line. */
  story: string;
  events: EligibilityEvent[];
  subject: string;
  expect: {
    tier: EvidenceTier;
    independence: Independence;
    operational: DimensionStatus;
    credibility: DimensionStatus;
    /** The reason that decided the credibility dimension. */
    credibility_decided_by: ReasonCode;
    /** Reasons that must be present (others may be too). */
    reasons_include: ReasonCode[];
  };
}

export const CASES: AntifarmingCase[] = [
  // ── threats ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'same_owner_wash_trade',
    kind: 'threat',
    story: 'Two agents under one signed owner trade with each other; the engine settles it.',
    events: [{
      event_id: 'wash-1', kind: 'trade', actor_id: 'agent-a1', counterparty_id: 'agent-a2',
      counterparty_owner: SAME_STRONG, receipt: settled('r-wash-1', 'wash-1'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'wash-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'COUNTS', credibility: 'ZERO',
      credibility_decided_by: 'OWNER_SAME_STRONG', reasons_include: ['RECEIPT_SERVER_SETTLED', 'OWNER_SAME_STRONG'],
    },
  },
  {
    name: 'two_wallet_sybil',
    kind: 'threat',
    story: 'One person, two fresh wallets, 2FA on both; wallet B was funded from wallet A.',
    events: [{
      event_id: 'sybil-1', kind: 'trade', actor_id: 'wallet-a', counterparty_id: 'wallet-b',
      counterparty_owner: UNKNOWN, account_control: { actor_two_factor: true, counterparty_two_factor: true },
      funding: { counterparty_funded_by: 'actor_owner' },
      receipt: settled('r-sybil-1', 'sybil-1'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'sybil-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'COUNTS', credibility: 'ZERO',
      credibility_decided_by: 'COUNTERPARTY_FUNDED_BY_ACTOR',
      reasons_include: ['TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP', 'OWNER_UNKNOWN', 'COUNTERPARTY_FUNDED_BY_ACTOR'],
    },
  },
  {
    name: 'two_wallet_sybil_no_trace',
    kind: 'threat',
    story: 'The same Sybil with no funding trace: indistinguishable from an honest newcomer.',
    events: [{
      event_id: 'sybil-2', kind: 'trade', actor_id: 'wallet-c', counterparty_id: 'wallet-d',
      counterparty_owner: UNKNOWN, account_control: { actor_two_factor: true, counterparty_two_factor: true },
      receipt: settled('r-sybil-2', 'sybil-2'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'sybil-2',
    expect: {
      tier: 'COUNTERPARTY_REPORTED', independence: 'UNKNOWN', operational: 'COUNTS', credibility: 'UNKNOWN',
      credibility_decided_by: 'OWNER_UNKNOWN', reasons_include: ['TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP', 'OWNER_UNKNOWN'],
    },
  },
  {
    name: 'circular_fund_recycling',
    kind: 'threat',
    story: 'Owners look distinct on signed records, but the payment flows back to the payer\'s owner.',
    events: [{
      event_id: 'circ-1', kind: 'trade', actor_id: 'agent-p', counterparty_id: 'agent-q',
      counterparty_owner: DISTINCT_STRONG, funding: { payment_returned_to_payer_owner: true },
      receipt: settled('r-circ-1', 'circ-1'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'circ-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'ZERO', credibility: 'ZERO',
      credibility_decided_by: 'CIRCULAR_FUNDS', reasons_include: ['OWNER_DISTINCT_STRONG', 'CIRCULAR_FUNDS'],
    },
  },
  {
    name: 'paid_validator_ring',
    kind: 'threat',
    story: 'The provider pays a validator panel that it validates in return; the panel says pass.',
    events: [{
      event_id: 'ring-1', kind: 'trade', actor_id: 'agent-v', counterparty_id: 'agent-w',
      counterparty_owner: DISTINCT_ADMIN, receipt: settled('r-ring-1', 'ring-1'), counterparty_reported_outcome: 'accepted',
      confirmation: { by: 'validator_panel', confirmer_owner: UNKNOWN, paid_by_actor: true, reciprocal_with_actor: true, verdict: 'pass' },
    }],
    subject: 'ring-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'COUNTS', credibility: 'ZERO',
      credibility_decided_by: 'CONFIRMER_PAID_BY_ACTOR',
      reasons_include: ['OWNER_DISTINCT_ADMINISTRATIVE_ONLY', 'CONFIRMER_PAID_BY_ACTOR', 'CONFIRMER_RECIPROCAL_RING'],
    },
  },
  {
    name: 'self_created_bug_and_fix',
    kind: 'threat',
    story: 'The agent ships a bug, then claims an unrelated poster\'s bounty for fixing it; the tests pass.',
    events: [{
      event_id: 'bug-1', kind: 'bug_fix', actor_id: 'agent-b', counterparty_id: 'bounty-poster',
      counterparty_owner: DISTINCT_STRONG, bug_origin: { introduced_by: 'actor' },
      receipt: settled('r-bug-1', 'bug-1'), counterparty_reported_outcome: 'accepted',
      confirmation: { by: 'known_answer', verdict: 'pass' },
    }],
    subject: 'bug-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'ZERO', credibility: 'ZERO',
      credibility_decided_by: 'SELF_CREATED_BUG', reasons_include: ['SELF_CREATED_BUG', 'OUTCOME_CONFIRMED_INDEPENDENT'],
    },
  },
  {
    name: 'evidence_laundering',
    kind: 'threat',
    story: 'One real receipt, bound to one genuine trade, is cited by two more events.',
    events: [
      { event_id: 'laund-0', kind: 'trade', actor_id: 'agent-l', counterparty_id: 'agent-m', counterparty_owner: DISTINCT_STRONG,
        receipt: settled('r-laund', 'laund-0'), counterparty_reported_outcome: 'accepted' },
      { event_id: 'laund-1', kind: 'trade', actor_id: 'agent-l', counterparty_id: 'agent-m', counterparty_owner: DISTINCT_STRONG,
        receipt: settled('r-laund', 'laund-0'), counterparty_reported_outcome: 'accepted' },
      { event_id: 'laund-2', kind: 'trade', actor_id: 'agent-l', counterparty_id: 'agent-m', counterparty_owner: DISTINCT_STRONG,
        receipt: settled('r-laund', 'laund-0'), counterparty_reported_outcome: 'accepted' },
    ],
    subject: 'laund-2',
    expect: {
      tier: 'SELF_ATTESTED', independence: 'VERIFIED_INDEPENDENT', operational: 'ZERO', credibility: 'ZERO',
      credibility_decided_by: 'RECEIPT_BOUND_TO_OTHER_EVENT', reasons_include: ['RECEIPT_BOUND_TO_OTHER_EVENT'],
    },
  },
  {
    name: 'evidence_laundering_unbound',
    kind: 'threat',
    story: 'An unbound receipt cited by two events: neither may use it.',
    events: [
      { event_id: 'ub-1', kind: 'trade', actor_id: 'agent-u', counterparty_id: 'agent-x', counterparty_owner: DISTINCT_STRONG,
        receipt: settled('r-unbound', null), counterparty_reported_outcome: 'accepted' },
      { event_id: 'ub-2', kind: 'trade', actor_id: 'agent-u', counterparty_id: 'agent-x', counterparty_owner: DISTINCT_STRONG,
        receipt: settled('r-unbound', null), counterparty_reported_outcome: 'accepted' },
    ],
    subject: 'ub-1',
    expect: {
      tier: 'SELF_ATTESTED', independence: 'VERIFIED_INDEPENDENT', operational: 'ZERO', credibility: 'ZERO',
      credibility_decided_by: 'RECEIPT_CITED_BY_MANY', reasons_include: ['RECEIPT_CITED_BY_MANY'],
    },
  },
  {
    name: 'confidence_laundering',
    kind: 'threat',
    story: 'The agent picks only tasks 97% of agents pass; a real buyer pays and a known-answer check confirms.',
    events: [{
      event_id: 'easy-1', kind: 'trade', actor_id: 'agent-e', counterparty_id: 'agent-f', counterparty_owner: DISTINCT_STRONG,
      receipt: settled('r-easy-1', 'easy-1'), counterparty_reported_outcome: 'accepted',
      confirmation: { by: 'known_answer', verdict: 'pass' }, selection: { chosen_by: 'actor', baseline_pass_rate: 0.97 },
    }],
    subject: 'easy-1',
    expect: {
      tier: 'OWNER_DISTINCT_OBSERVED', independence: 'VERIFIED_INDEPENDENT', operational: 'COUNTS', credibility: 'ZERO',
      credibility_decided_by: 'EASY_OUTCOME_SELF_SELECTED', reasons_include: ['OUTCOME_CONFIRMED_INDEPENDENT', 'EASY_OUTCOME_SELF_SELECTED'],
    },
  },
  {
    name: 'parent_child_lineage',
    kind: 'threat',
    story: 'An agent spawns a child (no ownership binding yet) and sells to it.',
    events: [{
      event_id: 'lin-1', kind: 'trade', actor_id: 'agent-parent', counterparty_id: 'agent-child', counterparty_owner: UNKNOWN,
      lineage: { counterparty_is_parent_or_child_of_actor: true },
      receipt: settled('r-lin-1', 'lin-1'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'lin-1',
    expect: {
      tier: 'SAME_OWNER_VERIFIED', independence: 'AFFILIATED', operational: 'COUNTS', credibility: 'ZERO',
      credibility_decided_by: 'LINEAGE_PARENT_CHILD', reasons_include: ['OWNER_UNKNOWN', 'LINEAGE_PARENT_CHILD'],
    },
  },

  // ── honest ─────────────────────────────────────────────────────────────────────────────────
  {
    name: 'loyal_repeat_customer',
    kind: 'honest',
    story: 'A signed, distinct owner buys from the same provider for the 15th time.',
    events: [{
      event_id: 'loyal-15', kind: 'trade', actor_id: 'agent-prov', counterparty_id: 'agent-loyal', counterparty_owner: DISTINCT_STRONG,
      receipt: settled('r-loyal-15', 'loyal-15'), counterparty_reported_outcome: 'accepted',
      repeat: { prior_settled_with_counterparty: 14 }, selection: { chosen_by: 'assigner', baseline_pass_rate: 0.6 },
    }],
    subject: 'loyal-15',
    expect: {
      tier: 'OWNER_DISTINCT_OBSERVED', independence: 'VERIFIED_INDEPENDENT', operational: 'COUNTS', credibility: 'COUNTS',
      credibility_decided_by: 'OWNER_DISTINCT_STRONG', reasons_include: ['OWNER_DISTINCT_STRONG', 'REPEAT_COUNTERPARTY_NOT_PENALIZED'],
    },
  },
  {
    name: 'small_unknown_new_owner',
    kind: 'honest',
    story: 'A newcomer with no ownership binding (2FA on) delivers a settled, accepted job.',
    events: [{
      event_id: 'new-1', kind: 'trade', actor_id: 'agent-new', counterparty_id: 'agent-buyer', counterparty_owner: UNKNOWN,
      account_control: { actor_two_factor: true },
      receipt: settled('r-new-1', 'new-1'), counterparty_reported_outcome: 'accepted',
    }],
    subject: 'new-1',
    expect: {
      tier: 'COUNTERPARTY_REPORTED', independence: 'UNKNOWN', operational: 'COUNTS', credibility: 'UNKNOWN',
      credibility_decided_by: 'OWNER_UNKNOWN', reasons_include: ['OWNER_UNKNOWN', 'TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP'],
    },
  },
  {
    name: 'unrelated_counterparty_independent_acceptance',
    kind: 'honest',
    story: 'An unrelated buyer; an unpaid adjudicator of a third owner accepts the delivery.',
    events: [{
      event_id: 'indep-1', kind: 'trade', actor_id: 'agent-s', counterparty_id: 'agent-t', counterparty_owner: DISTINCT_STRONG,
      receipt: settled('r-indep-1', 'indep-1'), counterparty_reported_outcome: 'accepted',
      confirmation: { by: 'adjudicator', confirmer_owner: DISTINCT_STRONG, paid_by_actor: false, reciprocal_with_actor: false, verdict: 'pass' },
      selection: { chosen_by: 'assigner', baseline_pass_rate: 0.55 },
    }],
    subject: 'indep-1',
    expect: {
      tier: 'INDEPENDENT_OUTCOME_CONFIRMED', independence: 'VERIFIED_INDEPENDENT', operational: 'COUNTS', credibility: 'COUNTS',
      credibility_decided_by: 'OUTCOME_CONFIRMED_INDEPENDENT', reasons_include: ['OWNER_DISTINCT_STRONG', 'OUTCOME_CONFIRMED_INDEPENDENT'],
    },
  },
  {
    name: 'reproduced_ecosystem_improvement',
    kind: 'honest',
    story: 'An agent fixes a shared-library bug someone else introduced; two independent owners reproduce the fix.',
    events: [{
      event_id: 'imp-1', kind: 'improvement', actor_id: 'agent-i', counterparty_id: null, counterparty_owner: null,
      bug_origin: { introduced_by: DISTINCT_STRONG }, receipt: null,
      reproductions: [
        { by_id: 'agent-r1', reproducer_owner: DISTINCT_STRONG, reproducer_owner_key: 'owner-r1', reproduced: true },
        { by_id: 'agent-r2', reproducer_owner: DISTINCT_STRONG, reproducer_owner_key: 'owner-r2', reproduced: true },
      ],
    }],
    subject: 'imp-1',
    expect: {
      tier: 'REPRODUCED_ECOSYSTEM_IMPROVEMENT', independence: 'VERIFIED_INDEPENDENT', operational: 'COUNTS', credibility: 'COUNTS',
      credibility_decided_by: 'REPRODUCED_BY_INDEPENDENT_OWNERS', reasons_include: ['NO_RECEIPT_SELF_ATTESTED', 'REPRODUCED_BY_INDEPENDENT_OWNERS'],
    },
  },
];
