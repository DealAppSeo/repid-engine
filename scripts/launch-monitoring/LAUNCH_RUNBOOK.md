# Launch Runbook — First Hour (CC1, 2026-05-25)

Companion to `launch-watch.sh`. Verified surfaces (deploy #39, 2026-05-25 06:26Z): `/health` 200, `/api/v1/status` 200, `/api/v1/receipts/hero` 200, `/prove-repid` unauth 401, forged attestation 400.

## What to monitor in real time
1. `bash scripts/launch-monitoring/launch-watch.sh` in a dedicated terminal (endpoint-based; set `DATABASE_URL` for the deeper 5-min DB view).
2. Optional: `scripts/launch-monitoring/dashboard.html` open in a browser (auto-refresh every 30s).
3. GitHub Insights → traffic; Railway logs → no error spikes; npm download stats; LinkedIn/X comments.

## Expected (NORMAL) — first hour
- 1–10 GitHub stars; 0–5 npm installs; 0–2 API-key requests.
- **0 real USDC settlements** (no self-serve key flow yet → no paid contracts; CC2 #32).
- `/status` `metrics_24h` steady; `last_heartbeat` recent IF enabled (see Caveats); `audit_status` clean/absent.
- Keyless `trustshell whois <id>` works for anyone.

## Concerning (INVESTIGATE)
- API-key requests > 20/hr → possible bot abuse; check rate limiting.
- `/repid/verify` 400 spike → check sanitizer (base64url `--` bypass is live as of #35) + signing-key behavior.
- `/prove-repid` 500 spike → Plonky3 prover health.
- Bridge stalls (no new attestations despite fulfillments) → FeedbackLoopWorker logs.

## CRITICAL (RESPOND IMMEDIATELY)
- `/health` or `/status` ≠ 200 → service down → check Railway deploy/logs; redeploy last-good.
- `/prove-repid` unauth returns 200/202 → DoS guard regressed → re-check #31 mount.
- Forged attestation returns `valid:true` → trust layer broken → take `/repid/verify` offline, page Gemini.
- Audit probe FAIL (`npm run audit-probe`) → integrity violation → freeze on-chain writes, investigate.
- Any **real** USDC settlement on a contract that shouldn't move money → halt, investigate (mainnet not yet enabled; testnet only).

## Response procedures
- **Service down:** Railway → Deployments → roll back to last ACTIVE (#39 = known-good); confirm `/health` 200.
- **Security regression:** the 2 hardening fixes live = #31 (forged-attestation + /prove-repid auth) and #35 (sanitizer base64url bypass). If either regresses, identify the offending deploy and roll back.
- **Integrity violation:** `npm run audit-probe -- --report-only` for detail; do NOT auto-fix; surface to Sean.

## Communication plan
- LinkedIn/X comments: respond within ~30 min during the first hour; lead with the verifiable hero receipt (`/api/v1/receipts/hero` → Basescan links).
- GitHub issues: triage within ~2h. Security reports: acknowledge within 24h.
- Don't promise specific timelines under pressure (mainnet, features).

## ⚠️ Caveats to know before launch (from CC1 verification)
- **Heartbeat + audit-probe are NOT yet scheduled/enabled** (telemetry table applied, but `HEARTBEAT_ENABLED`/`AUDIT_PROBE_ENABLED` + Railway cron pending — D-028/D-029). Until then `/status.last_heartbeat` + `audit_status` are null; run `npm run audit-probe` manually if needed. Heartbeat also needs a dedicated `HEARTBEAT_PROVIDER_AGENT_ID` (sim fulfillments grant real RepID — Gemini fix pending).
- **No self-serve API-key flow** (CC2 #32) → outside devs can `whois` but not `verify`/`pay`. Expected friction, not a bug.
- **Mainnet is NOT enabled** — testnet (Base Sepolia) only. Value caps + RPC failover not yet implemented (V1.5).
- **Hero receipt** is served from a verified constant; the DB `tx_hash` backfill (D-021) is still pending but does not affect the endpoint.
