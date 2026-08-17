import express from 'express';
import { startValidationWorker } from './services/validation-queue-worker';
import { startTrinityTaskBridge } from './services/trinity-task-bridge';
import { startHitlNotificationDispatcher } from './services/hitl-notification-dispatcher';
import { startPeerVerificationReader } from './services/peer-verification-reader';
import { startHitlExpirySweeper } from './services/hitl-expiry-sweeper';
import cors from 'cors';
import { isAllowedOrigin } from './utils/cors-origins';
import helmet from 'helmet';
import { config } from './config';
import healthRouter from './routes/health';
import healthExtendedRouter from './routes/health-extended';
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
import agentKeysRouter from './routes/v1/agent-keys';
import serviceManifestRouter from './routes/v1/service-manifest';
import trustBadgeRouter from './routes/v1/trust-badge';
import openaiCompatRouter from './routes/v1/openai-compat';
import controllerRouter from './routes/v1/controller';
import escalationRouter from './routes/v1/escalation';
import federationRouter from './routes/v1/federation';
import marketplaceRouter from './routes/v1/marketplace';
import ratingsRouter from './routes/v1/ratings';
import marketplacePublicRouter from './routes/v1/marketplace-public';
import receiptPublicRouter from './routes/v1/receipt-public';
import byokRouter from './routes/v1/byok';
import negotiationRouter from './routes/v1/negotiation';
import marketDiscoverRouter from './routes/v1/market-discover';
import marketplaceP0Router from './routes/marketplace'; // TrustMarket-light P0: list/browse
import listingOffersRouter from './routes/v1/listing-offers';
import observabilityPublicRouter from './routes/v1/observability-public';
import v1Router from './routes/v1';
import launchStatusRouter from './routes/v1/launch-status';
import internalCronRouter from './routes/v1/internal-cron';
import productivityRouter from './routes/v1/productivity';
import resilienceRouter from './routes/v1/resilience';
import agentsExternalRouter from './routes/agents-external';
import agentsExternalScoreRouter from './routes/agents-external-score';
import keysRouter from './routes/key-management';
import telegramRouter, { sendTelegramAlert } from './routes/telegram';
import halTestRouter from './routes/hal-test';
import auditRouter from './routes/audit';
import fullAccountRouter from './routes/full-account';
import receiptsRouter from './routes/receipts';
import mvpApiRouter from './routes/mvp-api'; // S-WIRE-MVP — provider-trust/capabilities/dna/x402-gate/disputes/staking/zkp
import { repidPublicRouter, repidAdminRouter } from './routes/repid';
import agentPassportRouter from './routes/v1/agent-passport';
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
// S-SPINE — TrustChat viral surface (all public except referral stats).
import leaderboardRouter from './routes/leaderboard';
import statsRouter from './routes/stats';
import verticalLeaderboardRouter from './routes/vertical-leaderboard';
import providersRouter from './routes/providers';
import subscribeRouter from './routes/subscribe';
import { publicRouter as referralTrackRouter, statsRouter as referralStatsRouter } from './routes/referrals';
import securityStatusRouter from './routes/security-status';
// S-OPTIMIZE — cost + efficiency dashboards (public read, over the existing llm_call_log ledger).
import costsRouter from './routes/costs';
import efficiencyRouter from './routes/efficiency';
// S-CACHE — DragonflyDB cache stats (public read; graceful no-op without REDIS_URL).
import cacheStatsRouter from './routes/cache-stats';
import faucetRouter from './routes/faucet'; // E2E FAUCET step — public read-only faucet info + balance check (no key custody)
import { agentGateRouter } from './routes/agent-gate'; // T0.5 email-OTP gate + run metering status
import { getCache } from './cache/dragonfly';
import { ipRateLimit } from './middleware/ip-rate-limit';
import { feedbackLoopWorker } from './workers/feedback-loop-worker';
import { startRecoveryWorker } from './services/x402-recovery-worker';
import { startReleaseRetryWorker } from './services/x402-release-retry-worker';
import { startStatusDigest } from './services/status-digest';
import { startHealthProbeWorker } from './workers/health-probe-worker';
import { cascadeSettlementWorker } from './workers/cascade-settlement-worker';
import { easAnchorWorker } from './workers/eas-anchor-worker';
import { x402Metrics } from './observability/x402-metrics';

