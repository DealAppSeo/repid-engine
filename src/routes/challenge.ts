import { Router, Request, Response } from 'express';
import { db } from '../db';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';
import { checkAndAwardBadges } from '../engine/badges';
import { HASHKEY_CONFIG } from './hashkey';
import { anchorRepIdEvent } from '../engine/hashkey-chain';
import { logHalProductionEvent, hashPrompt } from '../engine/production-logger';

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Simple in-memory rate limiter (resets on Railway restart — acceptable for demo)
const challengeRateLimit = new Map<string, { count: number; resetAt: number }>();

// POST /challenge — file a constitutional challenge between two agents/humans.
// This is the core demo endpoint for April 22.
router.post('/challenge', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const { challengerId, defenderId, claim, evidenceText, certaintyAtClaim } = req.body ?? {};

  if (!challengerId || !defenderId || !claim) {
    return res.status(400).json({
      error: 'challengerId, defenderId, and claim are required',
      hint: 'Register at repid.dev/join to get your agentId',
    });
  }
  if (!UUID_REGEX.test(String(challengerId))) {
    return res.status(400).json({
      error: 'Invalid challengerId format — must be a valid UUID from your DBT registration',
      hint: 'Register at repid.dev/join to get your agentId',
    });
  }
  if (!UUID_REGEX.test(String(defenderId))) {
    return res.status(400).json({
      error: 'Invalid defenderId format',
      hint: 'Select a defender from the agent list',
    });
  }
  if (challengerId === defenderId) {
    return res.status(400).json({
      error: 'Cannot challenge yourself',
      hint: 'Select a different agent as your defender',
    });
  }
  const claimStr = String(claim).trim();
  if (claimStr.length < 10) {
    return res.status(400).json({
      error: 'Claim must be at least 10 characters',
      hint: 'State your claim clearly and factually',
    });
  }
  if (claimStr.length > 500) {
    return res.status(400).json({ error: 'Claim must be under 500 characters' });
  }

  // Rate limit: 5 challenges per 60 seconds per agent
  const rateNow = Date.now();
  const rateData = challengeRateLimit.get(challengerId);
  if (rateData && rateNow < rateData.resetAt) {
    if (rateData.count >= 5) {
      return res.status(429).json({
        error: 'Too many challenges. Wait 60 seconds before challenging again.',
        hint: 'Epistemic humility means knowing when to pause.',
        retryAfter: Math.ceil((rateData.resetAt - rateNow) / 1000),
      });
    }
    rateData.count++;
  } else {
    challengeRateLimit.set(challengerId, { count: 1, resetAt: rateNow + 60000 });
  }

  const { data: challenger } = await db
    .from('repid_agents').select('*').eq('id', challengerId).single();
  const { data: defender } = await db
    .from('repid_agents').select('*').eq('id', defenderId).single();
  if (!challenger || !defender) {
    return res.status(404).json({ error: 'Challenger or defender not found' });
  }

  const audit = await auditConstitutionalCompliance({
    agentId: challengerId,
    actionType: 'CHALLENGE',
    actionMetadata: { claim, evidenceText, defenderId },
  });

  const certainty = typeof certaintyAtClaim === 'number' ? certaintyAtClaim : 0.75;
  const hasEvidence = typeof evidenceText === 'string' && evidenceText.length > 20;

  let verdict: string;
  let halMode: number;
  let reasoning: string;

  if (!audit.passed) {
    verdict = 'EPISTEMIC_VIOLATION';
    halMode = 4;
    reasoning = 'Claim states opinion as certain fact. Reclassified as epistemic violation.';
  } else if (certainty > 0.9 && audit.complianceScore < 0.95) {
    verdict = 'EPISTEMIC_VIOLATION';
    halMode = 4;
    reasoning = 'Overconfident claim without sufficient constitutional grounding.';
  } else if (audit.complianceScore >= 0.85) {
    if (hasEvidence && certainty >= 0.65) {
      verdict = 'CLAIM_UPHELD';
      halMode = 1;
      reasoning = 'Claim supported by evidence and within constitutional bounds.';
    } else if (!hasEvidence && certainty < 0.5) {
      verdict = 'DRAW';
      halMode = 3;
      reasoning = 'Insufficient evidence for clear verdict. Both parties encouraged to provide more context.';
    } else {
      verdict = 'CLAIM_REJECTED';
      halMode = 2;
      reasoning = 'Claim lacks sufficient evidence or constitutional grounding.';
    }
  } else {
    verdict = 'GRAY_AREA';
    halMode = 3;
    reasoning = 'Claim falls in constitutional gray area. Mirror test applied — symmetric result.';
  }

  // Asymmetric scoring with certainty² penalty (P-023 layer 5)
  const certaintyPenalty = certainty * certainty;

  let challengerDelta = 0;
  let defenderDelta = 0;
  let challengerEventType = 'CHALLENGE_DRAW';
  let defenderEventType = 'CHALLENGE_DRAW';

  switch (verdict) {
    case 'CLAIM_UPHELD':
      challengerDelta = Math.round(25 * (audit.complianceScore ?? 1.0));
      defenderDelta = Math.round(-50 * certaintyPenalty);
      challengerEventType = 'CHALLENGE_WIN';
      defenderEventType = 'CHALLENGE_LOSS';
      break;
    case 'CLAIM_REJECTED':
      challengerDelta = Math.round(-50 * certaintyPenalty);
      defenderDelta = Math.round(25 * (audit.complianceScore ?? 1.0));
      challengerEventType = 'CHALLENGE_LOSS';
      defenderEventType = 'CHALLENGE_WIN';
      break;
    case 'EPISTEMIC_VIOLATION':
      challengerDelta = Math.round(-75 * certaintyPenalty);
      defenderDelta = 0;
      challengerEventType = 'EPISTEMIC_VIOLATION';
      defenderEventType = 'CONSTITUTIONAL_PASS';
      break;
    case 'DRAW':
    case 'GRAY_AREA':
    default:
      challengerDelta = 0;
      defenderDelta = 0;
      challengerEventType = 'CHALLENGE_DRAW';
      defenderEventType = 'CHALLENGE_DRAW';
  }

  const challengerNewRepId = Math.max(10, Math.min(10000, challenger.current_repid + challengerDelta));
  const defenderNewRepId = Math.max(10, Math.min(10000, defender.current_repid + defenderDelta));

  const now = new Date().toISOString();
  await db.from('repid_agents').update({
    current_repid: challengerNewRepId,
    last_updated: now,
    activity_30d: (challenger.activity_30d ?? 0) + 1,
  }).eq('id', challengerId);
  await db.from('repid_agents').update({
    current_repid: defenderNewRepId,
    last_updated: now,
    activity_30d: (defender.activity_30d ?? 0) + 1,
  }).eq('id', defenderId);

  const easAttestationId = `eas-challenge-${Date.now()}-${String(challengerId).slice(0, 8)}`;
  const challengeId = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await db.from('repid_score_events').insert({
    agent_id: challengerId,
    event_type: challengerEventType,
    delta: challengerDelta,
    repid_before: challenger.current_repid,
    repid_after: challengerNewRepId,
    certainty_at_claim: certainty,
    ecosystem_need_weight: 1.0,
    eas_attestation_id: easAttestationId,
    metadata: {
      challengeId,
      claim,
      verdict,
      halMode,
      reasoning,
      defenderId,
      defenderName: defender.agent_name,
      easSchema: 'constitutional-compliance-v1',
      hashkeyContract: HASHKEY_CONFIG.contractAddress,
      chainId: HASHKEY_CONFIG.chainId,
    },
  });

  await db.from('repid_score_events').insert({
    agent_id: defenderId,
    event_type: defenderEventType,
    delta: defenderDelta,
    repid_before: defender.current_repid,
    repid_after: defenderNewRepId,
    certainty_at_claim: null,
    ecosystem_need_weight: 1.0,
    eas_attestation_id: easAttestationId,
    metadata: {
      challengeId,
      claim,
      verdict,
      halMode,
      reasoning,
      challengerId,
      challengerName: challenger.agent_name,
      easSchema: 'constitutional-compliance-v1',
      role: 'DEFENDER',
      hashkeyContract: HASHKEY_CONFIG.contractAddress,
      chainId: HASHKEY_CONFIG.chainId,
    },
  });

  // Non-blocking HAL production logging — Track A always-running data collection
  logHalProductionEvent({
    agentId: challengerId,
    agentRepid: challenger.current_repid,
    agentDomain: 'general',
    promptHash: hashPrompt(claimStr),
    certaintyAtClaim: certainty,
    halVerdict: verdict,
    halMode,
    halComplianceScore: audit.complianceScore,
    layersActive: {
      sbfa: true,
      bft: true,
      slt: true,
      repid: true,
      wsce: true,
      gnnsr: true,
      anfis: true,
      pcv: true,
    },
    pcvVetoed: verdict === 'EPISTEMIC_VIOLATION',
    totalLatencyMs: Date.now() - startTime,
    easAttestationId,
  }).catch(() => {});

  // Non-blocking on-chain anchor — challenge completes regardless
  anchorRepIdEvent(
    challenger.erc8004_address,
    challengerNewRepId,
    {
      challengeId,
      verdict,
      halMode,
      claim: claimStr,
      certaintyAtClaim: certainty,
      challengerId,
      defenderId,
      repIdBefore: challenger.current_repid,
      repIdAfter: challengerNewRepId,
      timestamp: new Date().toISOString(),
      easSchema: 'constitutional-compliance-v1',
    }
  ).then(anchor => {
    if (anchor.txHash) {
      // Best-effort metadata update — do not block
      db.from('repid_score_events')
        .update({
          metadata: {
            challengeId, claim: claimStr, verdict, halMode, reasoning,
            defenderId, defenderName: defender.agent_name,
            easSchema: 'constitutional-compliance-v1',
            hashkeyContract: HASHKEY_CONFIG.contractAddress,
            chainId: HASHKEY_CONFIG.chainId,
            hashkeyTxHash: anchor.txHash,
            hashkeyBlockNumber: anchor.blockNumber ?? null,
            hashkeyEvidenceHash: anchor.evidenceHash,
            onChain: !anchor.stub,
          },
        })
        .eq('eas_attestation_id', easAttestationId)
        .eq('agent_id', challengerId)
        .then(() => {});
    }
  }).catch(() => {});

  // Run badge check on both parties after challenge
  const [challengerBadges, defenderBadges] = await Promise.all([
    checkAndAwardBadges(challengerId, challenger.current_repid, challengerNewRepId).catch(() => []),
    checkAndAwardBadges(defenderId, defender.current_repid, defenderNewRepId).catch(() => []),
  ]);

  const computeTier = (r: number) =>
    r >= 5000 ? 'AUTONOMOUS' : r >= 1000 ? 'EARNING_AUTONOMY' : 'CUSTODIED_DBT';
  const challengerTierAfter = computeTier(challengerNewRepId);
  const defenderTierAfter = computeTier(defenderNewRepId);

  const milestone =
    challenger.tier !== challengerTierAfter
      ? {
          type: 'TIER_UPGRADE',
          party: 'challenger',
          message: `${challengerTierAfter} unlocked!`,
          confetti: true,
          newTier: challengerTierAfter,
        }
      : defender.tier !== defenderTierAfter
      ? {
          type: 'TIER_CHANGE',
          party: 'defender',
          message: `${defender.agent_name} now ${defenderTierAfter}`,
          confetti: false,
          newTier: defenderTierAfter,
        }
      : null;

  return res.json({
    challengeId,
    verdict,
    halMode,
    reasoning,
    easAttestationId,
    easSchema: 'constitutional-compliance-v1',
    hashkeyContract: HASHKEY_CONFIG.contractAddress,
    hashkeyChainId: HASHKEY_CONFIG.chainId,
    hashkeyExplorerUrl: `${HASHKEY_CONFIG.explorerBase}/address/${HASHKEY_CONFIG.contractAddress}`,
    constitutionalAudit: {
      passed: audit.passed,
      complianceScore: audit.complianceScore,
      halMode,
    },
    challenger: {
      agentId: challengerId,
      agentName: challenger.agent_name,
      repIdBefore: challenger.current_repid,
      repIdAfter: challengerNewRepId,
      delta: challengerDelta,
      eventType: challengerEventType,
      tier: challengerTierAfter,
      newBadges: challengerBadges,
    },
    defender: {
      agentId: defenderId,
      agentName: defender.agent_name,
      repIdBefore: defender.current_repid,
      repIdAfter: defenderNewRepId,
      delta: defenderDelta,
      eventType: defenderEventType,
      tier: defenderTierAfter,
      newBadges: defenderBadges,
    },
    milestone,
  });
});

