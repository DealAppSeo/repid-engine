# RepID Inflation Defenses (Patches C + B)

**Date:** 2026-05-23 · **Author:** CC2 · Patch A skipped (redundant once C + B in place).

## Threat model
Agents gaming `repid_agents.current_repid` for unearned tier/standing:
1. **Collusion** — a ring contracts with itself, mutually rating high to manufacture volume.
2. **Sock-puppet self-loop** — one operator drives RepID through accounts it controls.
3. **Sandbagging-then-surge** — suppress baseline, then over-deliver for outsized score jumps.

## Defense layers

### Patch C — Statistical outlier detection (SHIPPED, advisory)
- **What:** flags agents whose RepID growth in a window is a Z-score outlier vs the active population.
  Catches gaming *behavior* regardless of mechanism. **Advisory only** — writes alerts, never mutates
  score/tier.
- **History source:** `repid_score_events` (canonical). The `repid_agent_history` table assumed by the
  original spec does not exist; `agent_repid_history` is the stale `agent_repid` lineage (do not use).
  Growth = `SUM(COALESCE(repid_delta_applied, delta, 0))` over the window.
- **Population:** active agents with ≥1 score event in the window (idle 0-delta agents are excluded so
  they don't deflate the mean and inflate everyone else's Z).
- **Run:** `npx tsx scripts/repid-inflation/run-detection.ts [daily|weekly|monthly] [zThreshold]`
  (no arg → all three windows). Nightly scheduling = V1.5 follow-up.
- **Alerts:** `repid_inflation_alerts` (status `pending_review` → review). Idempotent per
  `(agent_id, detection_window, window_start)` where `window_start` is the date-truncated period bucket.
- **Review query:**
  ```sql
  SELECT a.z_score, a.repid_delta, ra.agent_name, a.detection_window, a.window_end
  FROM repid_inflation_alerts a JOIN repid_agents ra ON ra.id=a.agent_id
  WHERE a.status='pending_review' ORDER BY a.z_score DESC;
  ```

### Patch B — Counterparty gate (WRITTEN, NOT APPLIED — pending Sean greenlight)
- **What:** tier advancement requires N+ distinct delivered counterparties. Catches *structural*
  concentration. Implemented in `compute_tier(integer, uuid)` (new 2-arg overload; 1-arg untouched =
  backward compatible) with a cascading floor; activated by repointing `sync_tier()`.
- **Counterparty count:** `count_unique_counterparties(uuid)` = distinct buyers on contracts with
  `status IN ('fulfilled','satisfied','settled','resolved')` (includes disputed→resolved; the spec's
  fulfilled-only filter undercounts).
- **⚠️ Not applied:** calibration (below) shows meaningful thresholds would mass-demote the current
  population. Migration ships **zero-demotion ratchet-floor defaults** (auto/vet ≥2, est/earn ungated);
  Sean picks thresholds and applies. Activation is on every `repid_agents` write via `trg_sync_tier`.

## Calibration (2026-05-23, 30 active agents)
RepID today is earned mostly via **non-service events** (challenges, stakes, referrals, code), so
counterparty diversity is near-zero: ESTABLISHED (17 agents) median 0 / max 2; both AUTONOMOUS ≤3.
Tier-demotion impact of candidate thresholds (auto/est/earn minimums):

| threshold set | demoted / 30 |
|---|---|
| sprint (auto10 / est5 / earn3) | **25** |
| gentle (auto3 / est2 / earn1) | 19 |
| grandfather (auto2 / est1) | 10 |
| **zero-demote (auto2, est/earn ungated)** | **0** ← migration default |

Re-run anytime: `npx tsx scripts/repid-inflation/calibrate.ts`.

## Tuning
- **Z-threshold** default 3.0 (~P99.7). At the current small population (n≈12 active-in-week) one big
  earner inflates the stddev and caps its own Z (e.g. shofet delta 470 → z 2.41 < 3, not flagged).
  Consider a lower threshold (2.0–2.5) for small n, or robust stats (median/MAD) — see V1.5.
- **Counterparty thresholds** ship at the zero-demotion floor; ratchet est_min/earn_min upward
  (target auto5 / est3 / earn1) as service-contract volume grows. Re-calibrate when the population
  doubles.

## Known limitations (RULE-4)
- **C** is advisory; it surfaces, never auto-actions (false positives on legitimate rapid growth are
  for a human to dismiss). Small-n masking caps Z for the largest earner.
- **B** doesn't catch collusion *within* a sufficiently diverse counterparty pool (needs graph
  analysis — V1.5/V2). At enforce-able thresholds it would demote much of the current swarm, hence
  the ratchet posture.
- **Neither** catches the sock-puppet variant (one operator, multiple agent_ids) — needs off-chain
  identity linking (ERC-8004 identity binding / TrustEnvoy) — V2.
- Many current "agents" are HUMAN/SEAN/role accounts with 0 service counterparties; any est_min ≥1
  would demote them. Consider excluding non-provider accounts from the gate, or leave EST ungated.
