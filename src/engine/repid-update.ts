import { db } from '../db';
import { getEcosystemNeedWeight, updateSupplyRate } from '../layers/ecosystem-need';
import { scoreChallengeOutcome } from '../layers/challenge-scoring';
import { scorePrediction } from '../layers/prediction-scoring';
import { applyDecay, computeRedemptionModifier } from '../layers/decay';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';

export interface RepIdUpdateInput {
  agentId: string;
  eventType:
    | 'CHALLENGE_WIN'|'CHALLENGE_LOSS'|'CHALLENGE_DRAW'
    | 'EPISTEMIC_VIOLATION'|'CONSTITUTIONAL_VIOLATION'
    | 'PREDICTION_RESOLVE'
    | 'STAKE'|'GENESIS'|'REFERRAL'|'PEACEMAKER'|'SELF_MONITOR'
    | 'CODE_CONTRIBUTION' | 'WORKFLOW_CONTRIBUTION' | 'TOOL_PIONEER'
    | 'AGENT_TEACHING' | 'AUDIT_CONTRIBUTION';
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
    passed: boolean;
    complianceScore: number;
    halMode: number;
    easAttestationId: string;
    easSchema: string;
    processingMs: number;
  };
}

export function computeTier(repId: number): string {
  if (repId >= 5000) return 'AUTONOMOUS';
  if (repId >= 1000) return 'EARNING_AUTONOMY';
  return 'CUSTODIED_DBT';
}

const FIXED_DELTAS: Partial<Record<RepIdUpdateInput['eventType'], number>> = {
  STAKE: 5, GENESIS: 0, REFERRAL: 20, PEACEMAKER: 15, SELF_MONITOR: 10,
  CODE_CONTRIBUTION: 25, WORKFLOW_CONTRIBUTION: 20, TOOL_PIONEER: 12,
  AGENT_TEACHING: 15, AUDIT_CONTRIBUTION: 15,
};

export async function updateRepId(input: RepIdUpdateInput): Promise<RepIdUpdateResult> {
  // 1 — Fetch agent
  const { data: agent, error } = await db
    .from('repid_agents').select('*').eq('id', input.agentId).single();
  if (error || !agent)
    throw new Error(`[repid-engine] Agent not found: ${input.agentId}`);

  // 2 — Constitutional audit (pre-execution injection hook)
  // Stub today: LASSO + ANFIS live in Sprint 3.
  // EAS attestation via ERC-8004 ValidationRegistry (stub UID generated).
  // Every action passes through this gate — architecture is production-locked.
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

  // 8 — Update agent
  await db.from('repid_agents').update({
    current_repid: newRepId, tier: newTier,
    last_updated: new Date().toISOString(),
    activity_30d: agent.activity_30d + 1,
  }).eq('id', input.agentId);

  // 9 — Full audit trail
  // eas_attestation_id links every event to an EAS attestation
  // via ERC-8004 ValidationRegistry (stub until Sprint 3)
  // mirror_test_triggered = ZKP-auditable proof of ideological neutrality (P-023/P-024)
  await db.from('repid_score_events').insert({
    agent_id: input.agentId,
    event_type: input.eventType,
    delta: finalDelta,
    repid_before: agent.current_repid,
    repid_after: newRepId,
    certainty_at_claim: input.certaintyAtClaim ?? null,
    ecosystem_need_weight: ecosystemNeedWeight,
    mirror_test_triggered: input.mirrorTestTriggered ?? !audit.mirrorTestPassed,
    eas_attestation_id: audit.easAttestationId,
    metadata: {
      decayApplied: agent.current_repid - decayedRepId,
      redemptionModifier: redemptionMod,
      redemptionModifierApplied: redemptionApplied,
      constitutionalAudit: {
        passed: audit.passed,
        complianceScore: audit.complianceScore,
        rulesChecked: audit.rulesChecked,
        halMode: audit.halMode,
        easSchema: audit.easSchema,
        processingMs: audit.processingMs,
      },
      mirrorTest: input.mirrorTestMetadata ?? null,
      x402Context: input.x402Context ?? null,
    },
  });

  // 10 — Update supply rate
  await updateSupplyRate(input.eventType);

  return {
    agentId: input.agentId, agentName: agent.agent_name,
    repIdBefore: agent.current_repid, repIdAfter: newRepId,
    delta: finalDelta, tier: newTier, ecosystemNeedWeight,
    redemptionModifierApplied: redemptionApplied,
    constitutionalAudit: {
      passed: audit.passed,
      complianceScore: audit.complianceScore,
      halMode: audit.halMode,
      easAttestationId: audit.easAttestationId,
      easSchema: audit.easSchema,
      processingMs: audit.processingMs,
    },
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
    current_repid: 1000, tier: 'CUSTODIED_DBT',
  }).select('id').single();

  if (error || !newAgent)
    throw new Error(`[repid-engine] Registration failed: ${error?.message}`);

  await db.from('repid_score_events').insert({
    agent_id: newAgent.id, event_type: 'GENESIS',
    delta: 0, repid_before: 1000, repid_after: 1000,
    ecosystem_need_weight: 1.0,
    eas_attestation_id: `eas-stub-genesis-${newAgent.id.slice(0,8)}`,
    metadata: {
      erc8004_address: params.erc8004Address,
      conservator: params.conservatorAddress ?? null,
      constitutionLoaded: Object.keys(params.constitution ?? {}).length > 0,
      easSchema: 'constitutional-compliance-v1',
    },
  });

  return { agentId: newAgent.id, repId: 1000, tier: 'CUSTODIED_DBT' };
}