import { runTier1Benchmark } from './services/hal-tester';
import { anchorDailyRoot } from './services/audit-merkle-anchor';
import { db } from './db';
import { shouldParkForHalt } from './services/emergency-halt';
import { pgPing } from './db/direct-pg';

import { authMiddleware } from './middleware/auth';
import repidConfessRouter from './routes/repid-confess';
import { rateLimitMiddleware, checkRedisStatus } from './middleware/rateLimit';
// CC Sprint 2: global token-bucket rate limiter (BYOK bypass + tier-based)
import { rateLimitMiddleware as globalRateLimit } from './middleware/rate-limit';
import { attestationExtractorMiddleware } from './middleware/attestation-extractor';
import { versioningMiddleware } from './middleware/versioning';
import { emergencyHaltMiddleware } from './middleware/emergency-halt';
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
// CORS — allow-list + anchored trust*.dev pattern (src/utils/cors-origins.ts). The trustchat.dev
// frontend + the rest of the Trust* ecosystem call repid-engine's public endpoints (rating, vote,
// subscribe, track, session/share, leaderboard) cross-origin. NOTE (S-FRONTEND restore): this
// trust*.dev allowance shipped in #82 but was dropped by a later merge — restored here so the live
// frontend buttons stop CORS-failing.
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow no-origin requests (server-to-server, curl, mobile apps).
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  // PATCH is required: the trustchat.dev rating button calls PATCH /api/v1/session/:id/rate
  // cross-origin; without PATCH here the preflight's Access-Control-Allow-Methods omits it and
  // the browser blocks the request ("Failed to fetch").
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

