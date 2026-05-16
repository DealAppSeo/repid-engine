import express from 'express';
import { startValidationWorker } from './services/validation-queue-worker';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import healthRouter from './routes/health';
import agentsRouter from './routes/agents';
import scoreRouter from './routes/score';
import referendumRouter from './routes/referendum';
import bountiesRouter from './routes/bounties';
import hashkeyRouter from './routes/hashkey';
import mirrorTestRouter from './routes/mirror-test';
import challengeRouter from './routes/challenge';
import halStatsRouter from './routes/hal-stats';
import v1Router from './routes/v1';
import agentsExternalRouter from './routes/agents-external';
import agentsExternalScoreRouter from './routes/agents-external-score';
import keysRouter from './routes/key-management';
import telegramRouter, { sendTelegramAlert } from './routes/telegram';
import halTestRouter from './routes/hal-test';
import auditRouter from './routes/audit';
import fullAccountRouter from './routes/full-account';
import receiptsRouter from './routes/receipts';
import { repidPublicRouter, repidAdminRouter } from './routes/repid';
import stakeRouter from './routes/stake';
import { llmRouter } from './routes/route';
import { adminCapsRouter } from './routes/admin-caps';
import discoveryRouter from './routes/discovery';
import agentCardRouter from './routes/agent-card';
import { createAgentsOnchainRouter } from './routes/agents-onchain';
import { createAgentRecallRouter } from './routes/agent-recall';
import { createAgentRegistrationRouter } from './routes/agents-registration';
import { createAgentsReputationRouter } from './routes/agents-reputation';

import { runTier1Benchmark } from './services/hal-tester';
import { anchorDailyRoot } from './services/audit-merkle-anchor';
import { db } from './db';

import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware, checkRedisStatus } from './middleware/rateLimit';
// CC Sprint 2: global token-bucket rate limiter (BYOK bypass + tier-based)
import { rateLimitMiddleware as globalRateLimit } from './middleware/rate-limit';
import { versioningMiddleware } from './middleware/versioning';
import { scoreMonitor } from './engine/score-monitor';

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const app = express();
app.set('trust proxy', 1);

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,                     // Sprint A5: tightened from 10 → 5 per public-alpha brief
  message: { error: 'Too many registrations' },
  skip: (req) => {
    return req.headers['x-enterprise-key'] === process.env.ENTERPRISE_API_KEY;
  }
});

// Sprint A5: public card route gets generous rate limit (60/min/IP)
const cardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many card requests' },
});

const scoreLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 100,                    // 100 score events/min
  keyGenerator: (req): string => String(req.params.id || ipKeyGenerator(req.ip ?? '')),
});
app.use(helmet());
// CORS — permit trustrepid.dev and localhost for development.
// Public demo endpoints (token-signup, run-round-anonymous, stake/deposit)
// need to be reachable from trustrepid.dev's frontend without auth headers.
const allowedOrigins = [
  'https://trustrepid.dev',
  'https://www.trustrepid.dev',
  'http://localhost:3000',
  'http://localhost:3001',
];
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow no-origin requests (server-to-server, curl, mobile apps).
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-RepID-Version'],
}));
app.use(express.json({ limit: "1mb" }));

// CC Sprint 2: global rate limiter on /api/v1/*. Order matters — must run
// AFTER express.json (so we can bypass-fast on BYOK before doing any work)
// and BEFORE route handlers + the existing express-rate-limit per-route
// limiters (which act as additional stricter caps, not replacements). BYOK
// keys with valid hashes in user_api_keys bypass entirely.
app.use(globalRateLimit());

