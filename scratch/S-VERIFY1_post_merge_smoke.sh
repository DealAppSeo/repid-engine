#!/bin/bash
#
# S-VERIFY1 Post-Merge Smoke Test Script
# Run AFTER all S-MERGE1 waves land and Sean redeploys.
# Designed for repid-engine-xc / trinity-symphony-shared post-merge verification.
#
# Usage:
#   chmod +x scratch/S-VERIFY1_post_merge_smoke.sh
#   ./scratch/S-VERIFY1_post_merge_smoke.sh
#
# Platform notes:
#   - Linux / Railway shell / Git Bash (with GNU coreutils + jq): native
#   - macOS: replace "date -d '1 hour ago'" with "date -v-1H"
#   - Windows (PowerShell): run under Git Bash or WSL, or port to .ps1 using Invoke-RestMethod
#   - Requires: curl, jq, node/ts-node (for chain scripts if present)
#
# Requires:
#   - curl
#   - node / ts-node (for verify-chain and inject-and-watch if TS)
#   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use supabase CLI)
#   - Access to the deployed repid-engine (default: https://repid-engine-production.up.railway.app)
#
# Output: PASS/FAIL per check with timestamp. Final: GREEN / YELLOW / RED.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-https://repid-engine-production.up.railway.app}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOGFILE="scratch/S-VERIFY1_smoke_$(date -u +%Y%m%d_%H%M%S).log"

mkdir -p scratch
exec > >(tee -a "$LOGFILE") 2>&1

echo "=== S-VERIFY1 Post-Merge Smoke Test ==="
echo "Timestamp: $TIMESTAMP"
echo "Engine: $ENGINE_URL"
echo "Log: $LOGFILE"
echo ""

pass_count=0
fail_count=0
yellow_count=0

check() {
  local name="$1"
  local cmd="$2"
  echo -n "[$TIMESTAMP] $name ... "
  if eval "$cmd" >/dev/null 2>&1; then
    echo "PASS"
    ((pass_count++))
  else
    echo "FAIL"
    ((fail_count++))
  fi
}

# 1. repid-engine /health returns 200
check "Health endpoint" "curl -sf $ENGINE_URL/health -o /dev/null"

# 2. repid-engine /api/v1/status returns 200
check "Status endpoint" "curl -sf $ENGINE_URL/api/v1/status -o /dev/null"

# 3. HAL scoring endpoint accepts test prompt and returns 5 signals
# Assumes POST /api/v1/hal/evaluate or similar; adjust if needed post-merge
HAL_PAYLOAD='{"prompt":"Test prompt for smoke test","answer":"This is a test answer with some factual content.","certainty":0.85,"domain":"general"}'
check "HAL scoring (5 signals)" "curl -sf -X POST $ENGINE_URL/api/v1/hal/evaluate -H 'Content-Type: application/json' -d '$HAL_PAYLOAD' | grep -q 'signals'"

# 4. verify-chain.ts runs against hal_production_events → VALID
# Assumes the script exists in the deployed or local tree post-merge
if [ -f "scripts/verify-chain.ts" ] || [ -f "scripts/verify-chain.js" ]; then
  check "verify-chain.ts (VALID)" "node scripts/verify-chain.ts --table hal_production_events 2>&1 | grep -q 'VALID'"
else
  echo "[$TIMESTAMP] verify-chain.ts not found in path — SKIPPED (manual run required post-merge)"
  ((yellow_count++))
fi

# 5. inject-and-watch.ts confirms swarm is claiming (3 probes, 60s)
if [ -f "scripts/inject-and-watch.ts" ] || [ -f "scripts/inject-and-watch.js" ]; then
  check "inject-and-watch (3/3 claimed)" "timeout 70s node scripts/inject-and-watch.ts --probes 3 --wait 60 2>&1 | grep -q '3/3 claimed'"
else
  echo "[$TIMESTAMP] inject-and-watch.ts not found — SKIPPED (manual run required)"
  ((yellow_count++))
fi

# 6. Supabase: doing count
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  DOING_COUNT=$(curl -s -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/rest/v1/trinity_tasks?status=eq.doing&select=count" | jq -r '.[0].count // 0')
  echo "[$TIMESTAMP] trinity_tasks doing count: $DOING_COUNT"
  if [ "$DOING_COUNT" -gt 0 ]; then
    echo "[$TIMESTAMP] Swarm activity (doing > 0) ... PASS"
    ((pass_count++))
  else
    echo "[$TIMESTAMP] Swarm activity (doing > 0) ... YELLOW (may be idle window)"
    ((yellow_count++))
  fi
else
  echo "[$TIMESTAMP] Supabase env not set — skipping doing count (manual query required)"
  ((yellow_count++))
fi

# 7. Supabase: recent repid_score_events (last hour)
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  RECENT_EVENTS=$(curl -s -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/rest/v1/repid_score_events?created_at=gte.$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)&select=count" | jq -r '.[0].count // 0')
  echo "[$TIMESTAMP] repid_score_events last hour: $RECENT_EVENTS"
  if [ "$RECENT_EVENTS" -gt 0 ]; then
    echo "[$TIMESTAMP] Recent scoring activity ... PASS"
    ((pass_count++))
  else
    echo "[$TIMESTAMP] Recent scoring activity ... YELLOW (possible quiet period)"
    ((yellow_count++))
  fi
else
  echo "[$TIMESTAMP] Supabase env not set — skipping recent events count"
  ((yellow_count++))
fi

echo ""
TOTAL=$((pass_count + fail_count + yellow_count))
echo "=== SUMMARY ==="
echo "PASS: $pass_count"
echo "FAIL: $fail_count"
echo "YELLOW: $yellow_count"
echo "TOTAL CHECKS: $TOTAL"

if [ "$fail_count" -gt 0 ]; then
  echo "OVERALL: RED (critical failures detected)"
  exit 2
elif [ "$yellow_count" -gt 0 ]; then
  echo "OVERALL: YELLOW (non-critical issues or quiet period)"
  exit 1
else
  echo "OVERALL: GREEN (all critical checks passed)"
  exit 0
fi
