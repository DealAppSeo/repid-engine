/**
 * WHAT `verdict` MEANS on a service-contract deliverable (service_contracts.result), and the two
 * questions settlement asks of it. One place, because three gates read it (processOne's dispute
 * routing, /satisfy, the release-retry sweep) and they must not drift apart.
 *
 *   PASS          confident, and the claim was judged TRUE
 *   FAIL          confident, and the claim was judged FALSE    (a result carrying `confident: true`)
 *   UNDETERMINED  no confident determination; no truth value is claimed
 *   VETO          cross_validation only: the validators were in Pythagorean-Comma dissonance
 *
 * Until 2026-10-15 the verification handler (P-001) wrote PASS whenever the validators were sure
 * of their own call, in EITHER direction: "The chemical symbol for gold is Pb." got PASS at score 0
 * [V prod: 18 of 158 P-001 PASS rows have score < 0.5, 9 have score 0]. A reader, the buyer's
 * rater and any public surface read PASS as "true". That old meaning now lives in `confident`.
 *
 * Settlement asks whether the provider delivered a confident answer, never whether the buyer's
 * claim was true: a provider that correctly says "false" did the job and is paid as before.
 *
 * LEGACY ROWS have no `confident` key. Their PASS is the old confidence-only bit and their FAIL
 * means "not confident". Both helpers read them exactly as the gates did before this file existed.
 */
type Deliverable = { verdict?: unknown; confident?: unknown } | null | undefined;

const verdictOf = (result: Deliverable): string => String(result?.verdict ?? '').toUpperCase();

/** A confident answer, either way: the buyer's acceptance may release payment for it. */
export function isSoundDeliverable(result: Deliverable): boolean {
  const v = verdictOf(result);
  return v === 'PASS' || (v === 'FAIL' && result?.confident === true);
}

/**
 * Goes to the dispute panel instead of being filed as delivered: a Comma VETO, or a FAIL that
 * does not say it is a confident "false" (cross_validation's FAIL, and every legacy FAIL). A
 * confident FAIL is a delivered answer. UNDETERMINED is filed as delivered and /satisfy will not
 * pay for it (the rule #1406 set for an unanswered chain read).
 */
export function routesToDispute(result: Deliverable): boolean {
  const v = verdictOf(result);
  return v === 'VETO' || (v === 'FAIL' && result?.confident !== true);
}
