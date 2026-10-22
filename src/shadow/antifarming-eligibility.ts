/**
 * antifarming-eligibility.ts — would this event count toward reputation, on which dimension, and
 * why? SHADOW ONLY. An explainable record per event. It moves no score.
 *
 * WHY. Public reputation systems get farmed (the 2026 ERC-8004 study put Sybil-like reviewers at
 * 59–91% across chains), and on 2026-10-22 none of the 34 trades settled here in 30 days was
 * PROVEN to be between different owners. The goal is not "impossible to game". It is to make
 * unverified and affiliated activity worth nothing for INDEPENDENT credibility, while keeping
 * genuine repeat-customer reliability and never punishing a small, unknown, honest participant.
 *
 * WHAT IT IS NOT. Not a scorer. Nothing in the live path imports this file
 * (tests/antifarming-eligibility.test.ts walks every live entrypoint's import graph to prove it),
 * there is no flag that turns it on, and it has no I/O: no database, no network, no environment.
 * The record carries `shadow: true` and `writes_repid: false` as literal types. Counting it toward
 * RepID would be a RepID change, which is MAJOR and Sean's alone.
 *
 * TWO DIMENSIONS, never collapsed into one number:
 *   operational_reliability   did the agent deliver what it was paid to deliver? Same-owner work
 *                             MAY count here: an agent that reliably serves its own fleet is
 *                             reliable, and that is worth knowing.
 *   independent_credibility   does an independent party's outcome vouch for it? Same-owner (or
 *                             any affiliated) activity adds ZERO here.
 * Each dimension is COUNTS (1 unit), ZERO (0, with positive evidence why), or UNKNOWN (0, because
 * the evidence is missing). Units are an eligibility COUNT, not a delta and never negative: this
 * module cannot punish anyone, only decline to credit.
 *
 * THREE ANSWERS ABOUT INDEPENDENCE, kept apart (`independence`):
 *   VERIFIED_INDEPENDENT  strong owner-distinct evidence, or an independent confirmer, and no
 *                         affiliation signal.
 *   AFFILIATED            positive evidence of common control or no economic substance.
 *   UNKNOWN               neither. UNKNOWN is not VERIFIED and is not AFFILIATED. A two-wallet
 *                         Sybil with no funding trace is indistinguishable from an honest
 *                         newcomer, so both read UNKNOWN: not credited, not punished.
 *
 * 2FA is ACCOUNT-CONTROL evidence (whoever holds the account also holds the second factor). It
 * says nothing about who BENEFICIALLY owns the account; one person can enable 2FA on fifty
 * wallets. It is recorded as a reason and never read as ownership evidence.
 *
 * OWNER RELATION IS AN INPUT. Callers compute it with `ownerRelation`
 * (src/services/owner-distinct-shadow.ts) over `resolveOwner`'s claims. Importing that here would
 * pull the database client in at load time, so only its TYPES are imported (erased at compile).
 *
 * The two anchors below (EASY_BASELINE_PASS_RATE, MIN_INDEPENDENT_REPRODUCTIONS) are documented
 * principle-level thresholds for this shadow record, not RepID tuning and not the scoring formula.
 */
import type { OwnerEvidence, OwnerRelation } from '../services/owner-distinct-shadow';

export const ELIGIBILITY_SCHEMA = 'antifarming-eligibility/0' as const;

/** A self-chosen task whose prior pass rate is at or above this tells us nothing about skill. */
export const EASY_BASELINE_PASS_RATE = 0.9;
/** An improvement is ecosystem-level only when this many independent owners reproduce it. */
export const MIN_INDEPENDENT_REPRODUCTIONS = 2;

