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

// Exported for direct unit testing of the actor-binding guard below.
export async function scoreHandler(req: Request, res: Response) {
  const { agentId, eventType } = req.body;
  if (!agentId || !eventType)
    return res.status(400).json({ error: 'agentId and eventType required' });
  if (!VALID_TYPES.includes(eventType))
    return res.status(400).json({ error: `eventType must be one of: ${VALID_TYPES.join(', ')}` });

  // SECURITY FIX 2026-10-13 (CWE-862 / CWE-345, Strix #1341) — the scoring ACTOR is the
  // AUTHENTICATED PRINCIPAL, never a body field. authMiddleware sets req.agent_id for a
  // per-agent (bound) key, and `agentId` is now in its IDENTITY_FIELDS allow-list, so a bound
  // key naming a different agent is already refused there. This is the second, INDEPENDENT
  // barrier: if a bound key ever reaches here with a body `agentId` that is not its own
  // principal, refuse — a caller string must never choose whose score (confirmed-outcome or
  // any other) moves. Non-bound keys (env REPID_API_KEYS set no req.agent_id) are unaffected:
  // scoring on behalf of arbitrary agents is their existing, intended behaviour, exactly as
  // f2-authz only binds dbAgentId-backed keys. So non-confirmed scoring is byte-for-byte
  // unchanged for every legitimate caller.
  const principal = (req as any).agent_id;
  if (
    typeof principal === 'string' && principal.trim() &&
    typeof agentId === 'string' && agentId.trim() !== principal.trim()
  ) {
    return res.status(403).json({
      error: 'Forbidden: agentId does not match the authenticated principal',
      field: 'body.agentId',
    });
  }

  try {
    return res.json(await updateRepId(req.body));
  } catch (err: any) {
    return res.status(err.message?.includes('not found') ? 404 : 500)
      .json({ error: err.message });
  }
}

router.post('/score', scoreHandler);

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
