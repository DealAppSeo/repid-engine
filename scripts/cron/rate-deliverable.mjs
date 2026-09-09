//
// rate-deliverable.mjs — how the living-proof buyer rates what it was sent.
//
// EXTRACTED SO IT CAN BE TESTED. `mint-attestation.mjs` self-executes on import
// (`main()` at the bottom), so nothing inside it can be exercised without
// running a real contract against real testnet USDC. This module is pure: no
// network, no database, no side effects — the rating decision on its own, which
// is the part that decides whether money moves.
//
// WHY THIS EXISTS AT ALL. The script used to send `{satisfaction_score: 1}`: a
// flat assertion that the deliverable was perfect, made without looking at it.
// That is the "recorded as if it had been checked" shape this codebase keeps
// removing, sitting on the one path that moves real money. It also stopped
// working — once contracts became work-statement-bound, `deriveSatisfyScore`
// began requiring `criterion_ratings` and rejecting the scalar outright, so five
// consecutive daily runs left USDC authorized and uncaptured.
//
// The criteria are rated AGAINST THE DELIVERED RESULT. Nothing here hardcodes an
// outcome: if the verification handler starts including the chain id, criterion 2
// becomes met on its own with no edit to this file.

/** The claim the living-proof run buys a verification of. */
export const CHAIN_ID = '84532';
export const CLAIM_TEXT = `The Base Sepolia chain id is ${CHAIN_ID}.`;

/**
 * The acceptance criteria sent at contract creation. Exported so the contract
 * and the rating cannot drift apart — they are the same list, and a criterion
 * added here without a rating below would be visible immediately.
 */
export const ACCEPTANCE_CRITERIA = [
  { n: 1, text: 'The verdict states explicitly whether the claim is true or false, without hedging.' },
  { n: 2, text: 'The verdict names the chain id it verified against, so the check is reproducible.' },
];

/**
 * Rate a delivered result against the criteria above.
 *
 * Returns one `{n, met}` per criterion, in the same order. `met` is decided by
 * looking at the deliverable, never by assumption.
 *
 * Callers must NOT invoke this on an unread or missing deliverable and treat the
 * answer as a verdict: rating nothing gives 0 met, which VOIDS the payment, and
 * voiding a legitimate payment because a read failed is as wrong as paying for
 * work nobody saw. `mint-attestation.mjs` waits and retries instead.
 */
export function rateDeliverable(result) {
  // Serialised once so a criterion may look anywhere in the deliverable rather
  // than only at a field name we happened to guess.
  const blob = JSON.stringify(result ?? {});
  const verdict = String(result?.verdict ?? '').toUpperCase();
  return [
    // 1. An explicit, unhedged verdict. PASS/FAIL is exactly that. Anything
    //    absent, empty or equivocal ("probably", "likely") is not — and must not
    //    be, or the criterion would be satisfied by the hedging it forbids.
    { n: 1, met: verdict === 'PASS' || verdict === 'FAIL' },
    // 2. The chain id must actually appear, so a reader can reproduce the check.
    { n: 2, met: blob.includes(CHAIN_ID) },
  ];
}

/** round(met/total, 4) — the same derivation the database applies. */
export function scoreOf(ratings) {
  if (!Array.isArray(ratings) || ratings.length === 0) return 0;
  const met = ratings.filter((r) => r && r.met === true).length;
  return Number((met / ratings.length).toFixed(4));
}

/**
 * What the buyer should do about a contract in a given status, BEFORE any
 * rating happens. Returned as a word rather than a boolean because there are
 * four answers here and collapsing them is how the caller went wrong:
 *
 *   'settled'  — done, and the money already moved. Reachable when satisfy
 *                succeeded but its response did not say so in the shape the
 *                caller read. Re-polling it to a timeout reports a FAILURE on a
 *                contract that SUCCEEDED, which sends the next reader looking
 *                for stranded funds that are not stranded.
 *   'rate'      — delivered and awaiting the buyer's rating. The only status
 *                that may spend money.
 *   'terminal'  — disputed / resolved / cancelled. Waiting cannot reach
 *                'fulfilled' from here, so calling it a delivery timeout names
 *                the wrong cause.
 *   'wait'      — everything else, INCLUDING a status this script does not
 *                recognise. An unknown status is not a licence to rate: waiting
 *                spends nothing and fails loudly at the caller's timeout, which
 *                is the safe direction to be wrong in.
 */
export function classifyContractStatus(status) {
  if (status === 'settled') return 'settled';
  if (status === 'fulfilled') return 'rate';
  if (status === 'disputed' || status === 'resolved' || status === 'cancelled') return 'terminal';
  return 'wait';
}

/**
 * What satisfy's answer MEANS. Extracted for the same reason as the rating
 * itself: this decision was written wrong the first time, and no test could
 * reach it while it lived inside a script that self-executes against real money.
 *
 * The first version checked `status === 200 && body.voided`, which the route
 * NEVER sends — a rejected deliverable comes back **409 `deliverable_rejected`**.
 * So a voided authorization would have fallen through to the retry path, polled
 * to the caller's timeout and been reported as a delivery timeout: the wrong
 * cause, on the money path, again. Reading the handler is what settled it.
 *
 * 409 is returned for two OPPOSITE things, which is why this discriminates on
 * `error` and not on the status code:
 *
 *   'settled'  — 200 and the body says settled. The only success.
 *   'voided'   — 409 `deliverable_rejected`: rated below the release gate, the
 *                authorization is void, no funds moved. Terminal BY DESIGN, and
 *                not a failure of this script.
 *   'retry'    — 409 `not_fulfilled` (our read raced the delivery), and any
 *                answer not otherwise named. Costs a sleep, spends nothing.
 *   'reject'   — 400 (the ratings are not what the contract expects), 403 (not
 *                the buyer), 404 (gone). None of these improve with waiting.
 */
export function classifySatisfyResponse(httpStatus, body) {
  const why = body?.error;
  if (httpStatus === 200 && body?.status === 'settled') return 'settled';
  if (httpStatus === 409 && why === 'deliverable_rejected') return 'voided';
  if (httpStatus === 409 && why === 'not_fulfilled') return 'retry';
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404) return 'reject';
  return 'retry';
}