/** Evidence tiers, weakest first. The tier is the strongest one whose evidence is ADMISSIBLE. */
export const EVIDENCE_TIERS = [
  'SELF_ATTESTED',
  'SAME_OWNER_VERIFIED',
  'COUNTERPARTY_REPORTED',
  'OWNER_DISTINCT_OBSERVED',
  'INDEPENDENT_OUTCOME_CONFIRMED',
  'REPRODUCED_ECOSYSTEM_IMPROVEMENT',
] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** Every reason the record can give, with the sentence a human reads. Stable names. */
export const REASONS = {
  NO_RECEIPT_SELF_ATTESTED: 'No receipt: the only evidence is the actor\'s own claim.',
  RECEIPT_NOT_SERVER_SETTLED: 'The cited receipt was not settled by the engine; a caller assertion is not evidence.',
  RECEIPT_SERVER_SETTLED: 'A receipt the engine itself settled backs this event.',
  RECEIPT_UNBOUND: 'The receipt is not bound to one event; it is admissible only while nothing else cites it.',
  RECEIPT_BOUND_TO_OTHER_EVENT: 'Evidence laundering: the receipt was issued for a different event.',
  RECEIPT_CITED_BY_MANY: 'Evidence laundering: an unbound receipt is cited by more than one event, so no event may use it.',
  COUNTERPARTY_ACCEPTED: 'The counterparty reported the delivery accepted.',
  COUNTERPARTY_REJECTED: 'The counterparty reported the delivery rejected.',
  OWNER_SAME_STRONG: 'Signed ownership evidence ties both parties to one owner.',
  OWNER_SAME_ADMINISTRATIVE: 'An unsigned administrative record (builder id) ties both parties to one owner.',
  OWNER_DISTINCT_STRONG: 'Signed ownership evidence shows two different owners.',
  OWNER_DISTINCT_ADMINISTRATIVE_ONLY: 'The owners differ only on unsigned administrative records; that is not proof of independence.',
  OWNER_UNKNOWN: 'Ownership could not be established either way. Not credited, not penalized.',
  TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP: '2FA shows control of an account, not who owns it. Recorded, not used as ownership evidence.',
  COUNTERPARTY_FUNDED_BY_ACTOR: 'The counterparty\'s funds or gas came from the actor\'s owner.',
  CIRCULAR_FUNDS: 'The payment returned to the payer\'s owner: no economic substance.',
  LINEAGE_PARENT_CHILD: 'One party spawned the other (parent/child lineage).',
  SELF_CREATED_BUG: 'The actor, or its owner, introduced the bug it is now credited for fixing.',
  CONFIRMER_PAID_BY_ACTOR: 'The confirmer was paid by the actor being judged.',
  CONFIRMER_RECIPROCAL_RING: 'The confirmer and the actor confirm each other\'s work (a ring).',
  CONFIRMER_SAME_OWNER: 'The confirmer shares an owner with the actor.',
  CONFIRMER_INDEPENDENCE_UNKNOWN: 'The confirmer\'s independence from the actor is not established; its confirmation is not used.',
  OUTCOME_CONFIRMED_INDEPENDENT: 'A party independent of the actor confirmed the outcome.',
  OUTCOME_CONFIRMED_FAIL: 'An independent confirmation found the outcome failed.',
  EASY_OUTCOME_SELF_SELECTED: 'Confidence laundering: the actor picked a task almost everyone passes, so success says little.',
  REPEAT_COUNTERPARTY_NOT_PENALIZED: 'A repeat customer. Repetition alone is not penalized.',
  REPRODUCED_BY_INDEPENDENT_OWNERS: 'Independent owners reproduced the improvement.',
  REPRODUCTION_INSUFFICIENT: 'Too few independent owners reproduced the improvement.',
} as const;
export type ReasonCode = keyof typeof REASONS;

/** Reasons that are positive evidence of affiliation or of no economic substance. */
const AFFILIATION: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'OWNER_SAME_STRONG',
  'OWNER_SAME_ADMINISTRATIVE',
  'COUNTERPARTY_FUNDED_BY_ACTOR',
  'CIRCULAR_FUNDS',
  'LINEAGE_PARENT_CHILD',
  'SELF_CREATED_BUG',
  'CONFIRMER_PAID_BY_ACTOR',
  'CONFIRMER_RECIPROCAL_RING',
  'CONFIRMER_SAME_OWNER',
]);

const LAUNDERED: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['RECEIPT_BOUND_TO_OTHER_EVENT', 'RECEIPT_CITED_BY_MANY']);

/** Exactly what `ownerRelation(a, b)` returns. */
export interface OwnerLink {
  relation: OwnerRelation;
  evidence: OwnerEvidence;
}

