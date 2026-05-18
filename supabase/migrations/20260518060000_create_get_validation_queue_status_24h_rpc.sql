CREATE OR REPLACE FUNCTION get_validation_queue_status_24h()
RETURNS TABLE (
  pending bigint,
  processing bigint,
  completed bigint,
  failed bigint,
  escalated bigint,
  "avgAgeSeconds" float8,
  "oldestPendingAgeSeconds" float8
)
SECURITY DEFINER
LANGUAGE sql
AS $$
  SELECT 
    COUNT(*) FILTER (WHERE status = 'pending') AS pending,
    COUNT(*) FILTER (WHERE status = 'processing') AS processing,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed,
    COUNT(*) FILTER (WHERE status = 'escalated') AS escalated,
    COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at))) FILTER (WHERE status = 'pending'), 0)::float8 AS "avgAgeSeconds",
    COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - created_at))) FILTER (WHERE status = 'pending'), 0)::float8 AS "oldestPendingAgeSeconds"
  FROM validation_queue
  WHERE created_at >= NOW() - INTERVAL '24 hours';
$$;

GRANT EXECUTE ON FUNCTION get_validation_queue_status_24h() TO anon, authenticated, service_role;