// L0 gate 0.4 — GLOBAL EMERGENCY HALT (kill switch). Mounted here, ahead of
// EVERY API router including full-account, so that when
// trinity_system_config.emergency_halt is true no mutating request reaches a
// handler. GET/HEAD are untouched: /health, dashboards and every read surface
// stay up so the operator can watch the system come to rest.
// The guard is SYNCHRONOUS and never queries: mounting it also starts a
// background refresher that reads the flag once per ~5s for the whole process,
// so this adds no per-request latency and no per-request DB dependency.
// Inert by default (the column defaults to false) and fail-open on read error.
// See src/services/emergency-halt.ts for the failure semantics.
app.use(emergencyHaltMiddleware(db));

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
  // Same reason for /api/v1/negotiation: RFQ scope, bid terms and award
  // rationale are free-form prose. The award rationale is REQUIRED to be >= 24
  // characters by a DB CHECK, so a blanket SQL-keyword scan would 400 exactly
  // the explanations the anti-collusion constraint exists to collect.
  if (req.path.startsWith('/api/v1/negotiation')) return next();
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
  // Escalation (CC2 2026-05-26): /escalation/escalate carries free-form summary/detail prose.
  if (req.path === '/api/v1/escalation/escalate') return next();
  // Lesson harvest: a lesson is prose written by an agent about its own mistake,
  // so it routinely contains ';' and '--' and words like "delete". Without this
  // the harvester silently 400s on most real lessons and the graph stays empty —
  // the exact one-end-wired failure this feature exists to fix. The route is
  // authed, length-capped, and its Supabase insert is parameterized.
  if (req.path === '/api/v1/lessons') return next();
  const SKIP_SANITIZER_KEYS = new Set(['description', 'success_criteria', 'expected_output', 'notes', 'title', 'constitution_text', 'interest', 'linkedin', 'github', 'notes_text']);
  const sanitizeObj = (obj: any) => {
    for (const key in obj) {
      if (SKIP_SANITIZER_KEYS.has(key)) continue;
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
// S-CACHE — per-IP rate limit on the public HAL "ask" surface. Env-configurable so the keyless
// demo budget can be raised for a launch/showcase without a code change (HAL_PUBLIC_RATE_LIMIT,
// default 10; HAL_PUBLIC_RATE_WINDOW_SEC, default 86400 = 24h). trustchat-backend's server-to-server
// path is /hal/signals (not throttled); the user-facing /chat lives in trustchat-backend.
const halPublicLimit = Number(process.env.HAL_PUBLIC_RATE_LIMIT) > 0 ? Number(process.env.HAL_PUBLIC_RATE_LIMIT) : 10;
const halPublicWindow = Number(process.env.HAL_PUBLIC_RATE_WINDOW_SEC) > 0 ? Number(process.env.HAL_PUBLIC_RATE_WINDOW_SEC) : 86400;
app.use('/api/v1/hal/evaluate', ipRateLimit(halPublicLimit, halPublicWindow));
app.use('/api/v1/hal', halEvaluateRouter);
// API key issuance V0 — public intake (developers have no key yet). Before authMiddleware.
app.use('/api/v1/api-key-requests', apiKeyRequestsRouter);
// Self-serve agent API keys (2026-08-02) — challenge/response over the wallet an
// agent is registered under. Mounted BEFORE authMiddleware because the caller has
// no key yet; that is the wall this removes. Default OFF
// (AGENT_SELF_SERVE_KEYS_ENABLED); the GET says so rather than 404ing.
app.use('/api/v1/agent-keys', agentKeysRouter);
// MACHINE SURFACE (spec TRUSTMARKET_UX_MERGED_SPEC_v1 §4) — the canonical service
// manifest and its renderers. Mounted at root AND under /api/v1 because
// /.well-known/* and /llms.txt are root-relative by convention while
// /api/v1/services/:id/manifest.json belongs with the rest of the API. Both hit
// the same builder, so the two paths cannot drift.
// BEFORE authMiddleware: a discovery surface behind a key is not a discovery surface.
app.use('/', serviceManifestRouter);
app.use('/api/v1', serviceManifestRouter);
// TRUSTBADGE (spec §10) — reputation portability AS distribution. Public and
// CORS-open because it is an <img> loaded by third-party sites; an auth check
// here would silently break every page that embeds it.
app.use('/api/v1', trustBadgeRouter);
// OPENAI-COMPATIBLE SURFACE — mounted at /v1 (not /api/v1) because that is the path
// every OpenAI client appends to a base URL. Lets Odysseus / Open WebUI / Cursor /
// LangChain / the OpenAI SDKs point at us with one config change and get HAL
// scoring + family provenance for free. Default OFF (OPENAI_COMPAT_ENABLED).
app.use('/v1', openaiCompatRouter);
// Controller API (CC2 2026-05-26) — SBT-gated (its own controller-auth middleware),
// so mounted before the REPID_API_KEYS authMiddleware. Backend for the v0.app controller rebuild.
app.use('/api/v1/controller', controllerRouter);
// V2 SUBSTRATE: federated developer-node onboarding (node-facing; gated by node_id/nonce +
// federation opt-in state, NOT by SBT/REPID_API_KEY). Mounted before authMiddleware. Stubbed-
// functional: validates + writes developer_nodes/federation_events; no live federation yet.
app.use('/api/v1/federation', federationRouter);
// TrustMarket-light P0 (2026-07-09): agent list/browse. POST /list is self-authed
// (env API key must be allowlisted to a poster via REPID_API_KEY_POSTER_BINDINGS,
// else verified:false); GET /browse is PUBLIC/keyless. Mounted BEFORE authMiddleware
// and before the V2 substrate router so /list + /browse resolve first.
app.use('/api/v1/marketplace', marketplaceP0Router);
// LISTING → CONTRACT BRIDGE (2026-08-02) — the "buy" button's destination. Offers
// on listings, and accept, which creates a real service_contract that the existing
// escrow/verify/settle path then drives unchanged. Mounted next to the P0
// list/browse router and BEFORE authMiddleware for the same reason: it does its own
// identity resolution (human login token OR agent key) via resolvePosterIdentity.
// Default OFF (LISTING_BRIDGE_ENABLED).
app.use('/api/v1/marketplace', listingOffersRouter);
// V2 SUBSTRATE (PHASE 2 OF MARKETPLACE): RepID rent/sell listings + rentals CRUD.
// SETTLEMENT DISABLED — no money moves, nothing on-chain; rentals only record a row. RepID
// earned during a rental attributes to the AGENT, not the renter. Full UI defers to TrustMarket.dev.
app.use('/api/v1/marketplace', marketplaceRouter);
// Buy-loop last mile (2026-07-06): PUBLIC read-only marketplace surface
// (GET /recent-transactions). Mounted BEFORE authMiddleware so the /market page
// can show real settled activity with no API key. Read-only; separate file so
// it never touches the settlement-disabled marketplace router above.
app.use('/api/v1/marketplace', marketplacePublicRouter);
// TRUST RECEIPT (2026-08-01): the shareable proof that the harness did its job.
// PUBLIC and mounted BEFORE authMiddleware on purpose — the whole claim is "you
// can check this without trusting us", and a receipt behind an API key does not
// make that claim. Read-only; serves facts ABOUT an exchange, never the work
// itself (no payload, no result). See services/trust-receipt.ts.
app.use('/api/v1', receiptPublicRouter);
// BYOK CUSTODY + HUMAN↔AGENT BINDING (2026-08-01). Mounted before
// authMiddleware because it does NOT use the API-key identity — every request
// proves control of a wallet by signing the method+path+timestamp, and the owner
// is the RECOVERED signer. An API key would be the wrong identity here (it says
// which application is calling, not which human owns the keys), and a header
// would be no identity at all: wallet addresses are public, so trusting
// x-sbt-wallet would let anyone list or overwrite another person's provider
// keys. Both features are behind default-OFF flags. See routes/v1/byok.ts.
app.use('/api/v1', byokRouter);
// Live-numbers (2026-07-07): PUBLIC read-only observability surface the
// TrustShell.dev landing reads for its minted-agent leaderboard + on-chain
// stats block. Two GETs: /api/v1/agents/minted and
// /api/v1/observability/onchain-stats. Mounted BEFORE authMiddleware so the
// landing renders real numbers with no API key. Read-only; separate file so it
// never touches the authed productivity /observability router mounted later.
app.use('/api/v1', observabilityPublicRouter);
// Sprint R-C: RepID public endpoints (lookup, history, verify) — no auth
app.use('/api/v1', repidPublicRouter);
// 2026-07-29: Agent Trust Passport — the public composite (RepID + ERC-8004
// identity + x402 real-vs-simulated history + on-chain writes + latest ZKP,
// all labeled honestly) that TrustShell.dev / TrustMarket.dev render for
// "should I authorize this agent?". DB-first, no per-request RPC.
app.use('/api/v1', agentPassportRouter);
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
// S-CACHE — public cache stats dashboard.
app.use('/api/v1', cacheStatsRouter);
// S-OPTIMIZE — public cost + efficiency dashboards (read-only, over llm_call_log + trinity_tasks).
app.use('/api/v1', costsRouter);
app.use('/api/v1', efficiencyRouter);
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

// S-SPINE — public TrustChat viral surface (leaderboard, providers, subscribe,
// referral /track, security status). Mounted BEFORE authMiddleware so they need
// no API key. /subscribe is IP-rate-limited (5/min). Referral STATS is authed
// (mounted after authMiddleware below).
const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many subscribe requests' },
  keyGenerator: (req): string => ipKeyGenerator(req.ip ?? ''),
});
app.use('/api/v1', statsRouter);
app.use('/api/v1', verticalLeaderboardRouter);
app.use('/api/v1', leaderboardRouter);
app.use('/api/v1', providersRouter);
app.use('/api/v1/subscribe', subscribeLimiter);
app.use('/api/v1', subscribeRouter);
app.use('/api/v1', referralTrackRouter);
app.use('/api/v1', securityStatusRouter);

