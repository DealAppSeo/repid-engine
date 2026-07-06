import { db } from '../db';
import { getEcosystemNeedWeight, updateSupplyRate } from '../layers/ecosystem-need';
import { scoreChallengeOutcome } from '../layers/challenge-scoring';
import { scorePrediction } from '../layers/prediction-scoring';
import { applyDecay, computeRedemptionModifier } from '../layers/decay';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';
import { checkAndAwardBadges, BadgeAward } from './badges';

export interface RepIdUpdateInput {
  agentId: string;
  eventType:
    | 'CHALLENGE_WIN'|'CHALLENGE_LOSS'|'CHALLENGE_DRAW'
    | 'EPISTEMIC_VIOLATION'|'CONSTITUTIONAL_VIOLATION'
    | 'PREDICTION_RESOLVE'
    | 'STAKE'|'GENESIS'|'REFERRAL'|'PEACEMAKER'|'SELF_MONITOR'
    | 'CODE_CONTRIBUTION' | 'WORKFLOW_CONTRIBUTION' | 'TOOL_PIONEER'
    | 'AGENT_TEACHING' | 'AUDIT_CONTRIBUTION'
    | 'HANDOFF_COSIGN_VERIFIED' | 'HANDOFF_COSIGN_FALSE_PASS_SLASH'
    | 'PEER_VERIFY_WRONG_CALL'; // Phase 3 dogfooding (behind DOGFOOD_REPID_FROM_COSIGN) + BFT panel divergence
  certaintyAtClaim?: number;
  pStated?: number;
  pCorrect?: number;
  predictionDaysAgo?: number;
  networkImportance?: number;
  isPeacemaker?: boolean;
  selfMonitoring?: boolean;
  constitutionalAdherence?: boolean;
  mirrorTestTriggered?: boolean;
  mirrorTestMetadata?: {
    originalFraming: string;
    invertedFraming: string;
    autoMode: 7;
  };
  x402Context?: {
    paymentAmount: number;
    paymentCurrency: string;
    x402RequestId: string;
  };
  // Provenance for a VERIFIED on-chain stake. The STAKE delta (+5) only
  // applies when this is present — a STAKE event without a verified on-chain
  // stake yields delta 0 (honest: no verified stake, no +5). Populated by the
  // /stake/onchain/verify route after verifyStakeOnChain() confirms the
  // RepIDStaking `Staked` event on Base Sepolia.
  stakeProof?: {
    txHash: string;
    stakeId?: string;
    amountWei?: string;
    contractAddress?: string;
    onChainAgentId?: string;
    blockNumber?: number;
  };
}

export interface RepIdUpdateResult {
  agentId: string;
  agentName: string;
  repIdBefore: number;
  repIdAfter: number;
  delta: number;
  tier: string;
  ecosystemNeedWeight: number;
  redemptionModifierApplied: boolean;
  constitutionalAudit: {
    // enabled=false → the audit is a non-load-bearing stub; passed/complianceScore
    // are placeholders, not measurements (RULE-4). Callers must not treat them as real.
    enabled: boolean;
    passed: boolean | null;
    complianceScore: number | null;
    halMode: number;
    easAttestationId: string;
    easSchema: string;
    processingMs: number;
  };
  newBadges?: BadgeAward[];
}

