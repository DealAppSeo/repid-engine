import express from 'express';
import cors from 'cors';
import { config } from './config';
import healthRouter from './routes/health';
import agentsRouter from './routes/agents';
import scoreRouter from './routes/score';
import referendumRouter from './routes/referendum';
import bountiesRouter from './routes/bounties';
import hashkeyRouter from './routes/hashkey';
import mirrorTestRouter from './routes/mirror-test';
import challengeRouter from './routes/challenge';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use(agentsRouter);
app.use(challengeRouter);   // Sprint 5: must come before scoreRouter (conflicting /challenge)
app.use(scoreRouter);
app.use(referendumRouter);
app.use(bountiesRouter);
app.use(hashkeyRouter);
app.use(mirrorTestRouter);

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`[repid-engine] v${config.version} running on port ${port} (0.0.0.0)`);
  console.log(`[repid-engine] Environment: ${config.nodeEnv}`);
});

export default app;
