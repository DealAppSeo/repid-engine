# FAILOVER_TARGET — the engineUrl flip seam (Phase 4)
PREP doc · 2026-06-26 · XC lane · CONTRACT only (no SDK rewrite this sprint)

## WHAT THIS DEFINES
The single source of truth for "which repid-engine is active" — the seam that an operator (or ANFIS,
GA's lane) flips to fail over from Railway to the Fly standby. The flip is a **config value change, not a
redeploy** (RTO-friendly) and has **no DNS dependency** in the fast path.

## CANONICAL FLIP KEY
`active_engine_url` — stored as a row in Supabase `trinity_system_config` (the existing system-config
table), readable by all consumers without a redeploy. Mirror it as an env override `ACTIVE_ENGINE_URL`
for clients that prefer env-based config.

- Railway (PRIMARY / default): `active_engine_url = https://<railway-repid-engine-domain>`
- Fly standby: `active_engine_url = https://repid-engine-standby.fly.dev`

## RESOLUTION ORDER (consumers resolve engine URL at call time)
1. **Explicit client override** — a value passed directly by the caller (test/integration pins).
2. **`ACTIVE_ENGINE_URL` env** — host-level override (fast operator flip without DB).
3. **`trinity_system_config.active_engine_url`** — the dynamic, no-redeploy flip surface (ANFIS/operator).
4. **Hardcoded Railway default** — final fallback so a config read failure never breaks the primary path.

> Order rationale: explicit-override beats everything (tests); env beats DB (operator hard-pin during an
> incident); DB is the normal dynamic flip (ANFIS); hardcoded Railway is the safe floor.

## CONSUMERS THAT MUST READ THIS KEY (wiring is CC/GA's lane — NOT this sprint)
| Consumer | Repo | Today | After wiring |
|---|---|---|---|
| TrustShell SDK | `DealAppSeo/trustshell` | hardcoded engineUrl | resolve via order above |
| 12 Trinity agents | `trinity-symphony-shared` | env/hardcoded REPID_API_URL | resolve via order above |
| controller-pwa | `DealAppSeo/controller-pwa` | hardcoded | resolve via order above |

## WHO WIRES WHAT (handoff)
- **CC**: SDK + agent client resolution (read order 1→4). Cache with short TTL; re-read on 5xx/timeout.
- **GA (ANFIS failover brain)**: the *decide* logic that writes `trinity_system_config.active_engine_url`
  when the detect signal (FAILOVER_RUNBOOK §DETECT) fires. This sprint exposes the **mechanism**; GA
  owns the **decision**.
- **XC (this sprint)**: defines the key, resolution order, and consumer list — the contract above.

## NON-GOALS
- No DNS cutover in the fast path (DNS is the slow fallback only).
- No SDK code changes here (contract doc only; concrete enough for CC/GA to implement).