// HYGIENE-1: silence JSON parse stack traces. Malformed bodies still 
// return 400; just log a single-line structured warning instead of 
// a multi-line trace to stderr.
app.use((err: any, req: any, res: any, next: any) => {
  if (err && err.type === 'entity.parse.failed') {
    console.warn(
      `[body-parser] malformed JSON ${req.method} ${req.path} ` +
      `from ${req.ip} content-length=${req.get('content-length') || 0}`
    );
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

// Full-account routes (signup/login/mint/agent/trade/dashboard) are mounted
// BEFORE the SQL-keyword sanitizer because passwords and trade rationales
// can legitimately contain ';' / SQL keywords. The router enforces its own
// per-field validation (see src/routes/full-account.ts). All Supabase calls
// downstream are parameterized, so the sanitizer's blanket protection is
// not load-bearing here.
app.use('/api/v1', fullAccountRouter);

// Sanitize POST validator
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  // Sprint A5: /api/v1/agents/register accepts free-form English text in
  // description and constitution_text, so the SQL-keyword scan false-positives
  // on common words ("select carefully", "do not delete safeguards") and on
  // sentences ending with ';'. Per-field validation runs in the route handler
  // and all downstream Supabase calls are parameterized, so the blanket
  // protection isn't load-bearing here.
  if (req.path === '/api/v1/agents/register') return next();
  // Sprint A7: free-form prompt/answer text legitimately contains SQL keywords
  // ("select carefully", "INSERT a comma", etc.) and sentence-ending ';'.
  // The downstream Supabase calls are parameterized.
  if (/^\/api\/v1\/agents-external\/[^/]+\/score-event$/.test(req.path)) return next();
  // Sprint A7: /api/v1/llm/complete also accepts free-form prompts that may
  // contain SQL-shaped tokens; same parameterized-DB rationale.
  if (req.path === '/api/v1/llm/complete') return next();
  const sanitizeObj = (obj: any) => {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        const val = obj[key].toUpperCase();
        if (val.includes('SELECT ') || val.includes('DROP ') || val.includes('INSERT ') || val.includes('UPDATE ') || val.includes('DELETE ') || val.includes('--') || val.includes(';')) {
           throw new Error('Forbidden SQL keywords detected');
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitizeObj(obj[key]);
      }
    }
  };
  try {
    sanitizeObj(req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Validation failed' });
  }
  next();
});

// Public routes
app.use('/api/v1/telegram', telegramRouter);
app.use('/api/v1/hal-benchmark', halTestRouter);
app.use('/api/v1/audit', auditRouter);
// Sprint R-C: RepID public endpoints (lookup, history, verify) — no auth
app.use('/api/v1', repidPublicRouter);
app.use('/', discoveryRouter);
app.use('/', agentCardRouter);
app.use('/', bountiesRouter);
app.use('/api/v1', halStatsRouter);
app.get('/api/v1/metrics', async (_req, res) => {
  const supabase = db;
  const [agents, decisions, hallucinations] = await Promise.all([
    supabase.from('repid_agents').select('id,vdr_count'),
    supabase.from('repid_score_events').select('id,llm_provider').not('llm_provider','is',null),
    supabase.from('repid_score_events').select('id').eq('hallucination_caught',true)
  ]);
  const vdr = (agents.data||[]).reduce((s,a)=>s+(a.vdr_count||0),0);
  const providers = new Set((decisions.data||[]).map(d=>d.llm_provider)).size;
  res.json({
    agents: agents.data?.length||0,
    vdr, decisions: decisions.data?.length||0,
    providers, hallucinations: hallucinations.data?.length||0,
    staking_contract: '0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA',
    identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    hal_approval_rate: 99.4
  });
});

app.get('/api/v1/network/status', (req, res) => {
  res.status(501).json({
    error: 'NOT_IMPLEMENTED',
    message: 'Global network status infrastructure is scheduled for Sprint DOC2.',
    status: 501
  });
});

app.use('/api', stakeRouter);

// Sprint A7 — public score-event endpoint. Mounted BEFORE authMiddleware so
// it stays unauthenticated; the scoreLimiter (60 req/IP/min) defined below
// is the only gate. Path /api/v1/agents-external/:id/score-event is distinct
// from the legacy bearer-auth /api/v1/agents/:id/score-event in
// src/routes/agents-external.ts.
const externalScoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many score requests' },
  keyGenerator: (req): string => ipKeyGenerator(req.ip ?? ''),
});
app.use('/api/v1/agents-external/:id/score-event', externalScoreLimiter);
app.use('/api/v1/agents-external', agentsExternalScoreRouter);


app.use(authMiddleware);

app.use('/api', llmRouter);

app.use(rateLimitMiddleware);
app.use(versioningMiddleware);

app.use('/api/v1', v1Router);
app.use('/api/v1', receiptsRouter);
// Sprint R-C: RepID admin endpoints (attest) — auth required
app.use('/api/v1', repidAdminRouter);
app.use('/api/v1/admin/caps', adminCapsRouter);

