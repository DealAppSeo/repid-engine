import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'dummy-key'
);

router.post('/run', async (req, res) => {
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
