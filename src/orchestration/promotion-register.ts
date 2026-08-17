/**
 * promotion-register.ts — the three stalled mechanisms, entered and honestly graded.
 *
 * This is the Phase 1 deliverable of docs/RSI-ADOPTION-PLAN.md. A registry with nothing in it
 * is `canAssign()` again (LESSONS §3: built, tested, zero callers, and therefore believed to be
 * guarding something), so the ledger ships populated or it does not ship.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * TWO OF THESE THREE ENTRIES CORRECT A DOC THAT SAID OTHERWISE
 * ════════════════════════════════════════════════════════════════════════════════
 * Verified against the source tree on 2026-08-17, not against the documents describing it —
 * and the documents were wrong in the same direction twice, both understating what is built:
 *
 *   • docs/HAL_CANONICAL_v1.md calls `src/services/anfis-comma.ts` "dead code awaiting Sprint 3
 *     wiring", on a grep dated 2026-04-23. FALSE at the module level today: `anfisForward`,
 *     `goldenCenters`, `goldenSpreads` and `gaussianMF` have three consumers
 *     (`src/services/proof-tier-policy.ts`, `src/services/anfis-router.ts`,
 *     `src/resilience/anfis-failover.ts`). Only the `commaANFIS` ENTRY POINT is uncalled.
 *
 *   • docs/SHADOW_REJECT_CAPABILITY.md is headed "DESIGN ONLY — not applied". FALSE: the filter
 *     is built and shipped default-off at
 *     `trinity-symphony-shared/lib/ConstitutionalAgentV4.js:1834-1838`, with a test pinning the
 *     off-state at `trinity-symphony-shared/tests/claimCallSite.test.js:150`.
 *
 * Both errors were inherited into the plan document that produced this file, and both survived
 * until someone grepped for the symbol instead of reading the prose about it (LESSONS §2 —
 * verify the thing itself, never a proxy for it; check the property you actually mean).
 *
 * The dated correction notes now on those two documents came out of this exercise. That is the
 * ledger paying for itself before it has measured anything.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY EVERY ENTRY IS `NOT_CHECKED` AND WHY THAT IS THE HONEST ANSWER
 * ════════════════════════════════════════════════════════════════════════════════
 * None of the three carries a ruled measurement, so none of them can be promoted — which is
 * the invariant working, not the register failing.
 *
 * The plan's original Phase 1 gate read "three verdicts, each with a ruler attached". That gate
 * was not satisfiable and could not have been: the plan's own Phase 0 states that nothing is
 * measurable while the fleet is down, and a ruler requires a measurement. The gate has been
 * amended to "a ruler OR an explicit NOT_CHECKED reason", because the original wording collapsed
 * NOT_CHECKED into failure — the exact two-outcome mistake the surrounding codebase exists to
 * refuse. Recorded in docs/RSI-ADOPTION-PLAN.md §5.
 *
 * PURITY: pure data. `record()` throws on a malformed entry, so importing this module validates
 * it; there is no way to ship a register that violates the ledger's invariants.
 */

import { LedgerEntry, record } from './promotion-ledger';

/** The date this register's claims were verified against the source tree. */
export const VERIFIED_ON = '2026-08-17';

/**
 * `src/layers/constitutional-audit.ts`.
 *
 * SHADOW, not parked: it genuinely runs. Four call sites invoke it
 * (`src/engine/repid-update.ts:6`, `src/engine/mcp.ts:2`, `src/routes/challenge.ts:3`,
 * `src/routes/mirror-test.ts:3`), each carrying a comment routing around its output while
 * `CONSTITUTIONAL_AUDIT_ENABLED` is false.
 *
 * NOT_CHECKED rather than REFUSED: nobody attempted a measurement and had the instrument
 * decline. There is nothing to attempt. `anfis_scoreCompliance` returns a hardcoded 1.0,
 * `lasso_selectRelevantRules` returns every rule without selecting, and `runMirrorTest` returns
 * true unconditionally — so a measurement of this module would be a measurement of three
 * constants, which is a number that describes the stub rather than the mechanism.
 *
 * This is the entry that most wants the Module Space boundary from ./module-space: the
 * non-load-bearing guarantee is currently a convention repeated at four call sites, and LESSONS
 * §3 is about what happens to conventions like that.
 */
