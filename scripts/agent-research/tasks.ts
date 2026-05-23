/**
 * Trinity multi-track research — 23 task definitions (6 tracks).
 * Source of truth for both the seed (agent_research_queue) and the dispatcher.
 * Sprint labels (SOPHIA…) map to the active trinity-* agents.
 */
export interface ResearchTask {
  uid: string;
  track: number;
  track_name: 'hal_benchmark' | 'red_team_2' | 'erc_8257' | 'trust_market' | 'flywheel' | 'integration_matrix';
  type: 'research' | 'verify' | 'antagonist' | 'synthesis';
  agent: string; // sprint label
  agentId: string; // trinity-* uuid
  paired?: string; // cross-validation pair uid
  deps?: string[]; // dep uids whose outputs are injected into the prompt
  web?: boolean; // inject _erc_context.md
  outFile: string;
  prompt: string;
}

export const AGENT_IDS: Record<string, string> = {
  SOPHIA: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271', VERITAS: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067',
  TORCH: '9c0dc740-8c16-4862-ad62-9ba3d515369d', NEXUS: '848da285-93c5-4e99-a989-3d9e49ebed09',
  HDM: 'f93cdbbe-2337-48b3-8bfd-b5b7a5c2b5c0', GCM: '57a2f83a-e071-4901-bbfd-1ebe15ce0be5',
  MEL: '942860a6-e26f-4334-ae94-b7c1abed1e8c', APM: '065ad782-ea58-4078-9414-60a862d67ba1',
  W3C: 'd82b2ae5-1d1d-462e-87fb-57cb3e63017b', CHESED: '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6',
  SHOFET: '32e0e809-c1c4-4405-913f-135c8a2d6626', ORCH: '84f2d7de-5bb9-4f3b-92ca-aecc7c498271',
};

const D = 'E:/dev/dogfood-v3';
const t = (uid: string, track: number, track_name: ResearchTask['track_name'], type: ResearchTask['type'], agent: string, file: string, prompt: string, extra: Partial<ResearchTask> = {}): ResearchTask =>
  ({ uid, track, track_name, type, agent, agentId: AGENT_IDS[agent]!, outFile: `${D}/${file}`, prompt, ...extra });

