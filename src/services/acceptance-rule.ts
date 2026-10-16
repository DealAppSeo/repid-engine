/**
 * DOES THE BUYER'S ACCEPTANCE RELEASE PAYMENT? One pure rule, read by POST /contracts/:id/satisfy.
 *
 * TODAY: a sound deliverable (src/services/verdict.ts) and a satisfaction score above 0. The
 * score is met/total over the work statement's acceptance criteria, so 1 of 3 met pays in full.
 * Prod 2026-10-16 [V SQL]: every one of the 38 criterion-rated settlements ever (32 in the last
 * 30 days) paid with 1 of 2 criteria met.
 *
 * ACCEPTANCE_REQUIRE_ALL_CRITERIA=true releases only when EVERY criterion is met. Default OFF:
 * the decision is exactly today's, and /satisfy logs `acceptance_shadow` wherever the two rules
 * disagree so the flip can be measured first. Flipping it changes when money moves: MAJOR (r31).
 *
 * Legacy unbound contracts carry no criteria, only a bare score, so the flag does not touch them.
 */
export type Release = 'release' | 'withhold';

export function requireAllCriteria(): boolean {
  return process.env['ACCEPTANCE_REQUIRE_ALL_CRITERIA'] === 'true';
}

export function decideAcceptance(args: {
  /** isSoundDeliverable(result) */
  sound: boolean;
  /** deriveSatisfyScore().score */
  score: number;
  /** deriveSatisfyScore().ratings; null on legacy unbound rows */
  ratings: { met: boolean }[] | null;
  requireAll: boolean;
}): { release: boolean; met: number | null; total: number | null; today: Release; would: Release } {
  const { sound, score, ratings, requireAll } = args;
  const met = ratings ? ratings.filter((r) => r.met).length : null;
  const total = ratings ? ratings.length : null;
  const today = sound && score > 0;
  const would = ratings ? sound && ratings.length > 0 && met === total : today;
  return {
    release: requireAll ? would : today,
    met,
    total,
    today: today ? 'release' : 'withhold',
    would: would ? 'release' : 'withhold',
  };
}