const constitutionalAudit: LedgerEntry = record({
  mechanismId: 'constitutional-audit',
  description:
    'LASSO rule selection + ANFIS compliance scoring + mirror test, gated by CONSTITUTIONAL_AUDIT_ENABLED',
  state: 'shadow',
  evidence: {
    kind: 'NOT_CHECKED',
    why:
      'all three primitives are stubs (returns all rules / hardcoded 1.0 / unconditional true), ' +
      'so any measurement would measure the constants rather than the mechanism',
  },
  decidedAt: VERIFIED_ON,
  reference: 'src/layers/constitutional-audit.ts; gated off since 2026-07-05',
});

/**
 * `commaANFIS` in `src/services/anfis-comma.ts`.
 *
 * PARKED, and the description matters: the MODULE is load-bearing in three places; the
 * `commaANFIS` wrapper specifically has no callers. Recording this as "dead code" — as
 * docs/HAL_CANONICAL_v1.md did — would invite someone to delete a file that three live consumers
 * import from.
 *
 * The re-open condition is written as an event someone would notice, not as a date.
 */
const commaAnfisEntryPoint: LedgerEntry = record({
  mechanismId: 'comma-anfis-entry-point',
  description:
    'the packaged 5-input/5-rule commaANFIS entry point (NOT the module: anfisForward/goldenCenters/' +
    'goldenSpreads/gaussianMF from the same file have three live consumers)',
  state: 'parked',
  evidence: {
    kind: 'NOT_CHECKED',
    why:
      'the wrapper has no call sites, so it has never been run against an incumbent; the scaffold ' +
      'it wraps is separately in production use and is not what is parked here',
  },
  reopenCondition:
    'a caller needs the packaged comma-dissonance entry point rather than the scaffold ' +
    '(anfisForward + golden centers/spreads) it already reuses directly',
  decidedAt: VERIFIED_ON,
  reference:
    'src/services/anfis-comma.ts; consumers of the scaffold: src/services/proof-tier-policy.ts, ' +
    'src/services/anfis-router.ts, src/resilience/anfis-failover.ts',
});

/**
 * The shadow-reject capability filter.
 *
 * SHADOW, not parked and certainly not "design only": it is built, shipped, and default-off,
 * which is precisely the shadow posture. What has never happened is the measurement — the
 * four-step verification plan written into docs/SHADOW_REJECT_CAPABILITY.md (enable for one
 * canary agent, confirm its rejects for the two unhandled task types fall to zero, confirm it
 * still claims work so nothing starves, then roll out) has not been run.
 *
 * It also cannot be run right now, and the reason is Phase 0 rather than anything about this
 * mechanism: the plan's precondition is a live fleet, and measuring a claim-loop filter needs
 * agents claiming.
 */
const shadowRejectCapabilityFilter: LedgerEntry = record({
  mechanismId: 'shadow-reject-capability-filter',
  description:
    'CAPABILITY_FILTER — agents stop claiming task types they have no handler for, ending the ' +
    'claim/shadow-reject churn',
  state: 'shadow',
  evidence: {
    kind: 'NOT_CHECKED',
    why:
      "the doc's own four-step verification plan has never been run, and it cannot be run while " +
      'the fleet is down (RSI-ADOPTION-PLAN Phase 0) because measuring a claim-loop filter ' +
      'requires agents claiming',
  },
  decidedAt: VERIFIED_ON,
  reference:
    'trinity-symphony-shared/lib/ConstitutionalAgentV4.js:1834-1838 (default OFF); ' +
    'off-state pinned by trinity-symphony-shared/tests/claimCallSite.test.js:150; ' +
    'design + verification plan in docs/SHADOW_REJECT_CAPABILITY.md',
});

/**
 * The register.
 *
 * Ordered by how much the entry corrects the record, not by name: a reader skimming this list
 * should hit the two stale-doc corrections before the one entry that matched its documentation.
 */
export const PROMOTION_REGISTER: readonly LedgerEntry[] = [
  shadowRejectCapabilityFilter,
  commaAnfisEntryPoint,
  constitutionalAudit,
];
