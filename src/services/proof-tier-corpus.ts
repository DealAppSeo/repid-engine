/**
 * proof-tier-corpus.ts — the LABELLED evaluation corpus for the proof-tier policy.
 *
 * WHY THIS FILE EXISTS SEPARATELY, AND WHY IT IS COMMITTED BEFORE THE RUNNER.
 * Four times in the last five beats a test was found to pin a weaker property than the
 * one being claimed, and twice the cause was a *self-referential oracle* — the expected
 * value was computed, directly or transitively, by the code under test. A regret
 * measurement is the most rigging-prone artifact this loop has produced yet: whoever
 * writes both the labels and the policy can make the policy look arbitrarily good by
 * moving the labels.
 *
 * Two structural defences, not promises:
 *   1. `requiredTier` is declared from the SEMANTICS of the scenario — what the answer
 *      would need in order to be trustworthy — and is stated in the `why` field in terms
 *      a reader can check without running anything. Nothing in this file imports
 *      `proof-tier-policy`, so a label CANNOT be derived from the policy. That is
 *      enforced by a test, not left to discipline.
 *   2. This file is committed in its own commit, BEFORE the runner that scores against
 *      it exists. The git history is the evidence that the labels were not tuned to the
 *      numbers they produce.
 *
 * LABELLING RULE (the only rule used; applied per scenario, stated once here):
 *   the required tier is the WEAKEST rung sufficient for the answer to be trustworthy.
 *     none               — the answer asserts no fact drawn from committed memory.
 *     inclusion          — it cites a stored fact that is IMMUTABLE once written
 *                          (a tx hash, a historical event), so "it was committed" suffices.
 *     current_validity   — it cites a fact that is REVOCABLE or mutable (a tier, a stake,
 *                          a permission, a policy), so it must be proven un-retracted NOW.
 *     authenticated_walk — the answer is DERIVED by traversing links between entities;
 *                          each hop must verify, not just the endpoints.
 *     ranking_integrity  — the answer asserts an ORDER over a set (a top-k, a "best"),
 *                          so the selection itself must be provably correct.
 *
 * The axes are set from the situation (who is asking, what it costs to be wrong, how
 * urgent, how sensitive) and NOT reverse-engineered from the label. Where an axis was a
 * genuine judgement call it is noted in `why`.
 *
 * PURE DATA. No imports. No behaviour. Inert by construction.
 */

/** Kept as a literal union rather than imported, so this file cannot depend on the
 *  module it is used to evaluate. A test asserts these strings match PROOF_TIERS. */
export type RequiredTier =
  | 'none'
  | 'inclusion'
  | 'current_validity'
  | 'authenticated_walk'
  | 'ranking_integrity';

export interface CorpusScenario {
  id: string;
  /** Which product surface this call comes from — real surfaces, not invented ones. */
  surface: string;
  description: string;
  axes: {
    stakes: number;
    costPressure: number;
    privacy: number;
    latencyUrgency: number;
    reliabilityRequired: number;
  };
  /** Declared from semantics. See LABELLING RULE above. */
  requiredTier: RequiredTier;
  why: string;
}

