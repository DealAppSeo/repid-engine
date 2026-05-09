import express from 'express';
import { HALAutorunnerService } from '../hal-autorunner-service';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3004;

const runner = new HALAutorunnerService();

app.get('/health', async (req, res) => {
  const stats = runner.getStats();
  const metrics = await runner.getMetrics();
  
  // Aggregate metrics for health
  const totalTp = metrics?.reduce((sum: number, m: any) => sum + (m.tp || 0), 0) || 0;
  const totalFp = metrics?.reduce((sum: number, m: any) => sum + (m.fp || 0), 0) || 0;
  const totalFn = metrics?.reduce((sum: number, m: any) => sum + (m.fn || 0), 0) || 0;
  
  const precision = totalTp / (totalTp + totalFp) || 0;
  const recall = totalTp / (totalTp + totalFn) || 0;
  const f1 = 2 * (precision * recall) / (precision + recall) || 0;

  res.json({
    ok: true,
    status: "running",
    ...stats,
    current_f1_score: f1,
    current_precision: precision,
    current_recall: recall,
    total_metrics_rows: metrics?.length || 0
  });
});

app.get('/metrics', async (req, res) => {
  const metrics = await runner.getMetrics();
  res.json(metrics);
});

app.listen(port, () => {
  console.log(`[HAL-Autorunner] Server listening on port ${port}`);
  runner.start();
});
