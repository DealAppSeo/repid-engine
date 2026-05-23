-- x402 metrics over last 24h (run via Supabase)
SELECT
  DATE_TRUNC('hour', created_at) AS hour,
  status,
  COUNT(*) AS settlements,
  AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) * 1000) AS avg_latency_ms
FROM x402_settlements
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour, status
ORDER BY hour DESC;
