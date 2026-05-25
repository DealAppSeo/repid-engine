import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import {
  getValidationQueueStatus,
  getSubstanceGateStatus,
  getHitlStatus,
  getAgentStatus,
  getRepidEventStats,
  getPeerVerificationStats
} from '../../services/observability-queries';

const router = Router();
const requireAuthIfEnabled = process.env.OBSERVABILITY_REQUIRE_AUTH === 'true' 
  ? authMiddleware 
  : (req: any, res: any, next: any) => next();

router.use(requireAuthIfEnabled);

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

router.get('/peer-verification', async (req, res) => {
  try {
    const data = await getPeerVerificationStats();
    res.json(buildResponse(data));
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch status' } });
  }
});

export default router;
