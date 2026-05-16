import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import {
  getValidationQueueStatus,
  getSubstanceGateStatus,
  getHitlStatus,
  getAgentStatus,
  getRepidEventStats
} from '../../services/observability-queries';

const router = Router();
const REQUIRE_AUTH = process.env.OBSERVABILITY_REQUIRE_AUTH === 'true';

if (REQUIRE_AUTH) {
  router.use(requireAuth);
}

const buildResponse = (data: any) => ({
  data,
  generated_at: new Date().toISOString(),
  window_seconds: 86400
});

router.get('/validation-queue', async (req, res) => {
  try {
    const data = await getValidationQueueStatus();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

router.get('/substance-gate', async (req, res) => {
  try {
    const data = await getSubstanceGateStatus();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

router.get('/hitl', async (req, res) => {
  try {
    const data = await getHitlStatus();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const data = await getAgentStatus();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

router.get('/repid-events', async (req, res) => {
  try {
    const data = await getRepidEventStats();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

export default router;
