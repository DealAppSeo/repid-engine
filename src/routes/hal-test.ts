import express from 'express';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../middleware/auth';
// The per-principal bucket the /peer-verify/respond limiter already uses: agent id for an agent key,
// the allowlist index for an env key — never the key itself, never the IP.
import { respondPrincipalKey as principalKey } from './peer-verification';

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'dummy-key'
);

// POST /api/v1/hal-benchmark/run is mounted ahead of the global authMiddleware (src/index.ts), so it
// ran no auth of its own. It now runs authMiddleware itself: no key -> 401, invalid key -> 403.
// It acts for no agent, so any valid key may run it; what it costs is model budget, so it is
// rate-limited PER KEY, with the same principal bucket as /peer-verify/respond.
export const BENCHMARK_RUNS_PER_HOUR = 3;
const benchmarkLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: BENCHMARK_RUNS_PER_HOUR,
  keyGenerator: principalKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

router.post('/run', authMiddleware, benchmarkLimiter, async (req, res) => {
  try {
    const { runTier1Benchmark } = require('../services/hal-tester');
    const results = await runTier1Benchmark();
    res.json(results);
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/results', async (req, res) => {
  const { data } = await supabase
    .from('hal_antifragility_metrics')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  res.json(data || []);
});

export default router;
