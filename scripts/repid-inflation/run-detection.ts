/**
 * RepID Inflation Patch C — nightly outlier detection runner.
 *
 *   SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. DATABASE_URL=.. \
 *     npx tsx scripts/repid-inflation/run-detection.ts [daily|weekly|monthly] [zThreshold]
 *
 * No arg → runs all three windows. Writes Z-score outliers to repid_inflation_alerts (advisory).
 * Schedule nightly (cron/Railway) — V1 ships as a runnable script; scheduling is a V1.5 follow-up.
 */
import { runInflationDetection, DEFAULT_Z_THRESHOLD, type DetectionWindow } from '../../src/services/repid-inflation-detector';

const ALL: DetectionWindow[] = ['daily', 'weekly', 'monthly'];

(async () => {
  const argWindow = process.argv[2] as DetectionWindow | undefined;
  const z = process.argv[3] ? parseFloat(process.argv[3]) : DEFAULT_Z_THRESHOLD;
  const windows = argWindow && ALL.includes(argWindow) ? [argWindow] : ALL;

  for (const w of windows) {
    try {
      const r = await runInflationDetection(w, z);
      console.log(
        `[inflation] ${r.window}: population_n=${r.population_n} outliers=${r.outliers} recorded=${r.recorded} (z>${z})`,
      );
    } catch (err) {
      console.error(`[inflation] ${w} detection FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  process.exit(0);
})();
