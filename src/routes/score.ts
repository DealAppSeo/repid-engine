import { Router, Request, Response } from 'express';
import { updateRepId } from '../engine/repid-update';

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

// Sprint 9: Sprint 3 /challenge stub removed. The live /challenge handler
// is src/routes/challenge.ts (mounted before scoreRouter in index.ts).

// POST /mcp-call — constitutional MCP tool wrapper
router.post('/mcp-call', async (req: Request, res: Response) => {
  const { agentId, toolName, params } = req.body ?? {};
  if (!agentId || !toolName)
    return res.status(400).json({ error: 'agentId and toolName required' });
  try {
    const { callMCPWithGuardrails } = await import('../engine/mcp.js');
    return res.json(
      await callMCPWithGuardrails({ agentId, toolName, params: params ?? {} })
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