export const PROOF_TIER_CORPUS: CorpusScenario[] = [
  // ── no factual claim over committed memory ──────────────────────────────────
  {
    id: 'chat-smalltalk',
    surface: 'TrustChat',
    description: 'User asks the agent to rephrase its previous paragraph more concisely.',
    axes: { stakes: 0.05, costPressure: 0.6, privacy: 0.1, latencyUrgency: 0.7, reliabilityRequired: 0.2 },
    requiredTier: 'none',
    why: 'Pure text transformation. Nothing is asserted about the world, so there is no evidence to prove.',
  },
  {
    id: 'internal-drill',
    surface: 'swarm (trinity_tasks)',
    description: 'Scheduled self-test task: agent confirms it can parse its own task envelope.',
    axes: { stakes: 0.02, costPressure: 0.9, privacy: 0.05, latencyUrgency: 0.3, reliabilityRequired: 0.15 },
    requiredTier: 'none',
    why: 'Internal drill with no external consumer and no cited memory. Proving anything here is pure waste — this is the scenario the cheap end of the ladder exists for.',
  },
  {
    id: 'format-json',
    surface: 'engine /api/v1/llm/complete',
    description: 'Reformat a supplied blob of text into JSON matching a given schema.',
    axes: { stakes: 0.08, costPressure: 0.75, privacy: 0.15, latencyUrgency: 0.6, reliabilityRequired: 0.35 },
    requiredTier: 'none',
    why: 'Input is supplied by the caller; the agent adds no memory-derived claim.',
  },
  {
    id: 'brainstorm-names',
    surface: 'TrustShell docs assistant',
    description: 'Suggest candidate names for a new example agent.',
    axes: { stakes: 0.05, costPressure: 0.5, privacy: 0.05, latencyUrgency: 0.4, reliabilityRequired: 0.2 },
    requiredTier: 'none',
    why: 'Creative generation. No truth claim to ground.',
  },

  // ── cites an immutable committed fact ───────────────────────────────────────
  {
    id: 'quote-settlement-tx',
    surface: 'TrustShell receipt view',
    description: 'Answer quotes the Base Sepolia tx hash of a completed x402 settlement.',
    axes: { stakes: 0.55, costPressure: 0.4, privacy: 0.2, latencyUrgency: 0.35, reliabilityRequired: 0.7 },
    requiredTier: 'inclusion',
    why: 'A settled tx hash is immutable once written — it cannot be retracted. Proving it is in the committed root is sufficient; a non-membership proof of retraction would prove nothing extra.',
  },
  {
    id: 'historical-hal-verdict',
    surface: 'HAL audit trail',
    description: 'Report what HAL decided about a specific contract on a specific date.',
    axes: { stakes: 0.45, costPressure: 0.5, privacy: 0.2, latencyUrgency: 0.3, reliabilityRequired: 0.65 },
    requiredTier: 'inclusion',
    why: 'A past verdict is a historical event. Later revision creates a NEW event; it does not unmake this one.',
  },
  {
    id: 'cite-eas-anchor',
    surface: 'proof-carrying retrieval',
    description: 'Cite the EAS UID anchoring a given memory-root epoch.',
    axes: { stakes: 0.5, costPressure: 0.35, privacy: 0.1, latencyUrgency: 0.25, reliabilityRequired: 0.75 },
    requiredTier: 'inclusion',
    why: 'Judgement call: an EAS attestation CAN be revoked, but the claim here is only "this UID anchors this root", which stays true even if the attestation is later revoked. If the claim were "this anchor is still valid" the label would be current_validity.',
  },
  {
    id: 'agent-registration-date',
    surface: 'TrustRepID profile',
    description: 'State when an agent first registered in the roster.',
    axes: { stakes: 0.3, costPressure: 0.55, privacy: 0.15, latencyUrgency: 0.4, reliabilityRequired: 0.5 },
    requiredTier: 'inclusion',
    why: 'First-registration is a one-time historical event; deactivating the agent later does not change when it registered.',
  },
  {
    id: 'quote-published-doc',
    surface: 'docs assistant',
    description: 'Quote a line from a published, versioned spec at a pinned commit.',
    axes: { stakes: 0.35, costPressure: 0.6, privacy: 0.1, latencyUrgency: 0.5, reliabilityRequired: 0.6 },
    requiredTier: 'inclusion',
    why: 'Pinned to a commit, so the cited text is immutable at that address.',
  },

  // ── cites a revocable / mutable fact ────────────────────────────────────────
  {
    id: 'agent-tier-gate',
    surface: 'TrustMarket task gating',
    description: 'Decide whether an agent may claim a task, citing its current RepID tier.',
    axes: { stakes: 0.75, costPressure: 0.4, privacy: 0.2, latencyUrgency: 0.5, reliabilityRequired: 0.85 },
    requiredTier: 'current_validity',
    why: 'Tier is derived from a live score and can drop between commit and use. A demoted agent must not pass a gate on a stale inclusion proof.',
  },
  {
    id: 'stake-sufficient',
    surface: 'x402 escrow',
    description: 'Assert the counterparty stake covers the contract before releasing escrow.',
    axes: { stakes: 0.9, costPressure: 0.3, privacy: 0.25, latencyUrgency: 0.55, reliabilityRequired: 0.9 },
    requiredTier: 'current_validity',
    why: 'Stake can be slashed or withdrawn. Money moves on this answer, so a retracted stake must fail the proof, not merely be absent from it.',
  },
  {
    id: 'revoked-fact-recall',
    surface: 'proof-carrying retrieval',
    description: 'Agent recalls a fact that has since been superseded by a correction.',
    axes: { stakes: 0.7, costPressure: 0.45, privacy: 0.2, latencyUrgency: 0.4, reliabilityRequired: 0.85 },
    requiredTier: 'current_validity',
    why: 'This is the canonical Patent #1 case: inclusion alone would happily prove the SUPERSEDED fact. Only non-membership of its retraction distinguishes still-true from once-true.',
  },
  {
    id: 'permission-check',
    surface: 'engine auth',
    description: 'Answer whether an API key currently holds enterprise-tier permission.',
    axes: { stakes: 0.8, costPressure: 0.5, privacy: 0.35, latencyUrgency: 0.65, reliabilityRequired: 0.9 },
    requiredTier: 'current_validity',
    why: 'Permissions are revoked far more often than they are granted; a stale proof is exactly the failure mode.',
  },
  {
    id: 'active-roster-count',
    surface: 'TrustShell dashboard',
    description: 'State how many agents are currently active.',
    axes: { stakes: 0.4, costPressure: 0.6, privacy: 0.1, latencyUrgency: 0.55, reliabilityRequired: 0.8 },
    requiredTier: 'current_validity',
    why: 'A count over a mutable set. Every member of the set is individually revocable, so "currently" is the whole content of the claim.',
  },
  {
    id: 'medical-eligibility',
    surface: 'TrustMedical (future vertical)',
    description: 'Answer whether a patient currently meets a study-cohort criterion.',
    axes: { stakes: 0.85, costPressure: 0.25, privacy: 0.95, latencyUrgency: 0.3, reliabilityRequired: 0.9 },
    requiredTier: 'current_validity',
    why: 'Consent and eligibility are both revocable. High privacy should also force zkRequired — that is an ORTHOGONAL axis, not a rung, so it does not change this label.',
  },
  {
    id: 'slashing-status',
    surface: 'TrustRepID',
    description: 'Report whether an agent is currently under a slashing penalty.',
    axes: { stakes: 0.8, costPressure: 0.4, privacy: 0.3, latencyUrgency: 0.45, reliabilityRequired: 0.88 },
    requiredTier: 'current_validity',
    why: 'A penalty that has been lifted must not still read as active.',
  },
  {
    id: 'urgent-fraud-hold',
    surface: 'TrustTrader risk',
    description: 'Under time pressure, decide whether an account is currently flagged for fraud review.',
    axes: { stakes: 0.9, costPressure: 0.55, privacy: 0.5, latencyUrgency: 0.95, reliabilityRequired: 0.9 },
    requiredTier: 'current_validity',
    why: 'Deliberately places maximum urgency against maximum stakes — the case where a latency ceiling would be most tempted to under-prove. The requirement does not soften because the caller is in a hurry.',
  },

  // ── derived by multi-hop traversal ──────────────────────────────────────────
  {
    id: 'provenance-chain',
    surface: 'proof-carrying retrieval (GraphRAG)',
    description: 'Explain how a conclusion was reached by walking evidence → intermediate claim → conclusion.',
    axes: { stakes: 0.7, costPressure: 0.3, privacy: 0.25, latencyUrgency: 0.2, reliabilityRequired: 0.85 },
    requiredTier: 'authenticated_walk',
    why: 'Endpoint proofs do not constrain the middle. Each hop must verify or the chain can be spliced from two genuine but unrelated facts.',
  },
  {
    id: 'vouching-graph',
    surface: 'TrustRepID web of trust',
    description: 'Answer "is this agent reachable from a trusted root by vouching edges?"',
    axes: { stakes: 0.75, costPressure: 0.35, privacy: 0.3, latencyUrgency: 0.25, reliabilityRequired: 0.88 },
    requiredTier: 'authenticated_walk',
    why: 'Reachability IS the claim, and it lives in the edges rather than in any single node.',
  },
  {
    id: 'contract-lineage',
    surface: 'A2A marketplace',
    description: 'Trace a delivered artifact back through subcontracts to the originating request.',
    axes: { stakes: 0.65, costPressure: 0.4, privacy: 0.2, latencyUrgency: 0.3, reliabilityRequired: 0.8 },
    requiredTier: 'authenticated_walk',
    why: 'A lineage with one unverified hop is not a lineage.',
  },
  {
    id: 'multi-hop-medical',
    surface: 'TrustMedical (future vertical)',
    description: 'Derive cohort eligibility across linked records held in the isolated health plane.',
    axes: { stakes: 0.9, costPressure: 0.2, privacy: 0.95, latencyUrgency: 0.2, reliabilityRequired: 0.92 },
    requiredTier: 'authenticated_walk',
    why: 'Multi-hop derivation over revocable records. Privacy is maximal, which should set zkRequired, but privacy is orthogonal to the rung.',
  },

  // ── asserts an order over a set ─────────────────────────────────────────────
  {
    id: 'model-leaderboard-top3',
    surface: 'TrustShell /leaderboard/models',
    description: 'Publish the top-3 models by trust score.',
    axes: { stakes: 0.8, costPressure: 0.35, privacy: 0.1, latencyUrgency: 0.2, reliabilityRequired: 0.9 },
    requiredTier: 'ranking_integrity',
    why: 'A public ranking is the most gameable surface we have: proving each entry exists says nothing about whether the ORDER or the cut-off is right.',
  },
  {
    id: 'best-provider-route',
    surface: 'ANFIS router (public claim)',
    description: 'Assert which provider is currently the best value for a workload class.',
    axes: { stakes: 0.7, costPressure: 0.45, privacy: 0.15, latencyUrgency: 0.3, reliabilityRequired: 0.85 },
    requiredTier: 'ranking_integrity',
    why: '"Best" is a superlative over a set — a selection claim, not a membership claim.',
  },
  {
    id: 'top-k-evidence',
    surface: 'proof-carrying retrieval',
    description: 'Answer grounded in the top-k retrieved passages, asserting these were the most relevant.',
    axes: { stakes: 0.75, costPressure: 0.4, privacy: 0.3, latencyUrgency: 0.35, reliabilityRequired: 0.88 },
    requiredTier: 'ranking_integrity',
    why: 'If the retriever can silently drop a contradicting passage, every downstream inclusion proof is still valid and the answer is still wrong. This is the sort-bypass attack backlog #17 exists for.',
  },
  {
    id: 'grant-shortlist',
    surface: 'TrustMarket',
    description: 'Rank candidate agents for a funded contract award.',
    axes: { stakes: 0.85, costPressure: 0.3, privacy: 0.35, latencyUrgency: 0.25, reliabilityRequired: 0.9 },
    requiredTier: 'ranking_integrity',
    why: 'Money is awarded on the order; a losing bidder must be able to check the ordering itself.',
  },

  // ── deliberate stress cases: the axes pull AGAINST the requirement ──────────
  {
    id: 'cheap-but-consequential',
    surface: 'x402 escrow (budget exhausted)',
    description: 'Budget is nearly gone, but the answer still releases funds.',
    axes: { stakes: 0.85, costPressure: 0.98, privacy: 0.2, latencyUrgency: 0.5, reliabilityRequired: 0.9 },
    requiredTier: 'current_validity',
    why: 'Cost pressure is the axis most likely to talk a learned policy out of proving something. The requirement is set by consequence, not by budget — a policy that under-proves here is the failure the floor exists to prevent.',
  },
  {
    id: 'expensive-but-trivial',
    surface: 'TrustChat',
    description: 'Budget is plentiful and the user is patient, but the question is trivial.',
    axes: { stakes: 0.05, costPressure: 0.02, privacy: 0.05, latencyUrgency: 0.05, reliabilityRequired: 0.2 },
    requiredTier: 'none',
    why: 'The mirror image: cheap money must not buy proof nobody needs. Over-proof here is waste, not safety.',
  },
  {
    id: 'high-reliability-low-stakes',
    surface: 'engine health reporting',
    description: 'An internal check that must be right, but where being wrong costs nothing external.',
    axes: { stakes: 0.15, costPressure: 0.5, privacy: 0.1, latencyUrgency: 0.4, reliabilityRequired: 0.95 },
    requiredTier: 'current_validity',
    why: 'Separates the reliability axis from the stakes axis. The claim is about live state, so it needs currency; note the label follows the CLAIM, not the ceremony around it.',
  },
  {
    id: 'private-but-immutable',
    surface: 'TrustMedical (future vertical)',
    description: 'Confirm a historical lab result was recorded, without revealing it.',
    axes: { stakes: 0.6, costPressure: 0.3, privacy: 0.92, latencyUrgency: 0.3, reliabilityRequired: 0.8 },
    requiredTier: 'inclusion',
    why: 'Tests that privacy does NOT inflate the rung: a past recorded result is immutable, so inclusion suffices. Privacy should raise zkRequired instead. A policy that climbs the ladder on privacy alone is confusing two different guarantees.',
  },
  {
    id: 'urgent-and-trivial',
    surface: 'TrustChat',
    description: 'User wants an instant answer to a throwaway question.',
    axes: { stakes: 0.08, costPressure: 0.7, privacy: 0.1, latencyUrgency: 0.98, reliabilityRequired: 0.25 },
    requiredTier: 'none',
    why: 'Urgency and triviality agree here, so no gate should have to fire — a control against reading gate activity as evidence the policy is working.',
  },
];