// GET /challenge/agents — list challengeable named agents (excludes anonymous humans)
// Returns camelCase shape with bio and personality for the Challenge Arena UI.
router.get('/challenge/agents', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier, constitution, erc8004_address')
    .neq('agent_name', 'HUMAN')
    .order('current_repid', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const agents = (data ?? []).map((a: any) => ({
    id: a.id,
    agentName: a.agent_name,
    currentRepId: a.current_repid,
    tier: a.tier,
    bio: a.constitution?.bio ?? 'No bio available',
    personality: a.constitution?.personality ?? 'unknown',
    ruleCount: Object.keys(a.constitution?.rules ?? {}).length,
    erc8004Address: a.erc8004_address,
  }));
  return res.json(agents);
});

// GET /challenge/:id — look up a specific challenge result by challengeId
// Note: must be defined AFTER /challenge/agents to avoid conflict with the literal path.
router.get('/challenge/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (id === 'agents') return res.status(400).json({ error: 'use GET /challenge/agents' });

  const { data, error } = await db
    .from('repid_score_events')
    .select('*')
    .contains('metadata', { challengeId: id })
    .order('created_at', { ascending: true });

  if (error || !data || data.length === 0) {
    return res.status(404).json({ error: 'Challenge not found' });
  }

  const challengerEvent = data[0];
  const defenderEvent = data[1];

  return res.json({
    challengeId: id,
    verdict: challengerEvent.metadata?.verdict ?? null,
    halMode: challengerEvent.metadata?.halMode ?? null,
    reasoning: challengerEvent.metadata?.reasoning ?? null,
    easAttestationId: challengerEvent.eas_attestation_id,
    hashkeyExplorerUrl: `${HASHKEY_CONFIG.explorerBase}/address/${HASHKEY_CONFIG.contractAddress}`,
    challenger: {
      agentId: challengerEvent.agent_id,
      repIdBefore: challengerEvent.repid_before,
      repIdAfter: challengerEvent.repid_after,
      delta: challengerEvent.delta,
      eventType: challengerEvent.event_type,
    },
    defender: defenderEvent
      ? {
          agentId: defenderEvent.agent_id,
          repIdBefore: defenderEvent.repid_before,
          repIdAfter: defenderEvent.repid_after,
          delta: defenderEvent.delta,
          eventType: defenderEvent.event_type,
        }
      : null,
    createdAt: challengerEvent.created_at,
  });
});

export default router;
