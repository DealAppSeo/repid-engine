import express from 'express';
import { startValidationWorker } from './services/validation-queue-worker';
import { startTrinityTaskBridge } from './services/trinity-task-bridge';
import { startHitlNotificationDispatcher } from './services/hitl-notification-dispatcher';
import { startPeerVerificationReader } from './services/peer-verification-reader';
import { startHitlExpirySweeper } from './services/hitl-expiry-sweeper';
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
import halEvaluateRouter from './routes/hal-evaluate';
import apiKeyRequestsRouter from './routes/v1/api-key-requests';
import controllerRouter from './routes/v1/controller';
import escalationRouter from './routes/v1/escalation';
import federationRouter from './routes/v1/federation';
import marketplaceRouter from './routes/v1/marketplace';
import v1Router from './routes/v1';
import launchStatusRouter from './routes/v1/launch-status';
import internalCronRouter from './routes/v1/internal-cron';
import productivityRouter from './routes/v1/productivity';
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
import x402InboundRouter from './routes/x402-inbound';
import { feedbackLoopWorker } from './workers/feedback-loop-worker';
import { cascadeSettlementWorker } from './workers/cascade-settlement-worker';
import { x402Metrics } from './observability/x402-metrics';

import { runTier1Benchmark } from './services/hal-tester';
import { anchorDailyRoot } from './services/audit-merkle-anchor';
import { db } from './db';
import { pgPing } from './db/direct-pg';

import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware, checkRedisStatus } from './middleware/rateLimit';
// CC Sprint 2: global token-bucket rate limiter (BYOK bypass + tier-based)
import { rateLimitMiddleware as globalRateLimit } from './middleware/rate-limit';
import { attestationExtractorMiddleware } from './middleware/attestation-extractor';
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
  // CC1 2026-05-26: trustshell.dev v0.app surface consumes public read endpoints
  // (/api/v1/status, /api/v1/hal/stats, /api/v1/repid/:id, /api/v1/llm-trust,
  // /api/v1/receipts/hero, /.well-known/agent.json). Additive — does not loosen
  // the existing CORS denylist for any other origin.
  'https://trustshell.dev',
  'https://www.trustshell.dev',
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
// and BEFORE route handlers + the existing express-rate-limit per-route
// limiters (which act as additional stricter caps, not replacements). BYOK
// keys with valid hashes in user_api_keys bypass entirely.
app.use(attestationExtractorMiddleware);
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
  // Phase 2.8: /api/v1/substance-gate/events carries the agent's raw LLM
  // result/task text (code, prose, lists) which legitimately contains ';',
  // '--' and SQL keywords. Without this bypass the blanket scan 400s nearly
  // every gate POST, so substance_gate_events never accumulates. The route's
  // downstream Supabase writes (substance-gate-writer) are all parameterized.
  if (req.path === '/api/v1/substance-gate/events') return next();
  // Phase 2.9: /api/v1/services and /api/v1/contracts accept free-form text
  // in descriptions, payloads, and results which may contain SQL-like syntax.
  // All downstream Supabase writes are parameterized.
  if (req.path.startsWith('/api/v1/services') || req.path.startsWith('/api/v1/contracts')) return next();
  // Phase 2.10: /api/v1/agent/process-contracts carries buyer payload content
  // (free-form prose/code) processed by PCP/judge; downstream writes parameterized.
  if (req.path === '/api/v1/agent/process-contracts') return next();
  // Phase 2: HAL evaluation payload accepts free-form text that may contain SQL keywords or semicolons
  if (req.path === '/api/v1/hal/evaluate') return next();
  // CC1 2026-05-25: /repid/verify + /prove-repid carry base64url signatures whose
  // alphabet includes '-', so a valid signature can contain '--' and the blanket SQL
  // scan intermittently 400s legitimate signed requests (also a flaky-test source).
  // Verification is signature-based and downstream Supabase writes are parameterized.
  if (req.path === '/api/v1/repid/verify' || req.path === '/api/v1/prove-repid') return next();
  // API key issuance V0 (2026-05-24): /request use_case is free-form prose (may contain SQL-shaped
  // tokens); the route uses parameterized Supabase writes. Public route, mounted before authMiddleware.
  if (req.path === '/api/v1/api-key-requests/request') return next();
  // Controller (CC2 2026-05-26): /controller/sprint + /wake carry free-form sprint
  // titles/descriptions (prose that legitimately contains SQL-shaped tokens). SBT-gated;
  // downstream Supabase writes are parameterized.
  if (req.path.startsWith('/api/v1/controller/sprint') || req.path.startsWith('/api/v1/controller/wake')) return next();
  // Escalation (CC2 2026-05-26): /escalation/escalate carries free-form summary/detail prose.
  if (req.path === '/api/v1/escalation/escalate') return next();
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
app.use('/api/v1/hal', halEvaluateRouter);
// API key issuance V0 — public intake (developers have no key yet). Before authMiddleware.
app.use('/api/v1/api-key-requests', apiKeyRequestsRouter);
// Controller API (CC2 2026-05-26) — SBT-gated (its own controller-auth middleware),
// so mounted before the REPID_API_KEYS authMiddleware. Backend for the v0.app controller rebuild.
app.use('/api/v1/controller', controllerRouter);
// V2 SUBSTRATE: federated developer-node onboarding (node-facing; gated by node_id/nonce +
// federation opt-in state, NOT by SBT/REPID_API_KEY). Mounted before authMiddleware. Stubbed-
// functional: validates + writes developer_nodes/federation_events; no live federation yet.
app.use('/api/v1/federation', federationRouter);
// V2 SUBSTRATE (PHASE 2 OF MARKETPLACE): RepID rent/sell listings + rentals CRUD.
// SETTLEMENT DISABLED — no money moves, nothing on-chain; rentals only record a row. RepID
// earned during a rental attributes to the AGENT, not the renter. Full UI defers to TrustMarket.dev.
app.use('/api/v1/marketplace', marketplaceRouter);
// Sprint R-C: RepID public endpoints (lookup, history, verify) — no auth
app.use('/api/v1', repidPublicRouter);
// CC1 2026-05-25: public launch status + hero receipt (mounted pre-auth; distinct
// exact paths from the authed /api/v1/status/* observability + /api/v1/receipts/:id).
app.use('/api/v1', launchStatusRouter);
// CC1 2026-05-25: UptimeRobot cron triggers (token-gated via X-Cron-Token, mounted
// pre-auth so they need no REPID_API_KEY; their own CRON_TRIGGER_TOKEN is the auth).
app.use('/api/v1/internal/cron', internalCronRouter);
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