// E2E FAUCET step — public, read-only. Points users at the PUBLIC Base-Sepolia faucets and
// lets them confirm their own balance is enough to stake. No key custody, no writes, no tx.
// Mounted BEFORE authMiddleware so new users (who have no API key yet) can reach it.
app.use('/api/v1', faucetRouter);

// T0.5 agent gate (email OTP + run metering status). Mounted BEFORE
// authMiddleware for the same reason as the faucet: brand-new visitors
// have no API key yet. See src/services/email-otp.ts.
app.use('/api', agentGateRouter);

app.use(authMiddleware);

// Just-culture confession path. Mounted AFTER authMiddleware deliberately: an
// unauthenticated confession endpoint would let anyone charge anyone else a penalty,
// turning a mechanism for honesty into a griefing primitive.
// (The read-only /repid/confession-preview inside this router is harmless either way.)
app.use('/api/v1', repidConfessRouter);

app.use('/api', llmRouter);

app.use(rateLimitMiddleware);
app.use(versioningMiddleware);

// A2A NEGOTIATION (2026-07-31): RFQ -> sealed bids -> bounded counter-rounds
// -> single atomic award.
//
// MOUNT ORDER IS LOAD-BEARING. This sits AFTER authMiddleware on purpose. It was
// briefly mounted up with the marketplace routers, which are deliberately
// PRE-auth so the public /market page can read them with no key — that left
// every negotiation endpoint unauthenticated, and a live probe with a
// deliberately bogus key got the router's own error instead of a 401. An
// unbound caller could have bid as anyone, which is the one thing that makes a
// bid non-repudiable.
app.use('/api/v1/negotiation', negotiationRouter);
// Rung 0 of the TrustMarket ladder: keyless, anonymous discovery. A reputation surface
// behind an API key is not a public reputation surface.
app.use('/api/v1/market', marketDiscoverRouter);
app.use('/api/v1', v1Router);
// CC1 2026-05-26: productivity-stack observability (cost/spend data) — authed (post-authMiddleware).
app.use('/api/v1/observability', productivityRouter);
// SPRINT_CC_EGRESS_AND_RESILIENCE B0/B5 — per-surface health-bus + ANFIS routing intake.
// GET /api/v1/resilience/health (read-only; auth-if-enabled) · POST /api/v1/resilience/route (authed).
app.use('/api/v1', resilienceRouter);
app.use('/api/v1', receiptsRouter);
// TrustMarket ratings (2026-08-07): POST /ratings (authed — a rater has a key) and
// GET /ratings/:agentId (public, bypassed in authMiddleware). A rating is admitted
// only if it anchors to a real, gate-authorized outcome the rater is party to; see
// services/rating-ingestion.ts. Persists to repid_ratings (migrations/repid_ratings.sql).
app.use('/api/v1', ratingsRouter);
// S-WIRE-MVP — agent-facing API over the eight new ecosystem tables (authed, post-authMiddleware).
app.use('/api/v1', mvpApiRouter);
// S-SPINE — referral stats dashboard (authed: requires a valid REPID_API_KEY / service role).
app.use('/api/v1', referralStatsRouter);
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
// CC1 Round 12 (2026-05-27): replaced the Round-3 deny-list + min_decisions
// approach with an explicit canonical-provider ALLOW-LIST. The default
// response now returns the three canonical real providers (`anthropic`,
// `groq`, `openai`) sorted by most-recent activity descending — even if
// their last_decision is old or their volume is sparse. The honest "LLM
// trust leaderboard" framing on the landing surfaces that openly via
// absolute dates + a footnote disclosing that activity reflects real
// usage (sparse rows = the system is newly accumulating).
//
// Why the change: Round 3's defaults (min_decisions=10, 30-day staleness
// filter) silently squashed the response to a single row (anthropic),
// which made the landing's "Live trust scores" card look like it was
// reporting on a one-provider universe.
//
// Defaults:
//   - lowercase(llm_provider) MUST be in CANONICAL_PROVIDERS — this
//     automatically excludes 'test-harness'/'diagnostic-test'/'manual'/
//     'test' AND case-dup capitalized legacy rows ('Anthropic',
//     'OpenAI', 'Google') without separate deny-list entries
//   - merges casing duplicates by lowercasing (Round 3 logic kept)
//   - sorts by last_decision DESC (most-recent first)
// Opt-outs preserved for ops debugging:
//   - ?include_test=true     → adds test/diagnostic/manual providers
//   - ?include_all=true      → also returns case-dup capitalized rows
//                              (alongside their lowercase canonical merge)
//   - ?min_decisions=N       → restore an explicit threshold (default 1)
const CANONICAL_LLM_PROVIDERS = new Set(['anthropic', 'groq', 'openai', 'llama-3-2-1b', 'gemma-3-2b', 'phi-4']);
const TEST_LLM_PROVIDERS = new Set(['test-harness', 'diagnostic-test', 'manual', 'test']);

