/**
 * harness-adoption-register.ts — the one mechanism this plan found that fits the ledger's shape.
 *
 * This is the Phase 1 deliverable of docs/AGENT-HARNESS-ADOPTION-PLAN.md, which asked a
 * different question than docs/RSI-ADOPTION-PLAN.md (which produced ./promotion-register.ts):
 * not "what does a single external paper suggest we adopt," but "of everything a survey of
 * production agent-harness patterns (contextual policy engines, plugin-style composition,
 * meta-orchestration over other coding harnesses) recommends, how much of it do we already have,
 * and under what name."
 *
 * The answer, in one line: almost all of it, under different names, at a level of discipline the
 * recommendation list did not assume — see the doc for the full concept map, graded HAVE /
 * PARTIAL / MISSING with file:line evidence. Exactly ONE mechanism found during that pass is a
 * genuine *candidate sitting in shadow, not yet promoted* — the shape this ledger exists to
 * track. Everything else the plan found is either already live and authoritative at its boundary
 * (not a ledger candidate — there is nothing to promote it over), or genuinely absent with no
 * code to register yet. Padding this file with an entry for every row of the doc's concept-map
 * table would be exactly the failure docs/RSI-ADOPTION-PLAN.md section 6 names by name —
 * "adopting the vocabulary without the loop" — so it holds one entry, not a matching count.
 *
 * This file does NOT extend ./promotion-register.ts. That file's own header scopes it to "the
 * three stalled mechanisms" of a different, already-landed plan, and appending an unrelated row
 * to someone else's populated register would blur which plan is accountable for which entry.
 * Same reusable ledger machinery (./promotion-ledger), same discipline, a second small register —
 * two files that agree on format and never disagree on a fact is not the "nine competing planning
 * surfaces" failure NORTH-STAR (trinity-ecosystem) warns about; nine *disagreeing* answers to the
 * same question is. These two files answer different questions.
 *
 * PURITY: pure data, same as ./promotion-register.ts. `record()` throws on a malformed entry at
 * import time, and tests/harness-adoption-register.test.ts imports this module specifically so
 * that validation actually runs in CI rather than only on a human re-reading it (LESSONS 3: a
 * check nothing calls is worse than no check).
 */

import { LedgerEntry, record } from './promotion-ledger';

/** The date this register's claim was checked against the cited reports. */
export const VERIFIED_ON = '2026-08-19';

/**
 * Dual-signature, caveat-bearing delegation, so an owner can only ever NARROW an agent's
 * authority, never widen it. Lives in trinity-ecosystem's
 * `lib/trustshell/identity/{capability,control-proof,delegation,loop-authorizer,memory-authz}.ts`
 * plus the shadow-observer `CustodyShadow.ts`.
 *
 * This is the closest thing in either repo to "capability-style tokens with limits" and
 * "least-privilege tool permissions attenuated by an owner or by trust score" — real code, not a
 * design doc. It is taken seriously enough on this side of the repo boundary that
 * `src/services/owner-ceiling-shadow.ts` and `src/services/agent-owner-resolver.ts` in this repo
 * cite the trinity-ecosystem module by path and reimplement its narrow-only rule, in the same
 * shadow posture.
 *
 * SHADOW is the honest state, not PARKED: it genuinely runs, wired into the live payment route in
 * shadow-only mode (trinity-ecosystem PR #95 — the holder path, not the circuit). What has never
 * happened is promotion, and per this ledger's own invariant it cannot happen yet: the two signed
 * tables a real measurement would compare against (`human_agent_bindings`, `agent_delegations`)
 * carry zero rows, so there is no delegation traffic to measure agreement or disagreement
 * against. That is a different reason than docs/RSI-ADOPTION-PLAN.md's Phase 0 precondition (there
 * the blocker is the fleet being down; here it is that nobody has delegated anything yet), but the
 * same shape of blocker: NOT_CHECKED because there is nothing to check, not because nobody looked.
 *
 * Two independently-dated sources converge on "observe-only, unmeasured," which is why this entry
 * treats the state as settled rather than re-deriving it: trinity-ecosystem's own
 * `docs/TRUST-HARNESS-STATUS-2026-08-17.md` ("ControlProof on /pay: observe-only ... disagreement
 * vs humanCustodyBound is unmeasured on main") and this repo's
 * `reports/2026-08-17/CTO_NIGHT_BRIEF.md` section 6 ("the real attenuation algebra ... already
 * exists ... in shadow mode," two signed tables at zero rows). Both are two days old at the time
 * this file was written — re-verify before relying on this snapshot, the same rule every other
 * live-state fact in this codebase carries.
 */
const ownerAgentCapabilityAttenuation: LedgerEntry = record({
  mechanismId: 'agent-owner-capability-attenuation',
  description:
    'Dual-signature, caveat-bearing delegation (capability.ts permits/isAttenuationOf/intersect/' +
    'excess; control-proof.ts; delegation.ts) constraining an agent by its owner, narrowing-only',
  state: 'shadow',
  evidence: {
    kind: 'NOT_CHECKED',
    why:
      'wired into the live payment route in shadow-only mode (trinity-ecosystem PR #95), but the ' +
      'two signed tables a promotion measurement would compare against (human_agent_bindings, ' +
      'agent_delegations) carry zero rows -- there is no delegation traffic yet to measure ' +
      'agreement or disagreement against',
  },
  decidedAt: VERIFIED_ON,
  reference:
    'trinity-ecosystem/lib/trustshell/identity/{capability,control-proof,delegation,' +
    'loop-authorizer,memory-authz}.ts, CustodyShadow.ts; wired in ' +
    'app/api/trustrails/pay/route.ts (P2, PR #95); cross-repo shadow reimplementation at ' +
    'src/services/owner-ceiling-shadow.ts and src/services/agent-owner-resolver.ts in this repo; ' +
    'status dated 2026-08-17 in trinity-ecosystem/docs/TRUST-HARNESS-STATUS-2026-08-17.md and ' +
    'this repo/reports/2026-08-17/CTO_NIGHT_BRIEF.md section 6',
});

/**
 * The register. One entry today -- see the header for why that is the honest count rather than
 * a gap.
 */
export const HARNESS_ADOPTION_REGISTER: readonly LedgerEntry[] = [ownerAgentCapabilityAttenuation];