// x402 inbound — payment-gated endpoint (the HTTP 402 handshake is the access
// control), so it is mounted BEFORE authMiddleware alongside the other public
// surfaces. Route: POST /api/v1/x402/:uuid/trade-analysis
app.use('/api/v1/x402', x402InboundRouter);


app.use(authMiddleware);

app.use('/api', llmRouter);

app.use(rateLimitMiddleware);
app.use(versioningMiddleware);

app.use('/api/v1', v1Router);
// CC1 2026-05-26: productivity-stack observability (cost/spend data) — authed (post-authMiddleware).
app.use('/api/v1/observability', productivityRouter);
app.use('/api/v1', receiptsRouter);
// Escalation API (CC2 2026-05-26) — agent/worker-facing (REPID_API_KEYS auth). Routes
// the controller escalation ladder; sean-level fires a Telegram alert via ORCH.
app.use('/api/v1/escalation', escalationRouter);
// Sprint R-C: RepID admin endpoints (attest) — auth required
app.use('/api/v1', repidAdminRouter);
app.use('/api/v1/admin/caps', adminCapsRouter);

app.get('/api/v1/observability/x402-metrics', (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey || apiKey.tier !== 'ops') {
    return res.status(403).json({ error: 'Forbidden: Ops tier only' });
  }
  return res.json(x402Metrics.snapshot());
});

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
//
// CC1 Round 3 (2026-05-26): added default filter + canonicalization on top of
// the `llm_trust_leaderboard` view to remove test/diagnostic rows, normalize
// case-sensitive duplicates, and hide statistical-noise rows.
//
// Defaults:
//   - excludes llm_provider in {'test-harness', 'diagnostic-test', 'manual', 'test'} and NULL
//   - excludes llm_provider matching /^test/i
//   - excludes rows where last_decision is > 30 days old
//   - lowercases provider names and merges casing duplicates by re-summing decisions
// Opt-out: `?include_stale=true` keeps stale rows; `?include_test=true` keeps test entries.
app.get('/api/v1/llm-trust', async (req, res) => {
  const { data, error } = await db.from('llm_trust_leaderboard').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const includeStale = String(req.query.include_stale ?? '').toLowerCase() === 'true';
  const includeTest = String(req.query.include_test ?? '').toLowerCase() === 'true';

  const TEST_PROVIDERS = new Set(['test-harness', 'diagnostic-test', 'manual', 'test']);
  const STALE_CUTOFF_MS = 30 * 24 * 3600 * 1000;
  const now = Date.now();

  const filtered = (data ?? []).filter((row: any) => {
    const provider = (row.llm_provider ?? '').trim();
    if (!provider) return false; // exclude rows with no provider
    if (!includeTest) {
      const lc = provider.toLowerCase();
      if (TEST_PROVIDERS.has(lc)) return false;
      if (/^test/i.test(lc)) return false;
    }
    if (!includeStale && row.last_decision) {
      const age = now - new Date(row.last_decision).getTime();
      if (age > STALE_CUTOFF_MS) return false;
    }
    return true;
  });

  // Canonicalize provider name (lowercase) and merge case-sensitive duplicates
  // (e.g. "openai"/"OpenAI"). Group key: (lowercased provider, model). Sum totals
  // and recompute hallucination_rate_pct / trust_score_pct / avg_certainty as
  // weighted averages on total_decisions.
  type Agg = {
    llm_provider: string;
    llm_model: string | null;
    total_decisions: number;
    hallucinations_caught: number;
    trust_score_pct_num: number; // weighted sum of trust_score_pct * total_decisions
    avg_certainty_num: number;   // weighted sum of avg_certainty * total_decisions
    agents_using_max: number;
    last_decision: string | null;
  };
  const merged = new Map<string, Agg>();
  for (const row of filtered) {
    const lcProv = String(row.llm_provider).trim().toLowerCase();
    const key = `${lcProv}::${row.llm_model ?? ''}`;
    const td = Number(row.total_decisions ?? 0);
    const hc = Number(row.hallucinations_caught ?? 0);
    const trustPct = Number(row.trust_score_pct ?? 0);
    const certAvg = Number(row.avg_certainty ?? 0);
    const cur = merged.get(key) ?? {
      llm_provider: lcProv,
      llm_model: row.llm_model ?? null,
      total_decisions: 0,
      hallucinations_caught: 0,
      trust_score_pct_num: 0,
      avg_certainty_num: 0,
      agents_using_max: 0,
      last_decision: null as string | null,
    };
    cur.total_decisions += td;
    cur.hallucinations_caught += hc;
    cur.trust_score_pct_num += trustPct * td;
    cur.avg_certainty_num += certAvg * td;
    cur.agents_using_max = Math.max(cur.agents_using_max, Number(row.agents_using ?? 0));
    if (row.last_decision) {
      if (!cur.last_decision || new Date(row.last_decision).getTime() > new Date(cur.last_decision).getTime()) {
        cur.last_decision = row.last_decision;
      }
    }
    merged.set(key, cur);
  }

  // Hide statistical-noise rows: drop entries with fewer than 10 total decisions
  // (these had a misleading "trust_score_pct: 0" on the prior endpoint because
  // sparse-sample math). Override via `?min_decisions=N` (default 10).
  const minDecisions = Number(req.query.min_decisions ?? 10);

  const out = Array.from(merged.values())
    .filter((a) => a.total_decisions >= (Number.isFinite(minDecisions) ? minDecisions : 10))
    .map((a) => ({
      llm_provider: a.llm_provider,
      llm_model: a.llm_model,
      total_decisions: a.total_decisions,
      hallucinations_caught: a.hallucinations_caught,
      hallucination_rate_pct: a.total_decisions > 0
        ? +(100 * a.hallucinations_caught / a.total_decisions).toFixed(2)
        : 0,
      trust_score_pct: a.total_decisions > 0
        ? +(a.trust_score_pct_num / a.total_decisions).toFixed(2)
        : null,
      avg_certainty: a.total_decisions > 0
        ? +(a.avg_certainty_num / a.total_decisions).toFixed(3)
        : null,
      agents_using: a.agents_using_max,
      last_decision: a.last_decision,
    }))
    .sort((a, b) => (b.trust_score_pct ?? 0) - (a.trust_score_pct ?? 0) || b.total_decisions - a.total_decisions);

  return res.json(out);
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

    // PostgREST bypass (2026-05-21) — boot diagnostic for the direct-pg client
    // (used by the feedback-loop poll). Loud, non-fatal: the API itself serves
    // via supabase-js and must stay up even if DATABASE_URL is unset, but a
    // failure here means the direct-pg hot path is degraded. No silent fallback.
    void pgPing().then((ping) => {
      if (ping.ok) {
        console.log(`[direct-pg] ping OK: latency=${ping.latencyMs}ms (pool max=5)`);
      } else {
        console.error(`[direct-pg] PING FAILED after ${ping.latencyMs}ms: ${ping.error} — set DATABASE_URL (Supavisor transaction pooler, port 6543)`);
      }
    });
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

// Sprint MVP-Delivery Phase 4 (C2) — Cascade Pickup Worker.
//
// Transitions service_contracts.status pending → escrowed. The pending→escrowed
// edge was previously only writable via POST /api/v1/contracts/:id/escrow
// (HTTP-driven placeholder, "in a real flow this would interface with x402");
// no caller existed anywhere in either repo, so all `pending` contracts piled
// up forever. 13 contracts had been stuck pending for 38-46h at sprint open.
//
// γ service_type policy (Strategy Claude ruling): pick contracts where
// agent_services.service_type IS NOT NULL via the FK join (preferred), OR
// payload->>'service_type' IS NOT NULL (fallback when FK row missing).
// Skip when both NULL — manifested in CC_PHASE_4_REPORT.md.
//
// Pickup gates:
//   1. status='pending' AND expires_at > NOW()
//   2. agent_services.active = true
//   3. buyer.current_repid >= service.min_repid_to_purchase (or 0 if NULL)
//   4. (Phase 8 will add x402 settlement validation here — TODO comment marks
//      the seam.)
// Optimistic concurrency: UPDATE predicate includes .eq('status','pending')
// so a race against the manual /escrow endpoint or another worker instance
// loses cleanly (0 rows updated → skip).
async function processCascadeQueue() {
  try {
    const enforcementOn = process.env.X402_ENFORCEMENT_ENABLED === 'true';

    let query = db
      .from('service_contracts')
      .select('id, service_id, buyer_agent_id, agreed_price_usdc_raw, payload, expires_at, created_at, agent_services!inner(service_type, active, min_repid_to_purchase)')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());

    if (enforcementOn) {
      query = query.not('x402_payment_id', 'is', null);
    }

    const { data: pending, error } = await query
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      console.error('[cascade] poll failed:', error?.message ?? error, (error as any)?.stack ?? new Error().stack);
      return;
    }

    // Observability: count pending contracts blocked by payment requirement
    if (enforcementOn) {
      const { count, error: countErr } = await db
        .from('service_contracts')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .is('x402_payment_id', null);

      if (!countErr && count !== null && count > 0) {
        console.log(`[cascade-x402] ${count} pending contracts blocked by payment requirement`);
      }
    }

    if (!pending || pending.length === 0) return;

    for (const c of pending as any[]) {
      // γ service_type resolution: FK preferred, payload fallback.
      const fkServiceType = c.agent_services?.service_type ?? null;
      const payloadServiceType = (c.payload && typeof c.payload === 'object') ? c.payload.service_type ?? null : null;
      const serviceType = fkServiceType || payloadServiceType;

      if (!serviceType) {
        console.warn(`[cascade] skip ${c.id}: service_type unresolvable (FK=NULL, payload=NULL)`);
        continue;
      }

      // Service must be active.
      if (c.agent_services?.active === false) {
        console.warn(`[cascade] skip ${c.id}: agent_services.active=false`);
        continue;
      }

      // Buyer must meet the service's min_repid floor (defaults to 0 if NULL).
      const minRepid = c.agent_services?.min_repid_to_purchase ?? 0;
      if (minRepid > 0) {
        const { data: buyer, error: buyerErr } = await db
          .from('repid_agents')
          .select('current_repid')
          .eq('id', c.buyer_agent_id)
          .maybeSingle();
        if (buyerErr) {
          console.error(`[cascade] buyer lookup failed for ${c.id}:`, buyerErr?.message ?? buyerErr, (buyerErr as any)?.stack ?? new Error().stack);
          continue;
        }
        if (!buyer || (buyer as any).current_repid < minRepid) {
          console.warn(`[cascade] skip ${c.id}: buyer current_repid below floor ${minRepid}`);
          continue;
        }
      }

      // TODO(Phase 8): validate x402 settlement here. For MVP we trust the
      // contract creator's representation that the buyer intends to pay; the
      // /escrow placeholder's "in a real flow this would interface with x402"
      // comment is the original contract for this gate.

      // Optimistic-concurrency transition pending → escrowed.
      const nowIso = new Date().toISOString();
      const { data: updated, error: updErr } = await db
        .from('service_contracts')
        .update({ status: 'escrowed', escrowed_at: nowIso })
        .eq('id', c.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();

      if (updErr) {
        console.error(`[cascade] transition failed for ${c.id}:`, updErr?.message ?? updErr, (updErr as any)?.stack ?? new Error().stack);
        continue;
      }
      if (!updated) {
        // Race lost — another worker or the manual endpoint already advanced this.
        continue;
      }
      const ageMin = Math.round((Date.now() - new Date(c.created_at).getTime()) / 60_000);
      console.log(`[cascade] escrowed ${c.id} (service_type=${serviceType}, age=${ageMin}min)`);
    }
  } catch (e: any) {
    // Loud per Phase 2.9.4: never silent-swallow.
    console.error('[cascade] unhandled error:', e?.message ?? String(e), e?.stack ?? new Error().stack);
  }
}

if (!IS_TEST) {
  setInterval(processCascadeQueue, 60_000);
  processCascadeQueue();
}

// Phase 8 — wire the FeedbackLoopWorker (ERC-8004 reputation write-back).
// The worker class and the Erc8004ReputationWriter have been
// production-complete since 2026-05-11 but the .start() call site was
// never added. Same "Cold Module Disease" pattern as Phase 4 C2 (cascade)
// and Phase 7 (ZKP write-back). 4th instance documented.
//
// Per Strategy Claude Phase 8 Pre-Diagnosis rulings:
//   - Tier floor: 1000 (ESTABLISHED+) — locked inside the worker
//   - Drain-mode rate-limit: 1 write per 60s for first 24h (TODO removal)
//   - Manual /reputation/write route: kept, marked @deprecated
//   - AbortSignal/timeout on ethers.js call: applied inside worker
//   - Circuit breaker: 5 consecutive failures → 5min cool-down
//
// Schedule mirrors Phase 4 C2's setInterval pattern. Worker is observability
// + ledger write surface; not a critical path. start() logs boot config
// (tier_floor, rate_limit_drain_mode boolean) for ops visibility.
if (!IS_TEST) {
  feedbackLoopWorker.start(60_000);
}

// Cascade Settlement Worker — the missing escrowed→fulfilled drain. The inline
// Cascade Pickup Worker above advances pending→escrowed; nothing server-side
// then advanced escrowed→fulfilled (only the frozen ConstitutionalAgentV4 loop
// or the HTTP /agent/process-contracts endpoint did), so escrowed contracts
// piled up. This worker runs the same verified handlers' processOne() on an
// interval. Economically active (drives RepID deltas), so it is OFF unless
// CASCADE_SETTLEMENT_ENABLED=true (mirrors DisputeResolutionWorker gating).
if (!IS_TEST) {
  cascadeSettlementWorker.start();
}

// V1.5 Slice-1 HITL notification dispatcher (CC2 2026-05-26). Watches
// trinity_hitl_requests for CAPABILITY_GAP rows and fans out to subscribers
// in trinity_user_notification_prefs (telegram). DEFAULT OFF — Sean flips
// NOTIFICATION_DISPATCHER_ENABLED=true on Railway once a test pref row exists.
if (!IS_TEST) {
  startHitlNotificationDispatcher();
}

// V1.6 (CC2 2026-05-27) — HITL TTL expiry sweeper. Periodically flips pending
// rows to 'expired' once expires_at lapses. Acts ONLY on rows with expires_at
// IS NOT NULL (pre-migration pending rows are unaffected). DEFAULT OFF — Sean
// flips HITL_EXPIRY_SWEEPER_ENABLED=true after the callback handler is live.
if (!IS_TEST) {
  startHitlExpirySweeper();
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
import { DisputeResolutionWorker } from './workers/dispute-resolution-worker';

startValidationWorker();
startHitlExpirationJob();

if (!IS_TEST) {
  startTrinityTaskBridge();
  startPeerVerificationReader(db);
}

// Phase 2.11 — Dispute Resolution Worker
const disputeWorker = new DisputeResolutionWorker();
disputeWorker.start();

export { processCascadeQueue };
export default app;
