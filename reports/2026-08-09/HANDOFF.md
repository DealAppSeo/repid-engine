# Session handoff — 2026-08-09 (HAL/RepID ship sprint + merge queue)

Full detail: `reports/2026-08-09/HAL_REPID_SHIP_SPRINT.md` + `SUPABASE_KEY_CONSUMER_INVENTORY.md`.

## State at handoff
- **repid-engine queue drained.** 9 PRs merged earlier (#385/387/388/389/390/391/393/395/397). Then a
  merge-integration break (#389 test vs #395 statement) blocked everything → **#399 fixed it (MERGED)**.
  **#396 + #398** were red on STALE pre-#399 CI; branches updated onto fixed main + auto-merge re-armed →
  should self-land green.
- **HAL:** baseline **F1 ~0.91** rigorous-v1@596f10de18d0 holdout (strictness 2, 100% cov, ruler). Grok
  lever bug fixed (#398 — `grokApiKey()` reads XAI_API_KEY). Honest finding: NO built-in lever (grok,
  retrieval) beats the ±0.013 run-to-run noise; HAL is at a **panel-limited ceiling (~0.91)**. Real
  ceiling-lifter = a frontier model in the standing quorum (spend). Real activation = `HAL_STRICTNESS=2`
  in live scoring (defaults to blind extractor today).
- **RepID:** earned/zk-portable core + asymmetric deception penalty are real, BUT the **deception detector
  is never wired to live traffic** ("ungameable" keystone dormant). Documented + scoped, not faked.
- **Supabase legacy-key deletion: NO-GO today.** ~60 edge functions auto-inject legacy JWTs;
  trinity-symphony-shared has a hardcoded legacy anon JWT (`lib/supabase.ts:12`) + no new-key names.
- **Fleet:** `v_fleet_truth` 0/12, last write 2026-07-17 — could be the intended "kill heartbeat writes"
  change OR the RLS loop. **Not confirmed down.** Check UptimeRobot before acting.

## SEAN-ONLY (blockers)
1. Confirm #396 + #398 auto-merged (or merge if auto didn't fire).
2. ~~`HAL_STRICTNESS=2` flip~~ **DONE + VERIFIED [V sql]** — `repid_config.HAL_STRICTNESS='2'`; every
   recent prod HAL_SCORE_EVENT ran fact-check-quorum, 3-5 families, grounded vetoes. NOT pending. (My
   earlier "defaults to extractor" claim was wrong — read env default, not the DB config that wins.)
3. Enable grok override / retrieval? (cost/latency call; both default OFF, evidence in the report.)
4. Fleet: IF UptimeRobot shows trinity-* down → set `SUPABASE_SERVICE_ROLE_KEY = <the sb_secret_ value>`
   on the trinity-* services, redeploy.
5. Supabase legacy keys: do NOT revoke until go-criteria cleared (see inventory report).
6. `AGENT_KEY_MASTER`: confirm on repid-engine service + backed up, then remove from AITrinitySymphony shared.

## CLAUDE CAN DO IN PARALLEL (branch-only / read-only, no blockers)
- Run the **frontier-model-in-panel** HAL experiment (the real ceiling test) — n≥3, measure vs 0.91 baseline.
- Draft `HAL_STRICTNESS=2` as a reviewed, shadow-safe change + measurement plan for the GO.
- Scope + start the **RepID deception-detector wiring** (receipt chain + shadow detection, inert/default-OFF).
- Verify + fix the hardcoded legacy anon JWT in `trinity-symphony-shared/lib/supabase.ts` (clears one key go-criterion).
- Update `CONTENT_SAFE_FACTS` with the honest HAL number (F1 ~0.91 on rigorous-v1, with ruler).

## AFTER BLOCKERS REMOVED
- strictness-2 GO → wire in shadow, measure, then flip live.
- fleet key set → confirm RLS loop stops + v_fleet_truth non-zero.
- key go-criteria cleared → revoke legacy JWTs (service_role last).