export interface EligibilityEvent {
  event_id: string;
  kind: 'trade' | 'validation' | 'bug_fix' | 'improvement';
  actor_id: string;
  counterparty_id: string | null;
  /** ownerRelation(actor, counterparty); null when there is no counterparty. */
  counterparty_owner: OwnerLink | null;
  /** Recorded; NEVER ownership evidence. */
  account_control?: { actor_two_factor?: boolean; counterparty_two_factor?: boolean };
  /** The receipt the event cites. null = the actor's word only. */
  receipt: null | {
    receipt_id: string;
    /** The engine settled it, not a caller assertion. */
    server_settled: boolean;
    /** One-use binding: the event this receipt was issued for. null = unbound. */
    bound_event_id: string | null;
  };
  counterparty_reported_outcome?: 'accepted' | 'rejected' | null;
  /** A confirmation from someone other than the counterparty. */
  confirmation?: null | {
    by: 'holdout' | 'known_answer' | 'adjudicator' | 'validator_panel';
    /** ownerRelation(actor, confirmer). Required for adjudicator / validator_panel; holdout and known_answer are engine-run. */
    confirmer_owner?: OwnerLink;
    paid_by_actor?: boolean;
    reciprocal_with_actor?: boolean;
    verdict: 'pass' | 'fail';
  };
  funding?: {
    /** Where the counterparty's payment or gas came from. */
    counterparty_funded_by?: 'actor_owner' | 'independent' | 'unknown';
    /** The payment came back, within the window, to the payer's owner. */
    payment_returned_to_payer_owner?: boolean;
  };
  lineage?: { counterparty_is_parent_or_child_of_actor?: boolean };
  /** bug_fix only: who introduced the bug ('actor', or ownerRelation(actor, introducer)). */
  bug_origin?: { introduced_by: 'actor' | OwnerLink };
  /** Who chose the task, and its pass rate across everyone before this attempt (null = not known). */
  selection?: { chosen_by: 'actor' | 'assigner' | 'holdout'; baseline_pass_rate: number | null };
  /** improvement only. `reproducer_owner_key` is the reproducer's resolved owner key (null = unknown). */
  reproductions?: Array<{ by_id: string; reproducer_owner: OwnerLink; reproducer_owner_key: string | null; reproduced: boolean }>;
  repeat?: { prior_settled_with_counterparty: number };
}

export type DimensionStatus = 'COUNTS' | 'ZERO' | 'UNKNOWN';
export interface Dimension {
  status: DimensionStatus;
  /** An eligibility count, not a delta. 1 only when status is COUNTS. Never negative. */
  units: 0 | 1;
  decided_by: ReasonCode;
}

export type Independence = 'VERIFIED_INDEPENDENT' | 'AFFILIATED' | 'UNKNOWN';

export interface EligibilityRecord {
  schema: typeof ELIGIBILITY_SCHEMA;
  event_id: string;
  shadow: true;
  writes_repid: false;
  tier: EvidenceTier;
  independence: Independence;
  operational_reliability: Dimension;
  independent_credibility: Dimension;
  /** Every reason that fired, in evaluation order, once each. */
  reasons: ReasonCode[];
}

/** Context only a batch can know: which events cite which receipt, in input order. */
export interface EligibilityContext {
  receiptCitations: ReadonlyMap<string, readonly string[]>;
}

const strongDistinct = (o: OwnerLink | null | undefined): boolean => o?.relation === 'distinct' && o.evidence === 'strong';
const dim = (status: DimensionStatus, decided_by: ReasonCode): Dimension =>
  Object.freeze({ status, units: status === 'COUNTS' ? 1 : 0, decided_by }) as Dimension;

