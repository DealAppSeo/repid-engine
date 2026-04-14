import { Router, Request, Response } from 'express';
import { updateRepId } from '../engine/repid-update';
import { fileConstitutionalChallenge } from '../layers/constitutional-audit';

const router = Router();
const VALID_TYPES = [
  'CHALLENGE_WIN','CHALLENGE_LOSS','CHALLENGE_DRAW',
  'EPISTEMIC_VIOLATION','CONSTITUTIONAL_VIOLATION',
  'PREDICTION_RESOLVE','STAKE','GENESIS','REFERRAL',
  'PEACEMAKER','SELF_MONITOR',
  'CODE_CONTRIBUTION', 'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER',
  'AGENT_TEACHING', 'AUDIT_CONTRIBUTION',
];

router.post('/score', async (req: Request, res: Response) => {
  const { agentId, eventType } = req.body;
  if (!agentId || !eventType)
    return res.status(400).json({ error: 'agentId and eventType required' });
  if (!VALID_TYPES.includes(eventType))
    return res.status(400).json({ error: `eventType must be one of: ${VALID_TYPES.join(', ')}` });
  try {
    return res.json(await updateRepId(req.body));
  } catch (err: any) {
    return res.status(err.message?.includes('not found') ? 404 : 500)
      .json({ error: err.message });
  }
});

// Adversarial constitutional challenge
// Full LASSO + ANFIS + EAS attestation pipeline in Sprint 3
router.post('/challenge', async (req: Request, res: Response) => {
  const { challengerId, targetAgentId, allegedRuleReference, evidenceEventIds, certainty } = req.body;
  if (!challengerId || !targetAgentId || !allegedRuleReference)
    return res.status(400).json({
      error: 'challengerId, targetAgentId, allegedRuleReference required'
    });
  try {
    return res.json(await fileConstitutionalChallenge({
      challengerId, targetAgentId, allegedRuleReference,
      evidenceEventIds: evidenceEventIds ?? [], certainty: certainty ?? 0.5,
    }));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
