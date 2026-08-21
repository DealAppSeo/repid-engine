/**
 * The `repid_score_events_event_type_check` whitelist, as read from the live
 * database. Shared by every test that needs to know whether the schema would
 * accept a value, so the list exists once rather than drifting in two copies.
 *
 * **This is a SNAPSHOT, and it is one-directional.** It catches CODE drifting to
 * a value the schema was never known to accept — which is the failure that
 * reaches production as a `23514` on every insert. It cannot catch the SCHEMA
 * drifting away from the code; the constraint is managed outside this repo and
 * nothing here is notified when it changes.
 *
 * **Why this file exists at all.** `SELF_REPORTED_FAILURE` — the event type the
 * whole just-culture mechanism writes — was **not** in this list, and nothing
 * noticed. `repid-confession.ts` wrote its confession-log row, its ledger write
 * failed `23514` every time, and `recordConfession()` returned `ok: true` with
 * the failure demoted to a `warning` field. So an agent confessed and its score
 * did not move: the discount that module sets to `0.4`, and invariant-tests to
 * be strictly between 0 and 1, was **effectively 0 in production** — confession
 * was free, which is exactly the reputation-laundering case its own header names
 * as the reason the discount may never reach zero.
 *
 * Measured 2026-08-21 in a rolled-back transaction, then fixed by adding the
 * value to the constraint. The existing test asserted the event type was
 * *distinct from the detection-shaped ones*; nothing asserted the database would
 * take it. A name is not a channel.
 */

/** Every value the CHECK constraint admitted when last read. */
export const EVENT_TYPE_WHITELIST_SNAPSHOT = Object.freeze([
  'CHALLENGE_WIN', 'CHALLENGE_LOSS', 'CHALLENGE_DRAW', 'EPISTEMIC_VIOLATION',
  'CONSTITUTIONAL_VIOLATION', 'PREDICTION_RESOLVE', 'STAKE', 'GENESIS', 'REFERRAL',
  'PEACEMAKER', 'SELF_MONITOR', 'DECAY', 'DORMANCY_DECAY', 'SALE_DROP',
  'MIRROR_TEST_MODE7', 'CONSTITUTIONAL_PASS', 'CODE_CONTRIBUTION',
  'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER', 'AGENT_TEACHING', 'AUDIT_CONTRIBUTION',
  'CONSTITUTIONAL_AUDIT', 'MCP_TOOL_CALL', 'LATENCY_OPPORTUNITY_LEARNING',
  'BOUNTY_CLAIM', 'BOUNTY_COMPLETE', 'BOUNTY_VERIFY', 'HAL_SCORE_EVENT',
  'PAPER_TRADE_OUTCOME', 'VALIDATION_PASSED', 'VALIDATION_FAILED',
  'VALIDATOR_REWARD', 'VALIDATOR_PENALTY', 'SERVICE_FULFILLED',
  'SERVICE_SATISFIED', 'x402_value_delivered',
  // Added 2026-08-21 — see the header. Without it the just-culture path could not
  // write a single event.
  'SELF_REPORTED_FAILURE',
] as const);

/** The date the snapshot above was read. Quoted in failures so staleness is visible. */
export const EVENT_TYPE_WHITELIST_READ_ON = '2026-08-21';

const asSet: ReadonlySet<string> = new Set(EVENT_TYPE_WHITELIST_SNAPSHOT);

/** Would the schema, as last read, accept this event type? */
export function schemaAcceptsEventType(eventType: string): boolean {
  return asSet.has(eventType);
}
