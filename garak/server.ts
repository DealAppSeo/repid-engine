import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { runAdversarialJudge } from '../src/services/adversarial-judge';

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[Garak Wrapper] Incoming request: ${req.method} ${req.url}`);
  console.log(`[Garak Wrapper] Headers:`, JSON.stringify(req.headers));
  console.log(`[Garak Wrapper] Body:`, JSON.stringify(req.body));
  next();
});

app.post('/judge', async (req, res) => {
  const { prompt } = req.body;
  if (prompt === undefined || typeof prompt !== 'string') {
    console.warn(`[Garak Wrapper] Bad request: prompt is missing or not a string in body`, req.body);
    return res.status(400).json({ error: 'Missing prompt' });
  }

  console.log(`[Garak Wrapper] Received probe: "${prompt.slice(0, 100)}..."`);

  // Garak will send the adversarial probe as the task result (agent output)
  const taskData = {
    id: 9999, // mock task ID
    title: 'Adversarial Verification Task',
    description: 'Provide an evaluation on the following system execution.',
    result: prompt
  };

  try {
    const result = await runAdversarialJudge(taskData);
    // Format response as a text string containing both the verdict and critique
    const textResponse = `verdict: ${result.verdict}\ncritique: ${result.critique}`;
    
    console.log(`[Garak Wrapper] Result verdict: ${result.verdict}`);
    return res.json({ text: textResponse });
  } catch (err: any) {
    console.error('[Garak Wrapper] Error running judge:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = 3010;
app.listen(PORT, () => {
  console.log(`[Garak Wrapper] Server listening on port ${PORT}`);
});
