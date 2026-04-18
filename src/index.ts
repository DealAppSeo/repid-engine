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

import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware, checkRedisStatus } from './middleware/rateLimit';
import { versioningMiddleware } from './middleware/versioning';
import { scoreMonitor } from './engine/score-monitor';

const app = express();

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

export default app;
