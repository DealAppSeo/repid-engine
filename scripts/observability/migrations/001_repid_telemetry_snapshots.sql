-- Telemetry snapshots — point-in-time operational/economic/HAL/audit metrics.
-- Owner: CC1 (mainnet-readiness sprint, 2026-05-24). Schema change = Sean action (CLAUDE-RULE-2).
-- Apply in Supabase (project qnnpjhlxljtqyigedwkb) SQL editor. Additive, zero risk to existing data.
-- After apply: `ts-node scripts/observability/capture-telemetry.ts --family all` persists rows;
-- dashboard-queries.sql reads them. Until applied, the capture script dry-runs (emits JSON, no write).

CREATE TABLE IF NOT EXISTS repid_telemetry_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric_family TEXT NOT NULL,           -- 'operational' | 'economic' | 'hal' | 'audit_trail'
  metric_name  TEXT NOT NULL,
  metric_value JSONB NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_telemetry_family_time ON repid_telemetry_snapshots(metric_family, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_name_time   ON repid_telemetry_snapshots(metric_name, snapshot_at DESC);

-- No RLS: service-role only (capture script uses SUPABASE_SERVICE_ROLE_KEY). If exposed to
-- a public dashboard later, add a read-only policy for the dashboard role explicitly.