app.get('/api/v1/llm-trust', async (req, res) => {
  const { data, error } = await db.from('llm_trust_leaderboard').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const includeTest = String(req.query.include_test ?? '').toLowerCase() === 'true';
  const includeAll = String(req.query.include_all ?? '').toLowerCase() === 'true';
  const minDecisions = Math.max(1, Number(req.query.min_decisions ?? 1) || 1);

  const filtered = (data ?? []).filter((row: any) => {
    const provider = String(row.llm_provider ?? '').trim();
    if (!provider) return false;
    const lc = provider.toLowerCase();
    if (TEST_LLM_PROVIDERS.has(lc) || /^test/i.test(lc)) {
      return includeTest;
    }
    return includeAll || CANONICAL_LLM_PROVIDERS.has(lc);
  });

  // Canonicalize provider name (lowercase) and merge case-sensitive duplicates
  // (e.g. "openai"/"OpenAI"). Round 3 logic preserved. Group key: (lowercased
  // provider, model). Sum totals; recompute trust_score_pct / hallucination_rate /
  // avg_certainty as weighted averages on total_decisions.
  type Agg = {
    llm_provider: string;
    llm_model: string | null;
    total_decisions: number;
    hallucinations_caught: number;
    trust_score_pct_num: number;
    avg_certainty_num: number;
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

  // For the LANDING leaderboard, we want one entry per provider (not per
  // provider+model), so collapse models down to the provider-level row.
  // Each provider's headline row is the merged total across all of its models.
  const byProvider = new Map<string, Agg>();
  for (const row of merged.values()) {
    const cur = byProvider.get(row.llm_provider) ?? {
      llm_provider: row.llm_provider,
      llm_model: null, // headline row is provider-level
      total_decisions: 0,
      hallucinations_caught: 0,
      trust_score_pct_num: 0,
      avg_certainty_num: 0,
      agents_using_max: 0,
      last_decision: null as string | null,
    };
    cur.total_decisions += row.total_decisions;
    cur.hallucinations_caught += row.hallucinations_caught;
    cur.trust_score_pct_num += row.trust_score_pct_num;
    cur.avg_certainty_num += row.avg_certainty_num;
    cur.agents_using_max = Math.max(cur.agents_using_max, row.agents_using_max);
    if (row.last_decision) {
      if (!cur.last_decision || new Date(row.last_decision).getTime() > new Date(cur.last_decision).getTime()) {
        cur.last_decision = row.last_decision;
      }
    }
    byProvider.set(row.llm_provider, cur);
  }

  const out = Array.from(byProvider.values())
    .filter((a) => a.total_decisions >= minDecisions)
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
    .sort((a, b) => {
      // Most-recent activity descending (per Sean's Round 12 spec).
      const at = a.last_decision ? new Date(a.last_decision).getTime() : 0;
      const bt = b.last_decision ? new Date(b.last_decision).getTime() : 0;
      if (bt !== at) return bt - at;
      // Tie-break: more decisions wins.
      return b.total_decisions - a.total_decisions;
    });

  return res.json(out);
});

app.use(healthRouter);
app.use(healthExtendedRouter);
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
      // S-CACHE — establish + verify the DragonflyDB cache connection on startup (graceful: a
      // failure logs a warning and the cache stays a no-op; it never blocks boot).
      const c = getCache();
      if (c) {
        c.ping()
          .then(() => console.log('[dragonfly] connected (cache layer active)'))
          .catch((err: any) => console.warn('[dragonfly] not available, cache disabled:', err?.message ?? err));
      }
    } else {
      console.log('[Redis] Running in fallback mode - cache + persistent rate limiting disabled');
    }

    // Score monitor Task 8
    // L0 gate 0.4 — scoreMonitor is imported, so it is wrapped here rather
    // than gated internally; it writes trinity_agent_logs on every tick.
    setInterval(async () => {
      if (await shouldParkForHalt(db, 'scoreMonitor')) return;
      await scoreMonitor();
    }, 300000);

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
  // L0 gate 0.4 — this UPDATEs trinity_tasks back to 'pending'. Gated inside
  // the function, not at the setInterval, because it is ALSO invoked once at
  // boot; gating only the schedule would leave that call live during a halt.
  if (await shouldParkForHalt(db, 'checkStalledAndAlert')) return;
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
  // L0 gate 0.4 — this performs a FINANCIAL state transition
  // (service_contracts -> 'escrowed') every 60s and is default-ON with no
  // env flag. It must not run through an active halt.
  if (await shouldParkForHalt(db, 'processCascadeQueue')) return;
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
if (!IS_TEST && process.env.ENGINE_WORKERS_ENABLED !== 'false') {
  feedbackLoopWorker.start(60_000);
}

