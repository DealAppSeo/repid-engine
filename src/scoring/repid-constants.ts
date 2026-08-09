/**
 * Canonical RepID constants — the single source so starting scores never drift again.
 *
 * Before this, a new entity's starting score was written three different ways: 200 for
 * registered agents (repid-update / agents-external / agents), 0 for `builders`
 * (anonymous-signup / builder-registry), and a `?? 1000` fallback in the reward math and
 * pipeline. Three numbers for one concept. 200 (PROBATIONARY) is the canonical start:
 * trust is EARNED up from the bottom, never granted — starting at 1000 (ESTABLISHED) would
 * hand out unearned reputation, contradicting the whole thesis.
 */
export const STARTING_REPID = 200;
