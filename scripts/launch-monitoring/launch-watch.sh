#!/bin/bash
# launch-watch.sh — first-hour-of-launch real-time monitor (CC1, 2026-05-25).
#
#   bash scripts/launch-monitoring/launch-watch.sh
#
# Endpoint-based (no DB creds needed) — polls the public surfaces every 60s and
# flags anything outside the expected launch-hour envelope. Optional deeper DB
# view if DATABASE_URL is set + psql available. Ctrl-C to stop.
set -u
BASE="${SMOKE_BASE_URL:-https://repid-engine-production.up.railway.app}"

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

while true; do
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

  # --- health ---
  H=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")
  [ "$H" = "200" ] && green "/health: 200" || red "/health: $H  ← CRITICAL (service down?)"

  # --- public status + 24h metrics ---
  S=$(curl -s "$BASE/api/v1/status")
  SC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/status")
  if [ "$SC" = "200" ]; then
    green "/api/v1/status: 200"
    echo "$S" | (command -v jq >/dev/null && jq '.metrics_24h, {last_heartbeat: .last_heartbeat.at, audit: .audit_status.overall}' || cat)
  else
    red "/api/v1/status: $SC  ← CRITICAL"
  fi

  # --- security posture spot-checks (cheap) ---
  PR=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/prove-repid" -H 'Content-Type: application/json' -d '{"agent_id":"watch"}')
  [ "$PR" = "401" ] && green "/prove-repid unauth: 401 (protected)" || red "/prove-repid unauth: $PR  ← INVESTIGATE (DoS guard)"

  # --- optional deeper DB view (5-min windows) ---
  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
    echo "--- DB activity (last 5m) ---"
    psql "$DATABASE_URL" -tA -c "SELECT
      (SELECT COUNT(*) FROM erc8004_reputation_writes WHERE created_at > NOW() - INTERVAL '5 minutes') AS attest_5m,
      (SELECT COUNT(*) FROM x402_settlements WHERE created_at > NOW() - INTERVAL '5 minutes' AND is_simulated=false) AS real_settle_5m,
      (SELECT COUNT(*) FROM repid_score_events WHERE created_at > NOW() - INTERVAL '5 minutes') AS score_5m;" 2>/dev/null || echo "(psql query skipped)"
  fi

  echo ""
  sleep 60
done
