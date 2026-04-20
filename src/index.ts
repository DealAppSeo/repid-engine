import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import validator from 'validator';
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
import telegramRouter, { sendTelegramAlert } from './routes/telegram';
import { db } from './db';

import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware, checkRedisStatus } from './middleware/rateLimit';
import { versioningMiddleware } from './middleware/versioning';
import { scoreMonitor } from './engine/score-monitor';

import rateLimit from 'express-rate-limit';

const app = express();

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                     // 10 registrations/hour/IP
  message: { error: 'Too many registrations' },
  skip: (req) => {
    return req.headers['x-enterprise-key'] === process.env.ENTERPRISE_API_KEY;
  }
});

const scoreLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 100,                    // 100 score events/min
  keyGenerator: (req): string => String(req.params.id || req.ip || ''),
});
app.use(helmet());
app.use(cors({ origin: ['https://trustrepid.dev', 'https://repid.dev', 'http://localhost:3000'] }));
app.use(express.json({ limit: "1mb" }));

// Sanitize POST validator
app.use((req, res, next) => {
  if (req.method === 'POST') {
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
  }
  next();
});

app.use(authMiddleware);
app.use(rateLimitMiddleware);
app.use(versioningMiddleware);

app.use('/api/v1', v1Router);

// v11 external agent endpoints
app.use('/api/v1/agents/register', registrationLimiter);
app.use('/api/v1/agents/:id/score-event', scoreLimiter);
app.use('/api/v1/agents', agentsExternalRouter);
app.use('/api/v1/telegram', telegramRouter);

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
app.use(bountiesRouter);
app.use(hashkeyRouter);
app.use(mirrorTestRouter);
app.use(halStatsRouter);

const port = parseInt(process.env.PORT || '3000', 10);
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
setInterval(checkStalledAndAlert, 60*60*1000);
checkStalledAndAlert();

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
const now = new Date();
const next6am = new Date(now);
next6am.setUTCHours(6,0,0,0);
if (next6am <= now) next6am.setUTCDate(next6am.getUTCDate()+1);
setTimeout(()=>{
  dailyHealthAlert();
  setInterval(dailyHealthAlert, 24*60*60*1000);
}, next6am.getTime()-now.getTime());

export default app;
