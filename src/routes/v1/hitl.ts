import { Router } from 'express';
import { hitlService, HitlReason, HitlResolution } from '../../services/hitl-service';
import { requireAuth } from '../../middleware/auth'; // Ensure this matches actual auth middleware path

const router = Router();

// Require auth if OBSERVABILITY_REQUIRE_AUTH is set (or implicitly for hitl routes)
router.use(requireAuth);

router.get('/requests', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const minPriority = parseInt(req.query.minPriority as string) || undefined;
    const data = await hitlService.getPendingRequests({ limit: Math.min(limit, 200), minPriority });
    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch pending requests' } });
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const data = await hitlService.getRequest(req.params.id);
    if (!data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found' } });
    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch request' } });
  }
});

router.post('/requests', async (req, res) => {
  try {
    const { taskId, validationQueueId, reason, context, priority } = req.body;
    if (!taskId || !reason) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing taskId or reason' } });
    }
    const result = await hitlService.createRequest({
      taskId,
      validationQueueId: validationQueueId || null,
      reason: reason as HitlReason,
      context: context || {},
      priority
    });
    res.json({ data: result });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create request' } });
  }
});

router.post('/requests/:id/assign', async (req, res) => {
  try {
    const { reviewer } = req.body;
    if (!reviewer) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing reviewer' } });
    const data = await hitlService.assignRequest({ requestId: req.params.id, reviewer });
    res.json({ data });
  } catch (error: any) {
    if (error.message.includes('already claimed or missing')) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: error.message } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to assign request' } });
  }
});

router.post('/requests/:id/resolve', async (req, res) => {
  try {
    const { resolution, notes, reviewer } = req.body;
    if (!resolution || !reviewer) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing resolution or reviewer' } });
    const data = await hitlService.resolveRequest({ requestId: req.params.id, resolution: resolution as HitlResolution, notes, reviewer });
    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve request' } });
  }
});

router.post('/requests/expire-stale', async (req, res) => {
  try {
    const data = await hitlService.expireStaleRequests();
    res.json({ data });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to expire requests' } });
  }
});

export default router;