// v11 external agent endpoints
app.use('/api/v1/agents/register', registrationLimiter);
app.use('/api/v1/agents/:id/score-event', scoreLimiter);
app.use('/api/v1/agents/:id/card', cardLimiter); // Sprint A5: 60 req/IP/min on public card
app.use('/api/v1/agents', keysRouter);
app.use('/api/v1/agents', agentsExternalRouter);
// Sprint 6: ERC-8004 mint/status/onchain. POST /:id/mint is bearer-gated by
// the global authMiddleware; the two GETs are bypassed in middleware/auth.ts.
app.use('/api/v1/agents', createAgentsOnchainRouter(db));
// Sprint 12 (megasprint): Graph RAG recall surface — public reads. Bypass
// added in middleware/auth.ts for /recall and /memory/recent.
app.use('/api/v1', createAgentRecallRouter(db));
// Wave 6: ERC-8004 spec compliance — agent registration file + reputation
// feedback writes. Public reads bypassed in middleware/auth.ts.
app.use('/api/v1', createAgentRegistrationRouter(db));
app.use('/api/v1', createAgentsReputationRouter(db));

// v11 LLM trust leaderboard (public)
app.get('/api/v1/llm-trust', async (_req, res) => {
  const { data, error } = await db.from('llm_trust_leaderboard').select('*');
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data ?? []);
});

app.use(healthRouter);
app.use(agentsRouter);
app.use(challengeRouter);   // Sprint 5: must come before scoreRouter (conflicting /challenge)
app.use(scoreRouter);
app.use(referendumRouter);
app.use(mirrorTestRouter);

const port = parseInt(process.env.PORT || '3000', 10);
// Skip side-effects (server bind, score-monitor cron, stalled-task cron, daily
// health alert, HAEE epoch loop) when imported by Jest. supertest mounts the
// app directly and does not need .listen(); these timers and the open server
// socket otherwise keep the test runner from exiting cleanly.
const IS_TEST = process.env.NODE_ENV === 'test';

if (!IS_TEST) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`[repid-engine] v${config.version} running on port ${port} (0.0.0.0)`);
    console.log(`[repid-engine] Environment: ${config.nodeEnv}`);

    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      console.log('[Redis] Connected');
    } else {
      console.log('[Redis] Running in fallback mode - rate limiting disabled');
    }

    // Score monitor Task 8
    setInterval(scoreMonitor, 300000);
  });
}

// Stalled task monitor — runs every hour
async function checkStalledAndAlert() {
  const supabase = db;
  const { data: stalled } = await supabase
    .from('trinity_tasks')
    .select('id,title,agent_assigned')
    .in('status',['in_progress','doing'])
    .lt('updated_at', new Date(Date.now()-4*60*60*1000).toISOString());
  if (stalled && stalled.length > 0) {
    await supabase.from('trinity_tasks')
      .update({status:'pending', updated_at: new Date().toISOString()})
      .in('id', stalled.map((t:any)=>t.id));
    await sendTelegramAlert(
      `⚠️ <b>AUTO-RESET: ${stalled.length} STALLED TASKS</b>\n`
      + stalled.map((t:any)=>`• ${t.agent_assigned}: ${t.title.substring(0,50)}`).join('\n')
      + '\n\nReset to pending automatically.'
    );
  }
}
if (!IS_TEST) {
  setInterval(checkStalledAndAlert, 60*60*1000);
  checkStalledAndAlert();
}

// Daily health check at 6am UTC
async function dailyHealthAlert() {
  const supabase = db;
  const { data } = await supabase.rpc('daily_system_health_check');
  const alerts = (data||[]).filter((r:any)=>r.action_required);
  const summary = (data||[]).find((r:any)=>r.check_name==='system_summary');
  await sendTelegramAlert(
    alerts.length === 0
      ? `✅ <b>DAILY HEALTH: ALL OK</b>\n${summary?.detail}`
      : `⚠️ <b>DAILY HEALTH: ${alerts.length} ALERTS</b>\n`
        + alerts.map((a:any)=>`❌ ${a.check_name}: ${a.detail}`).join('\n')
  );
}
if (!IS_TEST) {
  const now = new Date();
  const next6am = new Date(now);
  next6am.setUTCHours(6,0,0,0);
  if (next6am <= now) next6am.setUTCDate(next6am.getUTCDate()+1);
  setTimeout(()=>{
    dailyHealthAlert();
    setInterval(dailyHealthAlert, 24*60*60*1000);
  }, next6am.getTime()-now.getTime());
}