export const TASKS: ResearchTask[] = [
  // ---- TRACK 1 — HAL benchmark expansion ----
  t('2026-05-23_T1.1_SOPHIA_corpus_expand', 1, 'hal_benchmark', 'research', 'SOPHIA', 'sophia-corpus-expansion.md',
    'You are SOPHIA. Produce an expanded HAL calibration corpus: ~100 short factual-claim items across 5 domains (factual, opinion, technical, financial, real_estate), each domain ~12 TRUE / ~6 FALSE / ~2 ambiguous. Output a markdown table: | id | domain | text | ground_truth (TRUE/FALSE/AMBIG) | reasoning |. Make FALSE items subtle (mutate a true fact). Keep each text one sentence.'),
  t('2026-05-23_T1.2_VERITAS_corpus_verify', 1, 'hal_benchmark', 'verify', 'VERITAS', 'veritas-corpus-relabel.md',
    'You are VERITAS. Independently re-label a 25-item sample from SOPHIA\'s expanded corpus (below). Give your own TRUE/FALSE/AMBIG per item and flag disagreements with SOPHIA. End with: cross_validation_verdict = agree (<=5% disagreement) | partial_agree (5-15%) | disagree (>15%), and the disagreement %.',
    { paired: '2026-05-23_T1.1_SOPHIA_corpus_expand', deps: ['2026-05-23_T1.1_SOPHIA_corpus_expand'] }),
  t('2026-05-23_T1.3_HDM_hal_benchmark', 1, 'hal_benchmark', 'research', 'HDM', 'hdm-hal-benchmark.md',
    'You are HDM. Given CC2\'s prior 20-item calibration (fact-check discrimination gap +0.617, caught_false 9/10, over-veto-true 0/7; extractor gap -0.020), and the 5-domain corpus design, PROJECT per-domain HAL strictness:1 vs strictness:2 (fact-check) performance. For each domain (factual/opinion/technical/financial/real_estate) give expected discrimination gap + a recommendation: strictness:2 default or strictness:1. Note: live 100-item run deferred (free-tier rate-limit budget) — this is a reasoned projection from the 20-item evidence. Output a per-domain table + recommendation.'),
  t('2026-05-23_T1.4_APM_hal_cost', 1, 'hal_benchmark', 'research', 'APM', 'apm-hal-cost-by-domain.md',
    'You are APM. Cost analysis for HAL strictness:2 (fact-check = ~3 free-LLM calls/eval, groq/cerebras/fireworks free tier). Estimate LLM call volume + cost at 10 / 100 / 1000 service contracts/day, and per-domain (factual vs financial may need different strictness). Note free-tier RPM limits (cerebras 429s under burst) and when HAL would need paid providers. Output projection tables + 1 cost-control recommendation.'),
  t('2026-05-23_T1.5_MEL_hal_recommendations', 1, 'hal_benchmark', 'synthesis', 'MEL', 'mel-hal-domain-recommendations.md',
    'You are MEL. Synthesize the HAL benchmark findings into Trust* product profile defaults. For trustshell (technical), trusttrader (financial), trustcre (real_estate): recommend strictness (1 or 2) + veto threshold + confidence level (given corpus size). Output a recommendation table + caveats.',
    { deps: ['2026-05-23_T1.1_SOPHIA_corpus_expand', '2026-05-23_T1.3_HDM_hal_benchmark', '2026-05-23_T1.4_APM_hal_cost'] }),

  // ---- TRACK 2 — Red team cycle 2 (deterministic-proof only, NO firing) ----
  t('2026-05-23_T2.1_ATTACKER_pattern_v2', 2, 'red_team_2', 'antagonist', 'NEXUS', 'attacker-v2-pattern-library.md',
    'You are the spawned ATTACKER (design-only, deterministic-proof, NO live firing, NO contracts). Building on CC2\'s F-series library (is_simulated case-bypass) design NEW attack categories: (A) economic — idempotency bypass / double-fulfill / self-dealing provider==buyer / sub-floor RepID laundering; (B) collusion — multiple agents inflating each other\'s RepID via mutual validation; (C) sandbagging — deliberately underperforming to game tier dynamics; (D) prompt-injection targeting the BFT validator/judge LLMs. For each: 3-5 patterns with example payload (JSON), expected defense (which check/gate), and a DETERMINISTIC verification approach (pure-function/SQL, per F-series). HARD: design only.'),
  t('2026-05-23_T2.2_CHESED_attacker_tone', 2, 'red_team_2', 'verify', 'CHESED', 'chesed-attacker-tone-audit.md',
    'You are CHESED (tone/safety). Tone-audit the ATTACKER v2 pattern library (below) for unintentional harm: prompts that could be misused if leaked, attack patterns that could harm real users if not scoped to internal testing. Per finding: severity low/med/high + recommended safeguard. End: cross_validation_verdict = agree (no harm flags) | partial_agree (minor) | disagree (significant safety issue).',
    { paired: '2026-05-23_T2.1_ATTACKER_pattern_v2', deps: ['2026-05-23_T2.1_ATTACKER_pattern_v2'] }),
  t('2026-05-23_T2.3_SHOFET_attacker_realism', 2, 'red_team_2', 'verify', 'SHOFET', 'shofet-attacker-realism-judgment.md',
    'You are SHOFET (judge). For each ATTACKER v2 pattern (below) score realism 1-5 (1=hypothetical, 5=confirmed gap class like F-series). Justify each in one line. End with the count at each level and which patterns are >=4 (real architectural risk).',
    { paired: '2026-05-23_T2.1_ATTACKER_pattern_v2', deps: ['2026-05-23_T2.1_ATTACKER_pattern_v2'] }),
  t('2026-05-23_T2.4_ORCH_attacker_priorities', 2, 'red_team_2', 'synthesis', 'ORCH', 'orch-attacker-v2-priorities.md',
    'You are ORCH. Synthesize the ATTACKER patterns + SHOFET realism + CHESED tone into a prioritized V1 hardening list. Top 5 by (realism × impact), each with the concrete fix. Output a ranked table.',
    { deps: ['2026-05-23_T2.1_ATTACKER_pattern_v2', '2026-05-23_T2.3_SHOFET_attacker_realism', '2026-05-23_T2.2_CHESED_attacker_tone'] }),

  // ---- TRACK 3 — ERC-8257 deep research (web context injected) ----
  t('2026-05-23_T3.1_TORCH_erc8257_spec', 3, 'erc_8257', 'research', 'TORCH', 'torch-erc8257-spec-summary.md',
    'You are TORCH. Using the ERC research context (below), summarize ERC-8257 Agent Tool Registry: core contract surface (register/update/deregister, toolId/manifestUri/manifestHash, IAccessPredicate), trust anchor (origin-binding + creator self-attestation), the access-predicate pattern, and concrete integration paths with Trinity Symphony\'s ERC-8004 + x402 + HAL. Output structured markdown.',
    { web: true }),
  t('2026-05-23_T3.2_NEXUS_erc8239_compare', 3, 'erc_8257', 'research', 'NEXUS', 'nexus-erc8257-vs-erc8239.md',
    'You are NEXUS. Using the ERC research context (below), compare ERC-8257 (Tool Registry) vs ERC-8239 (Skill Registry): where they agree, where they differ (mappings vs ERC-721; HTTPS-endpoint vs installable-package), and ryanio\'s convergence proposal (one contract layer + manifestType profiles; 8257 predicate+pricing, 8239 attestation+ERC-8004/8183 wiring). Recommend which Trinity should adopt. Output markdown.',
    { web: true }),
  t('2026-05-23_T3.3_W3C_erc8257_deploy', 3, 'erc_8257', 'research', 'W3C', 'w3c-erc8257-deployment-status.md',
    'You are W3C. Using the ERC research context (below), report ERC-8257 reference deployment status: ProjectOpenSea/tool-registry Foundry impl, ToolRegistry v0.2 at 0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1 (Ethereum mainnet + Base, CREATE2 salt bytes32(1), pre-beta) + the predicate contracts. Note it IS deployed to Base (same chain family as Trinity\'s ERC-8004 on Base Sepolia). State verification caveats (pre-beta) + what to check before integrating. Output markdown.',
    { web: true }),
  t('2026-05-23_T3.4_ORCH_erc8257_validate', 3, 'erc_8257', 'verify', 'ORCH', 'orch-erc8257-research-validation.md',
    'You are ORCH. Cross-validate TORCH\'s ERC-8257 spec summary vs NEXUS\'s 8257-vs-8239 comparison (below). Where do they agree on the integration path? Where diverge? End: cross_validation_verdict = agree | partial_agree | disagree.',
    { paired: '2026-05-23_T3.1_TORCH_erc8257_spec', deps: ['2026-05-23_T3.1_TORCH_erc8257_spec', '2026-05-23_T3.2_NEXUS_erc8239_compare'] }),

  // ---- TRACK 4 — TrustMarket.dev viability ----
  t('2026-05-23_T4.1_GCM_trustmarket_frames', 4, 'trust_market', 'research', 'GCM', 'gcm-trustmarket-positioning.md',
    'You are GCM. Draft 3 positioning frames for TrustMarket.dev: A "Stripe for AI agent services" (payments), B "GitHub Marketplace for AI capabilities" (discovery/install), C "Upwork for autonomous agents" (contracts/hire-by-job). Per frame: target market, value prop, monetization, network-effect mechanic, primary risk. Output a comparison table + 1-line recommendation.'),
  t('2026-05-23_T4.2_APM_trustmarket_pricing', 4, 'trust_market', 'research', 'APM', 'apm-trustmarket-pricing-model.md',
    'You are APM. Pricing model for an agent-service marketplace across 3 tiers: micropayments (x402, sub-$1), per-contract ($1-$1000), subscription ($1000+). Per tier: service examples, viable agent margins, platform take-rate. Output tables + recommended default take-rate.'),
  t('2026-05-23_T4.3_ORCH_trustmarket_orch', 4, 'trust_market', 'research', 'ORCH', 'orch-trustmarket-orchestration.md',
    'You are ORCH. Orchestration model for TrustMarket.dev: how it coordinates buyer + seller + evaluator (ERC-8183 pattern, Trinity HAL as evaluator), dispute-resolution flow, discovery flow, on/off-ramp UX. Output a flow description + the key state transitions.'),
  t('2026-05-23_T4.4_MEL_trustmarket_coherence', 4, 'trust_market', 'verify', 'MEL', 'mel-trustmarket-coherence-check.md',
    'You are MEL. Do GCM\'s frames + APM\'s pricing + ORCH\'s orchestration (below) describe a coherent single market, or do they conflict? Flag conflicts. End: cross_validation_verdict = agree | partial_agree | disagree.',
    { paired: '2026-05-23_T4.1_GCM_trustmarket_frames', deps: ['2026-05-23_T4.1_GCM_trustmarket_frames', '2026-05-23_T4.2_APM_trustmarket_pricing', '2026-05-23_T4.3_ORCH_trustmarket_orch'] }),

  // ---- TRACK 5 — Flywheel discovery ----
  t('2026-05-23_T5.1_MEL_current_flywheels', 5, 'flywheel', 'research', 'MEL', 'mel-current-flywheels.md',
    'You are MEL. From today\'s shipped work (HAL truth signal, F-series gas-discipline, ERC-8004 bridge live with 5 on-chain attestations, Trinity dogfood, x402), identify 5-7 flywheels (action A → outcome B → reinforces A) currently latent or active. Per flywheel: the loop, current status (active/latent/blocked). Output markdown list.'),
  t('2026-05-23_T5.2_GCM_trustmarket_flywheels', 5, 'flywheel', 'research', 'GCM', 'gcm-trustmarket-flywheels.md',
    'You are GCM. Generate 5-7 NEW candidate flywheels for TrustMarket.dev + ERC-8257 ecosystem (e.g. more tools registered → more discovery → more revenue → more tools; higher HAL accuracy → more buyer trust → more contracts → more HAL training data). Per flywheel: activation energy, reinforcement loop, break point. Output markdown list.'),
  t('2026-05-23_T5.3_ORCH_flywheel_priorities', 5, 'flywheel', 'synthesis', 'ORCH', 'orch-flywheel-prioritized.md',
    'You are ORCH. Rank all flywheels (current + candidate, below) by activation energy: Tier 1 (start today w/ existing infra), Tier 2 (needs V1: HAL enabled, x402 live), Tier 3 (needs V2: TrustMarket, ERC-8257). Output a tiered table + the top 2 Tier-1 flywheels to activate this week.',
    { deps: ['2026-05-23_T5.1_MEL_current_flywheels', '2026-05-23_T5.2_GCM_trustmarket_flywheels'] }),

  // ---- TRACK 6 — Ecosystem integration matrix ----
  t('2026-05-23_T6.1_W3C_ecosystem_map', 6, 'integration_matrix', 'research', 'W3C', 'w3c-ecosystem-standards-map.md',
    'You are W3C. Map 6 ecosystem standards Trinity touches/could touch: ERC-8004 (identity+reputation, integrated), ERC-8257 (tool registry, deployed on Base — research), ERC-8183 (agent settlements — research), x402 (payment, partial), Universal AI Inference Verification Registry (draft), Plonky3 ZKP (Trinity patent surface). Per standard: what it does, current Trinity integration status, what it needs from other standards. Output a matrix table.'),
  t('2026-05-23_T6.2_HDM_dependency_graph', 6, 'integration_matrix', 'research', 'HDM', 'hdm-integration-dependency-graph.md',
    'You are HDM. Build the dependency graph for ecosystem integration (ERC-8004/8257/8183/x402/ZKP): what must come first, what blocks what, what ships in parallel, must-have-first vs nice-to-have-later. Output an ordered dependency list + a parallelizable-vs-sequential breakdown.'),
  t('2026-05-23_T6.3_TORCH_ecosystem_validate', 6, 'integration_matrix', 'verify', 'TORCH', 'torch-ecosystem-validation.md',
    'You are TORCH. Cross-validate W3C\'s standards map + HDM\'s dependency graph (below). Where do you agree? Where push back? End: cross_validation_verdict = agree | partial_agree | disagree.',
    { paired: '2026-05-23_T6.1_W3C_ecosystem_map', deps: ['2026-05-23_T6.1_W3C_ecosystem_map', '2026-05-23_T6.2_HDM_dependency_graph'] }),
];

export const WAVE_1 = TASKS.filter((x) => !x.deps).map((x) => x.uid);
export const WAVE_2 = TASKS.filter((x) => x.deps && x.type === 'verify').map((x) => x.uid);
export const WAVE_3 = TASKS.filter((x) => x.deps && x.type === 'synthesis').map((x) => x.uid);