// A3 — boot-time HAL family-independence audit. Logs the live provider→family map and loudly
// flags any collapse (two providers sharing a base model count as ONE quorum vote, not two).
if (!IS_TEST) {
  try {
    const { assertFamilyIndependenceAtBoot } = require('./hal/fact-check');
    assertFamilyIndependenceAtBoot();
  } catch (e: any) {
    console.error('[hal] family-independence audit failed at boot:', e?.message ?? e);
    if (process.env.HAL_STRICT_FAMILY_INDEPENDENCE === 'true') throw e;
  }
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

// x402 Settlement Recovery Worker (W2 2026-06-08) — the COLD MODULE behind the ERC-8004
// dormancy. startRecoveryWorker() existed but was never called in bootstrap, so rows in
// x402_settlement_failures were never retried → no fresh *_settled events reached the
// (already-started) FeedbackLoopWorker → ~5 days of no on-chain reputation writes despite
// a PRESENT writer key. Mounted here, RULE-8-guarded (re-entrancy + catch in the worker).
// OFF unless X402_RECOVERY_WORKER_ENABLED=true (house style: zero change at merge; Sean flips).
if (!IS_TEST && process.env.X402_RECOVERY_WORKER_ENABLED === 'true') {
  const intervalMs = Number(process.env.X402_RECOVERY_POLL_MS ?? 30000);
  startRecoveryWorker({ pollIntervalMs: intervalMs });
  console.log(`[x402-recovery] recovery worker started (poll ${intervalMs}ms)`);
}

// x402 DEFERRED-RELEASE retry (2026-08-02) — self-heal for a delivered contract
// whose payment release failed. Distinct from the recovery worker above: that
// one re-settles the old inbound-tip flow, this one drives releaseHeldPayment so
// the atomic single-broadcast claim is honoured, then finalizes through the same
// path /satisfy uses. Default OFF; 'shadow' reports what it would do.
if (!IS_TEST) {
  startReleaseRetryWorker();
}

// STATUS DIGEST — daily status + alerts to Telegram. In-process rather than via the
// cron endpoint because repid_telemetry_snapshots shows exactly ONE cron_trigger
// row ever (2026-05-26): no external scheduler is pulling those triggers, so wiring
// the digest to one would ship a report that never arrives. Idempotent across
// restarts via the same snapshot table. Default OFF.
if (!IS_TEST) {
  startStatusDigest();
}

// HEALTH PROBE (2026-08-11) — the only PROCESS liveness signal in the system. Every other
// surface is derived from work an agent CHOSE to do, so none can tell "idle but healthy" from
// "gone" — which is how v_fleet_truth reported 12 healthy agents as dead while three answered
// HTTP 200. In-process rather than a Railway cron because this service is always on anyway, so
// a timer costs nothing where a cron spins ~144 containers/day. Default OFF
// (HEALTH_PROBE_ENABLED); honours the L0 halt; re-entrancy guarded; can never break a request.
if (!IS_TEST) {
  startHealthProbeWorker();
}

// EAS Anchor Worker (2026-07-04) — anchors the 21,960 real, un-anchored Plonky3
// proofs (is_real=true AND eas_attestation_uid IS NULL) to Base Sepolia EAS in
// merkle batches, and anchors new real proofs on a schedule. Reuses the merkle
// aggregation (src/zkp/merkle-root) + easService (src/services/eas-attestation-
// service); no new crypto. Writing the uid back advances system_liveness_v's
// eas_anchoring lane. OFF unless EAS_ANCHOR_WORKER_ENABLED=true AND the attester
// key is present — with no key it degrades loudly and does not start (Sean flips
// the flag + provides the funded key, then runs backfill). Never fires on-chain
// at merge (house style: zero change at merge).
if (!IS_TEST) {
  const easAnchorIntervalMs = Number(process.env.EAS_ANCHOR_POLL_MS ?? 300000); // 5 min default
  easAnchorWorker.start(easAnchorIntervalMs);
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
  // L0 gate 0.4 — read + notify. Gated for consistency; the halt banner is
  // itself the signal an operator wants, and hitl-notification-dispatcher
  // remains the deliberately-exempt human-notification path.
  if (await shouldParkForHalt(db, 'dailyHealthAlert')) return;
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
  // L0 gate 0.4 — writes hal_antifragility_metrics.
  if (await shouldParkForHalt(db, 'runHAEEEpoch')) return;
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
  // L0 gate 0.4 — this SENDS AN ON-CHAIN TRANSACTION (anchorDailyRoot posts
  // a Merkle root to Base Sepolia) and is unconditional. An emergency halt
  // that does not stop an on-chain writer is not an emergency halt.
  if (await shouldParkForHalt(db, 'runDailyAuditAnchor')) return;
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
import { startHitlReconciliationJob } from './services/hitl-reconciliation-job';
import { DisputeResolutionWorker } from './workers/dispute-resolution-worker';

startValidationWorker();
startHitlExpirationJob();
// Closes out validation_queue rows stranded in 'processing' by an EXPIRED hitl
// request (the expiration job flips the request; nothing reconciled the queue
// row → /health counted them as pending forever). Shadow-first; mutates only
// under HITL_RECONCILE_MODE=enforce. Not started in tests (zero test-runtime change).
if (!IS_TEST) startHitlReconciliationJob();

if (!IS_TEST && process.env.ENGINE_WORKERS_ENABLED !== 'false') {
  startTrinityTaskBridge();
  startPeerVerificationReader(db);
}

// Phase 2.11 — Dispute Resolution Worker
const disputeWorker = new DisputeResolutionWorker();
disputeWorker.start();

export { processCascadeQueue };
export default app;
