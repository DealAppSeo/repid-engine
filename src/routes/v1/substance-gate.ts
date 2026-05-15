import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { recordGateEvent, slashRepIDForGateFail, appendGateAuditChain } from '../../services/substance-gate-writer';

const VALIDATION_QUEUE_TIERS = new Set([
  'T2a_INTERNAL_REAL_ORGANIC',
  'T2b_INTERNAL_REAL_ADVERSARIAL',
  'T3a_EXTERNAL_TEST_PRIVATE',
  'T3b_EXTERNAL_TEST_PUBLIC',
  'T4_EXTERNAL_REAL_PRODUCTION'
]);

const router = Router();

router.post('/substance-gate/events', async (req: Request, res: Response) => {
  const { task, fastResult, agentName, contentHash, shadow_mode } = req.body;
  
  if (!task || !fastResult || !agentName || !contentHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Write substance_gate_events
    const gateEventId = await recordGateEvent(db, task, fastResult, agentName, contentHash);
    
    if (gateEventId) {
      // 2. RepID slash (if fail and not shadow_mode)
      if (!fastResult.passed && !shadow_mode) {
        const reapCount = task.metadata?.reap_count || 0;
        await slashRepIDForGateFail(db, agentName, task, reapCount, gateEventId);
      }

      // 3. Audit chain (always)
      await appendGateAuditChain(db, gateEventId, task, fastResult, agentName);

      // 4. Validation queue (on pass + T2a+ tier)
      const tier = task.metadata?.test_tier || 'T0_INTERNAL_DEV_TEST';
      if (fastResult.passed && VALIDATION_QUEUE_TIERS.has(tier)) {
        const { error } = await db.from('validation_queue').insert({
          task_id: task.id,
          substance_gate_event_id: gateEventId,
          fast_path_passed: fastResult.passed
        });
        if (error) {
          console.error('[substance-gate] validation_queue insert error:', error.message);
        }
      }
    }

    return res.json({ success: true, gateEventId });
  } catch (err: any) {
    console.error('[substance-gate] endpoint error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
