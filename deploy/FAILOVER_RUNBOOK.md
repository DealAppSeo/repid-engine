# FAILOVER_RUNBOOK — repid-engine Railway → Fly standby (Phase 6)
PREP doc · 2026-06-26 · XC lane · RTO target ≤ 10 min (stretch ≤ 5 min with ANFIS auto-flip)

---

## ACTIVATION GATE — READ FIRST (HARD BLOCK)
**The PRODUCTION engineUrl flip is FORBIDDEN until CC's egress poll fix is merged & deployed.**
Reason: the runaway Supabase egress is a *task-poll* problem. Flipping live traffic to the standby
before CC's fix just **relocates the burning egress bill to Fly** ("fix the fire before moving house",
RESILIENCE_ARCHITECTURE Principle 4). Until then:
- The standby may be **built, deployed IDLE, and game-day tested in an ISOLATED / throwaway window**.
- It may **NOT** be placed in any client's `active_engine_url` for production traffic.
See `deploy/FAILOVER_TARGET.md` for the flip mechanism and `SPRINT_CC_EGRESS_AND_RESILIENCE.md` (upstream).

---

## OVERVIEW — DETECT → DECIDE → ACT → RECOVER

### 1. DETECT (liveness authority = UptimeRobot, NOT DB heartbeats)
- UptimeRobot monitors Railway `repid-engine` `https://<railway-domain>/health`.
- Signal raised on **N = 3 consecutive failures** over ~45s (interval 15s × 3).
- Per RESILIENCE_ARCHITECTURE Liveness row: prefer external probes over DB-write heartbeats (removes the
  heartbeat CPU/egress load that CC is fixing). A health-drop is the signal; do NOT add new DB heartbeats.
- Optional corroboration: `flyctl` / Railway status check that the Railway machine is actually down
  (rule out a transient network blip from UptimeRobot's vantage).

### 2. DECIDE (operator or ANFIS confirms it's real, not transient)
- ANFIS (GA's lane) consumes the DETECT signal + Phase-4 flip key and confirms Railway down.
- Manual fallback: operator confirms 3+ consecutive fails AND a direct `curl` to the Railway `/health`
  also fails (not just UptimeRobot's vantage).
- Guard: do not flip on a single blip or on a Supabase-side outage that would also break the standby
  (the standby shares the same Supabase prod DB — a DB outage is NOT a Railway-compute failover case).

### 3. ACT (flip `active_engine_url` → standby — config change, no redeploy)
```
# Operator hard-pin (fastest, env-level): set ACTIVE_ENGINE_URL on each consumer surface  [SEAN/operator]
#   -> https://repid-engine-standby.fly.dev
# OR dynamic flip (ANFIS / normal path): update the Supabase config row
UPDATE trinity_system_config
  SET value = 'https://repid-engine-standby.fly.dev'
  WHERE key = 'active_engine_url';     -- consumers re-read on next call / short TTL
```
Then **VERIFY** before announcing:
```
curl -fsS https://repid-engine-standby.fly.dev/health        # expect 200 + supabaseConnected:true
# real read smoke (auth required path is fine):
curl -fsS https://repid-engine-standby.fly.dev/api/v1/repid/<known-agent-id>   # expect a RepID payload
```
- Confirm `/health` shows `supabaseConnected: true` (proves standby DB creds work).
- Confirm a real RepID read returns data (proves the standby serves, not just boots).
- Announce in the ops channel: "engineUrl flipped to Fly standby (sjc); Railway down at <ts>."

### 4. RECOVER (flip back when Railway is healthy ≥ 10 min)
```
# When Railway /health green for >= 10 continuous minutes:
UPDATE trinity_system_config
  SET value = 'https://<railway-repid-engine-domain>'
  WHERE key = 'active_engine_url';
# clear any ACTIVE_ENGINE_URL env hard-pins on consumers
# return Fly standby to idle (warm machine stays; or scale to 0 per budget call)
flyctl scale count 1 -a repid-engine-standby      # keep warm   [SEAN]
```
- RECOVER is the rollback. If the flip itself misbehaves, flipping back to Railway is instant.

---

## GAME-DAY KILL-TEST (measured RTO) — [SEAN], ISOLATED window only
**Precondition:** CC egress fix merged, OR run with traffic isolated (synthetic client only, no real
clients pointed at the engine). Stopwatch end-to-end.

1. **t0** — `flyctl` is irrelevant here; PAUSE the **Railway** repid-engine service (or stop the machine)
   to simulate the outage. Start the stopwatch at the first UptimeRobot failure.
2. Watch UptimeRobot trip after N=3 fails (~45s).
3. DECIDE (operator/ANFIS) + ACT: flip `active_engine_url` → `repid-engine-standby.fly.dev`.
4. **t1** — stop the stopwatch when a **synthetic client** gets a 200 from the standby (`/health` +
   a real RepID read).
5. Record **RTO = t1 − t0** in `E:\dev\reports\2026-06-26\XC_PORTABLE_STANDBY_REPORT.md`.
6. RESTORE: un-pause Railway, wait for green ≥10 min, flip `active_engine_url` back, return Fly to idle.

### RTO budget (target ≤ 10 min)
| Step | Budget |
|---|---|
| UptimeRobot trip (N=3 × 15s) | ~45 s |
| DECIDE (human confirm; ANFIS ~instant) | ≤ 5 min (manual) / ~5 s (ANFIS) |
| ACT (config flip) | ~5–15 s |
| VERIFY (health + real read) | ~10–30 s |
| **Total** | **≤ ~10 min manual; ≤ ~5 min with ANFIS auto-flip (GA)** |

---

## NOTES / GOTCHAS
- The standby shares the **same Supabase prod DB** as Railway → a Supabase outage is NOT a failover case
  (both would fail). Failover covers **Railway compute** loss only.
- Do NOT re-add a Railway healthcheck (repo hard-stop, commit 5b24b58). UptimeRobot is the liveness
  authority — the `/health` route is live regardless.
- Keep `ESCALATION_CONTRACT` / cascade / writer loops OFF on the standby until activation (loop revival
  is Sean-only Railway work; don't carry the loop fire to the standby).
