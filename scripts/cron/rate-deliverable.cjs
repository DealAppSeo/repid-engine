/**
 * Rate a verification deliverable against the acceptance criteria that
 * `mint-attestation.mjs` writes into its work statement.
 *
 * THIS LIVES IN ITS OWN FILE SO IT CAN BE TESTED WITHOUT RUNNING THE CRON.
 * `mint-attestation.mjs` calls `main()` at module scope, creates a Supabase
 * client, and `process.exit(1)`s on missing env — importing it from a test
 * would mint API keys and escrow real testnet USDC. A function that decides
 * whether money is released has to be testable, so it does not live there.
 *
 * Pure: no imports, no I/O, no side effects.
 *
 * CommonJS on purpose. The cron is ESM and imports it fine (Node resolves the
 * named export through cjs-module-lexer), and jest can `require` it directly —
 * so this is testable WITHOUT adding an .mjs transform to a jest config that
 * 500+ suites depend on. The alternative was config surgery on shared
 * infrastructure to test one pure function.
 */

/**
 * Checked against the REAL payload shape, measured 2026-09-09:
 *   {verdict, score, confidence, validators, validator_count,
 *    attempted_validator_count, patent_marker, verified_at, contract_id}
 *
 * Every `met` is derived from that object. None is hardcoded true. This is the
 * buyer's half of the rule the route enforces on the provider: nobody signs
 * their own cheque, and an unread deliverable is never an accepted one.
 *
 * Returns the `criterion_ratings` array `POST /contracts/:id/satisfy` expects.
 * A criterion that is not met is reported as not met — the buyer declining to
 * pay for work that missed the spec is the system working, not a bug to route
 * around.
 */
function rateDeliverable(result) {
  const r = result && typeof result === 'object' ? result : {};
  const verdict = String(r.verdict ?? '').toUpperCase();

  // n=1: an explicit verdict, not a hedge. PASS and FAIL both satisfy this —
  // the criterion asks for a decision, not for a favourable one.
  const explicitVerdict = verdict === 'PASS' || verdict === 'FAIL';

  // n=2: both counts present, and at least one validator actually answered.
  // `answered === 0` is NOT_CHECKED wearing a verdict's clothes — the exact
  // failure that cost twelve days in August — so it reads as NOT met.
  const answered = Number(r.validator_count);
  const attempted = Number(r.attempted_validator_count);
  const countsReported =
    Number.isFinite(answered) && Number.isFinite(attempted) && answered > 0;

  return [
    { n: 1, met: explicitVerdict },
    { n: 2, met: countsReported },
  ];
}

module.exports = { rateDeliverable };
