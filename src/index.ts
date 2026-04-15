import express from 'express';
import cors from 'cors';
import { config } from './config';
import healthRouter from './routes/health';
import agentsRouter from './routes/agents';
import scoreRouter from './routes/score';
import referendumRouter from './routes/referendum';
import bountiesRouter from './routes/bounties';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use(agentsRouter);
app.use(scoreRouter);
app.use(referendumRouter);
app.use(bountiesRouter);

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`[repid-engine] v${config.version} running on port ${port} (0.0.0.0)`);
  console.log(`[repid-engine] Environment: ${config.nodeEnv}`);
});

export default app;