export function computeTier(repId: number): string {
  if (repId >= 8000) return 'VETERAN';
  if (repId >= 5000) return 'AUTONOMOUS';
  if (repId >= 1000) return 'ESTABLISHED';
  if (repId >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

const FIXED_DELTAS: Partial<Record<RepIdUpdateInput['eventType'], number>> = {
  STAKE: 5, GENESIS: 0, REFERRAL: 20, PEACEMAKER: 15, SELF_MONITOR: 10,
  CODE_CONTRIBUTION: 25, WORKFLOW_CONTRIBUTION: 20, TOOL_PIONEER: 12,
  AGENT_TEACHING: 15, AUDIT_CONTRIBUTION: 15,
  HANDOFF_COSIGN_VERIFIED: 10, // producer + verifier each get + on verified co-sign (calibrated)
  HANDOFF_COSIGN_FALSE_PASS_SLASH: -15, // slash the rubber-stamper (verifier) on false-PASS
  PEER_VERIFY_WRONG_CALL: -5, // BFT panel: reviewer diverged from majority (bounded; low-confidence self-flag exempt)
};

export async function updateRepId(input: RepIdUpdateInput): Promise<RepIdUpdateResult> {
  // Phase 3 dogfooding gate: co-sign -> RepID only if flag ON (default OFF until CC honest-HAL merge)
  const isDogfoodCoSignEvent = input.eventType === 'HANDOFF_COSIGN_VERIFIED' || input.eventType === 'HANDOFF_COSIGN_FALSE_PASS_SLASH';
  if (isDogfoodCoSignEvent && process.env.DOGFOOD_REPID_FROM_COSIGN !== 'true') {
    // flag-OFF no-op: return a no-delta result (tests cover this)
    const { data: agent } = await db.from('repid_agents').select('*').eq('id', input.agentId).single();
    return {
      agentId: input.agentId,
      agentName: agent?.agent_name || 'unknown',
      repIdBefore: agent?.current_repid || 0,
      repIdAfter: agent?.current_repid || 0,
      delta: 0,
      tier: computeTier(agent?.current_repid || 0),
      ecosystemNeedWeight: 0,
      redemptionModifierApplied: false,
      constitutionalAudit: { enabled: false, passed: null, complianceScore: null, halMode: 0, easAttestationId: '', easSchema: '', processingMs: 0 },
    } as any;
  }

  // 1 — Fetch agent
  const { data: agent, error } = await db
    .from('repid_agents').select('*').eq('id', input.agentId).single();
  if (error || !agent)
    throw new Error(`[repid-engine] Agent not found: ${input.agentId}`);

  // 2 — Constitutional audit (pre-execution injection hook)
  // NON-LOAD-BEARING (RULE-4, 2026-07-05): this is a Sprint-3 stub — LASSO/ANFIS/
  // mirror are not real (anfis_scoreCompliance returns a hardcoded 1.0). It is
  // gated behind CONSTITUTIONAL_AUDIT_ENABLED (default OFF). Its output does NOT
  // steer the RepID delta here; when disabled (`audit.enabled === false`) it is
  // recorded honestly in the audit row as "not measured", never as a real score.
  // EAS attestation via ERC-8004 ValidationRegistry is a stub UID.
  const audit = await auditConstitutionalCompliance({
    agentId: input.agentId,
    actionType: input.eventType,
    actionMetadata: {
      certaintyAtClaim: input.certaintyAtClaim,
      x402Context: input.x402Context,
    },
  });

  // 3 — Decay
  const decayedRepId = applyDecay(agent.current_repid, agent.activity_30d);

  // 4 — Ecosystem need weight
  const ecosystemNeedWeight = await getEcosystemNeedWeight(input.eventType);

  // 5 — Delta by event type
  let rawDelta: number;
  const challengeTypes = new Set([
    'CHALLENGE_WIN','CHALLENGE_LOSS','CHALLENGE_DRAW',
    'EPISTEMIC_VIOLATION','CONSTITUTIONAL_VIOLATION'
  ]);
  if (challengeTypes.has(input.eventType)) {
    const outcomeMap: Record<string, any> = {
      CHALLENGE_WIN:'WIN', CHALLENGE_LOSS:'LOSS', CHALLENGE_DRAW:'DRAW',
      EPISTEMIC_VIOLATION:'EPISTEMIC_VIOLATION',
      CONSTITUTIONAL_VIOLATION:'CONSTITUTIONAL_VIOLATION',
    };
    rawDelta = scoreChallengeOutcome({
      outcome: outcomeMap[input.eventType],
      certaintyAtClaim: input.certaintyAtClaim ?? 0.5,
      ecosystemNeedWeight,
      isPeacemaker: input.isPeacemaker,
      selfMonitoring: input.selfMonitoring,
      constitutionalAdherence: input.constitutionalAdherence,
    });
  } else if (input.eventType === 'PREDICTION_RESOLVE') {
    rawDelta = Math.round(scorePrediction({
      pStated: input.pStated ?? 0.5,
      pCorrect: input.pCorrect ?? 0,
      daysAgo: input.predictionDaysAgo ?? 0,
      networkImportance: input.networkImportance ?? 1.0,
    }));
  } else if (input.eventType === 'STAKE') {
    // PROOF-GATED (2026-07-06): the STAKE delta is earned only by a VERIFIED
    // on-chain stake against the canonical RepIDStaking contract. Without a
    // stakeProof (tx of a confirmed `Staked` event, supplied by the
    // /stake/onchain/verify route) the delta is 0 — no verified stake, no +5.
    // This closes the prior hole where any /score {eventType:'STAKE'} call
    // granted +5 with no real deposit backing it (RULE-4: honest scoring).
    rawDelta = input.stakeProof?.txHash ? (FIXED_DELTAS.STAKE ?? 0) : 0;
  } else {
    rawDelta = FIXED_DELTAS[input.eventType] ?? 0;
  }

  // 6 — Redemption modifier (Micah 6:8 as math)
  const redemptionMod = await computeRedemptionModifier(input.agentId);
  const redemptionApplied = redemptionMod < 1.0 && rawDelta < 0;
  const finalDelta = redemptionApplied ? Math.round(rawDelta * redemptionMod) : rawDelta;

  // 7 — New RepID and tier
  const newRepId = Math.max(10, Math.min(10000, decayedRepId + finalDelta));
  const newTier = computeTier(newRepId);

  // 8 — AUDIT ROW FIRST (atomicity reorder, 2026-06-29). Write the replayable ledger row BEFORE
  // mutating the score, so a failed insert can NEVER leave current_repid changed without an audit
  // row (the drift proven live: a constraint-failed insert had mutated the score first). If the
  // insert throws, the score is never touched. (True txn atomicity via an RPC is the follow-up; this
  // reorder eliminates the common drift case.)
  //
  // eas_attestation_id links every event to an EAS attestation via ERC-8004 ValidationRegistry.
  // mirror_test_triggered = ZKP-auditable proof of ideological neutrality (P-023/P-024).
  // HONEST-HAL: record mode in metadata.mode (prod has no top-level `mode` column).
  // Mode label must mirror the ACTUAL behavioral gate (src/scoring/pipeline.ts): the gate uses the
  // SINGULAR var, default-ON (`!== 'false'`). Using the plural default-off spelling here mislabelled
  // the recorded mode. Metadata-accuracy fix only — the gate logic is untouched.
  const halMode = process.env.DOGFOOD_REPID_FROM_COSIGN === 'true' ? 'shadow' : process.env.HAL_DECISION_REQUIRES_QUORUM !== 'false' ? 'live' : 'off';

  const { error: auditError } = await db.from('repid_score_events').insert({
    agent_id: input.agentId,
    event_type: input.eventType,
    delta: finalDelta,
    repid_before: agent.current_repid,
    repid_after: newRepId,
    certainty_at_claim: input.certaintyAtClaim ?? null,
    hal_score: 0.0, // (S-HONEST-HAL Phase 2: wire HAL fact-check verdicts here)
    hal_decision: 'clean', // (S-HONEST-HAL Phase 2: map HAL veto/flag/clean)
    ecosystem_need_weight: ecosystemNeedWeight,
    mirror_test_triggered: input.mirrorTestTriggered ?? !audit.mirrorTestPassed,
    eas_attestation_id: audit.easAttestationId,
    // (S-HONEST-HAL) record mode kept in metadata.mode — prod repid_score_events has NO top-level
    // `mode` column; a top-level write here silently failed the whole audit insert (see throw below).
    metadata: {
      mode: halMode, // 'shadow' = test mode, 'live' = of-record, 'off' = HAL not wired
      decayApplied: agent.current_repid - decayedRepId,
      redemptionModifier: redemptionMod,
      redemptionModifierApplied: redemptionApplied,
      constitutionalAudit: {
        // RULE-4: when the audit is a disabled stub, record it as not-measured —
        // never persist the placeholder pass/1.0 as if it were a real audit result.
        enabled: audit.enabled,
        passed: audit.enabled ? audit.passed : null,
        complianceScore: audit.enabled ? audit.complianceScore : null,
        rulesChecked: audit.enabled ? audit.rulesChecked : [],
        halMode: audit.halMode,
        easSchema: audit.easSchema,
        processingMs: audit.processingMs,
      },
      mirrorTest: input.mirrorTestMetadata ?? null,
      x402Context: input.x402Context ?? null,
      // Provenance for a proof-gated STAKE delta: the verified on-chain stake
      // that backs this +5. Null for every non-STAKE event and for any STAKE
      // event that arrived without proof (delta 0).
      stakeProof: input.eventType === 'STAKE' ? (input.stakeProof ?? null) : null,
    },
  });

  // RULE-11 / fail-loud (S-HONEST-HAL integrity): a money/reputation surface must NEVER mutate
  // current_repid without first writing its repid_score_events audit row. This throw runs BEFORE the
  // score update below, so a failed audit insert (e.g. a constraint violation) can never leave the
  // score changed without a row — the irreconcilable-ledger drift, proven live 2026-06-29 and now
  // eliminated by ordering insert→update.
  if (auditError) {
    throw new Error(
      `[repid-engine] repid_score_events audit insert FAILED for agent ${input.agentId} ` +
      `(event=${input.eventType}, delta=${finalDelta}): ${auditError.message}`,
    );
  }

  // 9 — Apply the score AFTER the audit row is safely written (atomicity reorder 2026-06-29, gated
  // by WRITER_DIRECT_APPLY for single-applier cutover). The ledger row already exists, so even if
  // this update fails the state stays reconcilable via replay — never a silent score-without-row drift.
  const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
  if (WRITER_DIRECT_APPLY) {
    await db.from('repid_agents').update({
      current_repid: newRepId, tier: newTier,
      last_updated: new Date().toISOString(),
      activity_30d: agent.activity_30d + 1,
    }).eq('id', input.agentId);
  }

  // 10 — Update supply rate
  await updateSupplyRate(input.eventType);

  // 11 — Badge milestone check (non-blocking — never fails score flow)
  let newBadges: BadgeAward[] = [];
  try {
    newBadges = await checkAndAwardBadges(input.agentId, agent.current_repid, newRepId);
  } catch {
    newBadges = [];
  }

  return {
    agentId: input.agentId, agentName: agent.agent_name,
    repIdBefore: agent.current_repid, repIdAfter: newRepId,
    delta: finalDelta, tier: newTier, ecosystemNeedWeight,
    redemptionModifierApplied: redemptionApplied,
    constitutionalAudit: {
      enabled: audit.enabled,
      passed: audit.enabled ? audit.passed : null,
      complianceScore: audit.enabled ? audit.complianceScore : null,
      halMode: audit.halMode,
      easAttestationId: audit.easAttestationId,
      easSchema: audit.easSchema,
      processingMs: audit.processingMs,
    },
    newBadges,
  };
}

export async function registerAgent(params: {
  erc8004Address: string;
  agentName: string;
  conservatorAddress?: string;
  constitution?: Record<string, unknown>;
}): Promise<{ agentId: string; repId: number; tier: string }> {
  const { data: existing } = await db.from('repid_agents')
    .select('id').eq('erc8004_address', params.erc8004Address).single();
  if (existing)
    throw new Error(`[repid-engine] Already registered: ${params.erc8004Address}`);

  const { data: newAgent, error } = await db.from('repid_agents').insert({
    erc8004_address: params.erc8004Address,
    agent_name: params.agentName,
    conservator_address: params.conservatorAddress ?? null,
    constitution: params.constitution ?? {},
    current_repid: 200, tier: 'PROBATIONARY',
  }).select('id').single();

  if (error || !newAgent)
    throw new Error(`[repid-engine] Registration failed: ${error?.message}`);

  await db.from('repid_score_events').insert({
    agent_id: newAgent.id, event_type: 'GENESIS',
    delta: 0, repid_before: 200, repid_after: 200,
    ecosystem_need_weight: 1.0,
    eas_attestation_id: `eas-stub-genesis-${newAgent.id.slice(0,8)}`,
    metadata: {
      erc8004_address: params.erc8004Address,
      conservator: params.conservatorAddress ?? null,
      constitutionLoaded: Object.keys(params.constitution ?? {}).length > 0,
      easSchema: 'constitutional-compliance-v1',
    },
  });

  return { agentId: newAgent.id, repId: 200, tier: 'PROBATIONARY' };
}
