/**
 * RepID Inflation Patch C — statistical outlier detection (Z-score).
 *
 * Flags agents whose RepID growth in a window deviates far above the population — catching
 * inflation regardless of mechanism (collusion, sandbagging-surge, sock-puppet). ADVISORY ONLY:
 * writes to `repid_inflation_alerts` for human review; never mutates scores or tiers.
 *
 * History source: the canonical append-only log `repid_score_events` (CLAUDE-RULE-5). The sprint
 * spec assumed a `repid_agent_history` snapshot table; that does not exist, and `agent_repid_history`
 * is the stale `agent_repid` lineage (do not use). Growth = sum of applied RepID deltas in the window.
 *
 * Population for the statistics = active agents that had at least one score event in the window
 * (agents that actually moved). Including idle 0-delta agents would deflate the mean and inflate
 * everyone else's Z-score — a false-positive source. Detection is one-sided (z > +threshold): we
 * care about unusually HIGH growth, not decay.
 */
import { pgQuery } from '../db/direct-pg';

export type DetectionWindow = 'daily' | 'weekly' | 'monthly';

export interface InflationDetection {
  agent_id: string;
  repid_delta: number;
  population_mean: number;
  population_stddev: number;
  population_n: number;
  z_score: number;
  threshold: number;
  is_outlier: boolean;
}

// Controlled enum → safe to inline into SQL (never user input).
const WINDOW_INTERVAL: Record<DetectionWindow, string> = {
  daily: "INTERVAL '1 day'",
  weekly: "INTERVAL '7 days'",
  monthly: "INTERVAL '30 days'",
};
// date_trunc bucket so the idempotency key (window_start) is stable across same-period re-runs.
const WINDOW_TRUNC: Record<DetectionWindow, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

// 2.5 (not the textbook 3.0): the active-in-window population is small (n≈12), where a single
// large earner inflates the stddev enough to cap its own Z below 3 (e.g. shofet z=2.41 at Δ470).
// Sean set 2.5 for sensitivity at this scale; raise toward 3.0 as the population grows.
export const DEFAULT_Z_THRESHOLD = 2.5;

/**
 * Compute per-agent RepID growth over the window and its Z-score vs the active-in-window population.
 */
export async function detectInflationOutliers(
  window: DetectionWindow,
  zThreshold = DEFAULT_Z_THRESHOLD,
): Promise<InflationDetection[]> {
  const interval = WINDOW_INTERVAL[window];
  const rows = await pgQuery<{
    agent_id: string;
    repid_delta: string;
    pop_mean: string;
    pop_stddev: string | null;
    pop_n: string;
  }>(
    `
    WITH window_deltas AS (
      SELECT e.agent_id,
             SUM(COALESCE(e.repid_delta_applied, e.delta, 0))::numeric AS repid_delta
      FROM repid_score_events e
      JOIN repid_agents ra ON ra.id = e.agent_id AND ra.lifecycle_status = 'active'
      WHERE e.created_at >= NOW() - ${interval}
      GROUP BY e.agent_id
    )
    SELECT agent_id,
           repid_delta,
           AVG(repid_delta) OVER ()                       AS pop_mean,
           COALESCE(STDDEV_SAMP(repid_delta) OVER (), 0)  AS pop_stddev,
           COUNT(*) OVER ()                               AS pop_n
    FROM window_deltas
    `,
    [],
    { label: `inflation-detect-${window}` },
  );

  return rows.map((row) => {
    const delta = parseFloat(row.repid_delta);
    const mean = parseFloat(row.pop_mean);
    const stddev = parseFloat(row.pop_stddev ?? '0');
    // stddev=0 (uniform population) → no spread → no outliers (avoid divide-by-zero).
    const z = stddev > 0 ? (delta - mean) / stddev : 0;
    return {
      agent_id: row.agent_id,
      repid_delta: delta,
      population_mean: mean,
      population_stddev: stddev,
      population_n: parseInt(row.pop_n, 10),
      z_score: z,
      threshold: zThreshold,
      is_outlier: stddev > 0 && z > zThreshold,
    };
  });
}

/**
 * Persist outliers to repid_inflation_alerts. Idempotent per (agent, window, period bucket).
 * Returns the number of outliers (attempted inserts).
 */
export async function recordAlerts(
  detections: InflationDetection[],
  window: DetectionWindow,
): Promise<number> {
  const outliers = detections.filter((d) => d.is_outlier);
  const trunc = WINDOW_TRUNC[window];
  for (const o of outliers) {
    try {
      await pgQuery(
        `
        INSERT INTO repid_inflation_alerts (
          agent_id, detection_window, window_start, window_end,
          repid_delta, population_mean, population_stddev, z_score, threshold, metadata
        ) VALUES (
          $1, $2, date_trunc('${trunc}', NOW()), NOW(),
          $3, $4, $5, $6, $7, $8
        )
        ON CONFLICT (agent_id, detection_window, window_start) DO NOTHING
        `,
        [
          o.agent_id,
          window,
          o.repid_delta,
          o.population_mean,
          o.population_stddev,
          o.z_score,
          o.threshold,
          JSON.stringify({ population_n: o.population_n }),
        ],
        { label: `inflation-alert-insert` },
      );
    } catch (err) {
      console.error(`[repid-inflation] failed to insert alert for ${o.agent_id}:`, err);
    }
  }
  return outliers.length;
}

/**
 * Run detection + persist alerts for a window. Returns a summary for logging/reporting.
 */
export async function runInflationDetection(
  window: DetectionWindow,
  zThreshold = DEFAULT_Z_THRESHOLD,
): Promise<{ window: DetectionWindow; population_n: number; outliers: number; recorded: number }> {
  const detections = await detectInflationOutliers(window, zThreshold);
  const recorded = await recordAlerts(detections, window);
  return {
    window,
    population_n: detections[0]?.population_n ?? 0,
    outliers: detections.filter((d) => d.is_outlier).length,
    recorded,
  };
}