/** PURE. One event in, one explainable record out. */
export function evaluateEligibility(event: EligibilityEvent, ctx: EligibilityContext = { receiptCitations: new Map() }): EligibilityRecord {
  const reasons: ReasonCode[] = [];
  const say = (r: ReasonCode) => { if (!reasons.includes(r)) reasons.push(r); };

  // 0. Account control. Recorded, then ignored.
  if (event.account_control?.actor_two_factor || event.account_control?.counterparty_two_factor) say('TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP');

  // 1. Is the receipt admissible, and for THIS event?
  let receiptOk = false;
  const r = event.receipt;
  if (!r) say('NO_RECEIPT_SELF_ATTESTED');
  else if (!r.server_settled) say('RECEIPT_NOT_SERVER_SETTLED');
  else if (r.bound_event_id !== null && r.bound_event_id !== event.event_id) say('RECEIPT_BOUND_TO_OTHER_EVENT');
  else if (r.bound_event_id === null && new Set(ctx.receiptCitations.get(r.receipt_id) ?? [event.event_id]).size > 1) say('RECEIPT_CITED_BY_MANY');
  else {
    receiptOk = true;
    say('RECEIPT_SERVER_SETTLED');
    if (r.bound_event_id === null) say('RECEIPT_UNBOUND');
  }

  const cpReport = event.counterparty_reported_outcome ?? null;
  if (cpReport === 'accepted') say('COUNTERPARTY_ACCEPTED');
  if (cpReport === 'rejected') say('COUNTERPARTY_REJECTED');

  // 2. Owner relation to the counterparty.
  const owner = event.counterparty_owner;
  if (owner?.relation === 'same') say(owner.evidence === 'strong' ? 'OWNER_SAME_STRONG' : 'OWNER_SAME_ADMINISTRATIVE');
  else if (owner?.relation === 'distinct') say(owner.evidence === 'strong' ? 'OWNER_DISTINCT_STRONG' : 'OWNER_DISTINCT_ADMINISTRATIVE_ONLY');
  else if (event.counterparty_id !== null) say('OWNER_UNKNOWN');

  // 3. Affiliation that ownership records do not show.
  if (event.funding?.counterparty_funded_by === 'actor_owner') say('COUNTERPARTY_FUNDED_BY_ACTOR');
  if (event.funding?.payment_returned_to_payer_owner) say('CIRCULAR_FUNDS');
  if (event.lineage?.counterparty_is_parent_or_child_of_actor) say('LINEAGE_PARENT_CHILD');
  const origin = event.bug_origin?.introduced_by;
  if (event.kind === 'bug_fix' && (origin === 'actor' || (origin && origin.relation === 'same'))) say('SELF_CREATED_BUG');

  // 4. Is the confirmation independent of the actor?
  let independentPass = false;
  let independentFail = false;
  const c = event.confirmation;
  if (c) {
    let independent = c.by === 'holdout' || c.by === 'known_answer';
    if (!independent) {
      if (c.paid_by_actor) say('CONFIRMER_PAID_BY_ACTOR');
      if (c.reciprocal_with_actor) say('CONFIRMER_RECIPROCAL_RING');
      if (c.confirmer_owner?.relation === 'same') say('CONFIRMER_SAME_OWNER');
      independent = strongDistinct(c.confirmer_owner) && !c.paid_by_actor && !c.reciprocal_with_actor;
      if (!independent && !c.paid_by_actor && !c.reciprocal_with_actor && c.confirmer_owner?.relation !== 'same') say('CONFIRMER_INDEPENDENCE_UNKNOWN');
    }
    if (independent && c.verdict === 'pass') { independentPass = true; say('OUTCOME_CONFIRMED_INDEPENDENT'); }
    if (independent && c.verdict === 'fail') { independentFail = true; say('OUTCOME_CONFIRMED_FAIL'); }
  }

  // 5. Confidence laundering: a self-chosen task that almost everyone passes.
  const sel = event.selection;
  const easySelfSelected = sel?.chosen_by === 'actor' && sel.baseline_pass_rate !== null && sel.baseline_pass_rate >= EASY_BASELINE_PASS_RATE;
  if (easySelfSelected) say('EASY_OUTCOME_SELF_SELECTED');

  // 6. Ecosystem improvement: reproduced by enough distinct, independent owners.
  let reproduced = false;
  if (event.kind === 'improvement') {
    const keys = new Set(
      (event.reproductions ?? [])
        .filter((x) => x.reproduced && strongDistinct(x.reproducer_owner) && x.reproducer_owner_key !== null)
        .map((x) => String(x.reproducer_owner_key).toLowerCase()),
    );
    reproduced = keys.size >= MIN_INDEPENDENT_REPRODUCTIONS;
    say(reproduced ? 'REPRODUCED_BY_INDEPENDENT_OWNERS' : 'REPRODUCTION_INSUFFICIENT');
  }

  if (event.repeat && event.repeat.prior_settled_with_counterparty > 0) say('REPEAT_COUNTERPARTY_NOT_PENALIZED');

  const affiliation = reasons.find((x) => AFFILIATION.has(x));
  const laundered = reasons.find((x) => LAUNDERED.has(x));
  const verifiedArtifact = receiptOk || independentPass || independentFail || reproduced;

  // Tier: the strongest tier whose evidence is admissible. Affiliated evidence counts as same-owner.
  let tier: EvidenceTier;
  if (affiliation) tier = verifiedArtifact ? 'SAME_OWNER_VERIFIED' : 'SELF_ATTESTED';
  else if (reproduced) tier = 'REPRODUCED_ECOSYSTEM_IMPROVEMENT';
  else if (independentPass && !easySelfSelected) tier = 'INDEPENDENT_OUTCOME_CONFIRMED';
  else if (receiptOk && strongDistinct(owner)) tier = 'OWNER_DISTINCT_OBSERVED';
  else if (receiptOk && event.counterparty_id !== null) tier = 'COUNTERPARTY_REPORTED';
  else tier = 'SELF_ATTESTED';

  const independence: Independence = affiliation
    ? 'AFFILIATED'
    : strongDistinct(owner) || independentPass || independentFail || reproduced
      ? 'VERIFIED_INDEPENDENT'
      : 'UNKNOWN';

  // Operational reliability: same owner MAY count; no substance, laundering or a self-made bug may not.
  let operational: Dimension;
  if (laundered) operational = dim('ZERO', laundered);
  else if (reasons.includes('CIRCULAR_FUNDS')) operational = dim('ZERO', 'CIRCULAR_FUNDS');
  else if (reasons.includes('SELF_CREATED_BUG')) operational = dim('ZERO', 'SELF_CREATED_BUG');
  else if (cpReport === 'rejected') operational = dim('ZERO', 'COUNTERPARTY_REJECTED');
  else if (independentFail) operational = dim('ZERO', 'OUTCOME_CONFIRMED_FAIL');
  else if (reproduced) operational = dim('COUNTS', 'REPRODUCED_BY_INDEPENDENT_OWNERS');
  else if (independentPass) operational = dim('COUNTS', 'OUTCOME_CONFIRMED_INDEPENDENT');
  else if (receiptOk) operational = dim('COUNTS', 'RECEIPT_SERVER_SETTLED');
  else operational = dim('UNKNOWN', r ? 'RECEIPT_NOT_SERVER_SETTLED' : 'NO_RECEIPT_SELF_ATTESTED');

  // Independent credibility: affiliated activity adds ZERO; missing evidence is UNKNOWN, not zero-with-blame.
  let credibility: Dimension;
  if (affiliation) credibility = dim('ZERO', affiliation);
  else if (laundered) credibility = dim('ZERO', laundered);
  else if (easySelfSelected) credibility = dim('ZERO', 'EASY_OUTCOME_SELF_SELECTED');
  else if (cpReport === 'rejected') credibility = dim('ZERO', 'COUNTERPARTY_REJECTED');
  else if (independentFail) credibility = dim('ZERO', 'OUTCOME_CONFIRMED_FAIL');
  else if (tier === 'REPRODUCED_ECOSYSTEM_IMPROVEMENT') credibility = dim('COUNTS', 'REPRODUCED_BY_INDEPENDENT_OWNERS');
  else if (tier === 'INDEPENDENT_OUTCOME_CONFIRMED') credibility = dim('COUNTS', 'OUTCOME_CONFIRMED_INDEPENDENT');
  else if (tier === 'OWNER_DISTINCT_OBSERVED') credibility = dim('COUNTS', 'OWNER_DISTINCT_STRONG');
  else if (reasons.includes('OWNER_DISTINCT_ADMINISTRATIVE_ONLY')) credibility = dim('UNKNOWN', 'OWNER_DISTINCT_ADMINISTRATIVE_ONLY');
  else if (reasons.includes('OWNER_UNKNOWN')) credibility = dim('UNKNOWN', 'OWNER_UNKNOWN');
  else if (reasons.includes('REPRODUCTION_INSUFFICIENT')) credibility = dim('UNKNOWN', 'REPRODUCTION_INSUFFICIENT');
  else credibility = dim('UNKNOWN', r ? (receiptOk ? 'RECEIPT_SERVER_SETTLED' : 'RECEIPT_NOT_SERVER_SETTLED') : 'NO_RECEIPT_SELF_ATTESTED');

  return Object.freeze({
    schema: ELIGIBILITY_SCHEMA,
    event_id: event.event_id,
    shadow: true,
    writes_repid: false,
    tier,
    independence,
    operational_reliability: operational,
    independent_credibility: credibility,
    reasons: Object.freeze([...reasons]) as ReasonCode[],
  });
}

/** PURE. Evaluate a batch, so a receipt cited by several events is seen as such. */
export function evaluateEligibilityBatch(events: readonly EligibilityEvent[]): EligibilityRecord[] {
  const receiptCitations = new Map<string, string[]>();
  for (const e of events) {
    if (!e.receipt) continue;
    const list = receiptCitations.get(e.receipt.receipt_id) ?? [];
    list.push(e.event_id);
    receiptCitations.set(e.receipt.receipt_id, list);
  }
  return events.map((e) => evaluateEligibility(e, { receiptCitations }));
}

/** PURE. A markdown table for a report or a terminal. */
export function renderEligibilityTable(rows: ReadonlyArray<{ name: string; record: EligibilityRecord }>): string {
  const head = '| case | tier | independence | operational | credibility | reasons |\n|---|---|---|---|---|---|';
  const body = rows.map(({ name, record: x }) =>
    `| ${name} | ${x.tier} | ${x.independence} | ${x.operational_reliability.status} (${x.operational_reliability.decided_by}) | ` +
    `${x.independent_credibility.status} (${x.independent_credibility.decided_by}) | ${x.reasons.join(', ')} |`,
  );
  return [head, ...body].join('\n');
}