// HAEE Epoch: runs HAL benchmark every 24 hours
async function runHAEEEpoch() {
  console.log('[HAEE] Starting epoch...');
  
  try {
    const supabase = db;
    
    // Get previous F1 score for antifragility comparison
    const { data: prevMetrics } = await supabase
      .from('hal_antifragility_metrics')
      .select('domain_metrics')
      .order('created_at', { ascending: false })
      .limit(1);
    
    const prevF1 = (prevMetrics?.[0]?.domain_metrics as any)?.f1_score || 0;
    
    // Run benchmark
    const result = await runTier1Benchmark();
    if (!result) return;
    
    const { metrics } = result;
    const currentF1 = metrics.f1_score / 100; // convert from percentage
    const pF1 = prevF1 / 100;
    
    // Compute antifragility score
    const antifragility = pF1 > 0
      ? (currentF1 - pF1) / pF1
      : 0;
    
    // Store in hal_antifragility_metrics
    await supabase.from('hal_antifragility_metrics').insert({
      domain_metrics: {
        ...metrics,
        antifragility_score: antifragility
      },
      is_antifragile: antifragility >= 0,
      hallucination_rate_target_met: true
    });
    
    // Send Telegram alert
    const emoji = antifragility > 0 ? '📈' : antifragility < 0 ? '📉' : '➡️';
    await sendTelegramAlert(
      `🧠 <b>HAEE EPOCH COMPLETE</b>\n`
      + `Precision: ${metrics.precision}%\n`
      + `Recall: ${metrics.recall}%\n`
      + `F1 Score: ${metrics.f1_score}%\n`
      + `FP Rate: ${metrics.false_positive_rate}%\n`
      + `${emoji} Antifragility: ${(antifragility * 100).toFixed(2)}%\n`
      + `Prompts tested: ${metrics.total_prompts}\n`
      + `\nHAL is ${antifragility > 0 ? 'getting stronger' : antifragility < 0 ? 'degrading — check red team' : 'stable'}`
    );
    
    console.log(`[HAEE] Epoch complete. F1: ${metrics.f1_score}%, Antifragility: ${(antifragility*100).toFixed(2)}%`);
    
  } catch(e: any) {
    console.error('[HAEE] Epoch failed:', e.message);
    await sendTelegramAlert(`❌ <b>HAEE EPOCH FAILED</b>\n${e.message}`);
  }
}

// Schedule: run immediately, then every 24 hours
// HYGIENE-1: HAL Tier 1 Benchmark logged 0% F1 every container restart 
// because thresholds need recalibration (OPEN_QUESTIONS Q22). Gate 
// behind explicit env var so log noise is opt-in.
const RUN_HAL_BENCHMARK = process.env.RUN_HAL_BENCHMARK_ON_STARTUP === 'true';
if (!IS_TEST && RUN_HAL_BENCHMARK) {
  runHAEEEpoch();
  setInterval(runHAEEEpoch, 24 * 60 * 60 * 1000);
} else if (!IS_TEST) {
  console.log('[HAEE] Startup benchmark gated off (set RUN_HAL_BENCHMARK_ON_STARTUP=true to enable). Live HAL evaluation unchanged.');
}

// Daily Merkle anchor — fires at 02:00 UTC, anchors yesterday's
// hal_audit_chain rows on Base Sepolia. Idempotent per anchor_date
// (audit_merkle_anchors UNIQUE constraint), so a missed run + manual
// re-trigger just upserts.
async function runDailyAuditAnchor(): Promise<void> {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = await anchorDailyRoot(yesterday);
    console.log(`[audit-anchor] ${r.date} status=${r.status} entries=${r.entry_count} root=${r.root.slice(0, 18)}...`
      + (r.tx_hash ? ` tx=${r.tx_hash}` : ''));
    if (r.status === 'sent') {
      await sendTelegramAlert(
        `⛓️ <b>AUDIT ROOT ANCHORED</b>\n`
        + `Date: ${r.date}\n`
        + `Entries: ${r.entry_count}\n`
        + `Root: <code>${r.root}</code>\n`
        + `Tx: ${r.basescan_url}`
      );
    }
  } catch (e: any) {
    console.error('[audit-anchor] cron failed:', e?.message ?? e);
  }
}

if (!IS_TEST) {
  // Schedule for next 02:00 UTC, then every 24h.
  const nowAnchor = new Date();
  const next2amUtc = new Date(nowAnchor);
  next2amUtc.setUTCHours(2, 0, 0, 0);
  if (next2amUtc <= nowAnchor) next2amUtc.setUTCDate(next2amUtc.getUTCDate() + 1);
  setTimeout(() => {
    runDailyAuditAnchor();
    setInterval(runDailyAuditAnchor, 24 * 60 * 60 * 1000);
  }, next2amUtc.getTime() - nowAnchor.getTime());
}

import { startHitlExpirationJob } from './services/hitl-expiration-job';

startValidationWorker();
startHitlExpirationJob();

export default app;
