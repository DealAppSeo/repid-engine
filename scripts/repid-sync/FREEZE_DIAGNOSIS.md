# trinity_repid "freeze" — diagnosis (S-SPINE Phase 1)

Date: 2026-06-02 · evidence: live Supabase (`qnnpjhlxljtqyigedwkb`) + code.

## TL;DR — the premise is half-right, and the prescribed fix is wrong

> Sprint premise: *"trinity_repid is frozen 5 months → RepID reads stale data → unfreeze it."*

**RepID is NOT frozen.** The canonical source (`repid_agents.current_repid` + the append-only `repid_score_events`) is **live** — last write `2026-06-02 02:51 UTC` (today), 49,018 score events. The engine reads/writes those, never `trinity_repid`.

**`trinity_repid` IS frozen — deliberately.** It is a decommissioned legacy archival table. **Do not unfreeze it.** Doing so would (a) violate the existing hard guard in `src/services/reputation/repid-sync-aggregator.ts` (`assertTrinityRepidReadOnly()` throws `READ_ONLY_ARCHIVAL_VIOLATION` on any write), (b) reintroduce known test pollution (`test-agent-v11` @ 10000 RepID), and (c) contradict decision D-055.

So Phase 1 is **verification + documentation**, not a write. No change was made to `trinity_repid`.

## Evidence

| Fact | Value |
|---|---|
| `trinity_repid` object type | BASE TABLE (not a view/matview) |
| `trinity_repid` rows / last update | 9 rows / **2025-12-27** (~5 mo ago) |
| `trinity_repid` shape | `agent, score, primary_virtue, tasks_completed, tasks_verified, healing_contributions, sabbath_reflections, truth_choices, updated_at` — a **virtue/heartbeat tracker**, not a RepID mirror |
| `trinity_repid` agents | `APM, EVO, GCM, HDM, MCP, MEL, TORCH, VERITAS, W3C` — 9 legacy uppercase codenames, all score `50.00` |
| Do those map to `repid_agents`? | **No** — 0/9 match by name. They are not in the live 92-agent economy. |
| `repid_agents` rows / last_updated | 92 / **2026-06-02 02:51 UTC** (today); 15 updated since May 25 |
| `repid_score_events` rows / last | 49,018 / **2026-06-02 02:50 UTC** (today) |
| Code reads of `trinity_repid` in `src/` | **none** except the read-only guard |

## What actually serves stale data

Two **monitoring views** join the frozen table for a vestigial `repid_score` column:
- `trinity_agent_summary` — `trinity_heartbeat h LEFT JOIN trinity_repid r ON h.agent = r.agent`, exposes `r.score AS repid_score, r.primary_virtue, r.tasks_completed`.
- `trinity_infection_status` — same join, exposes `r.score AS repid_score, r.primary_virtue`.

These are **heartbeat/health dashboards for the 9 legacy codenamed agents**, not the RepID API. Their `repid_score` is decorative and stale, but it does not feed scoring, the `/api/v1/repid/*` reads, or the leaderboard (which reads `trustchat_sessions`). Because the 9 codenames don't exist in `repid_agents`, there is **nothing live to repoint them to** — a fix here would mean dropping the dead column, not sourcing fresh data.

## Flag state (verified in code)

- `WRITER_DIRECT_APPLY` defaults **true** (`!== 'false'`) at all 6 writer sites (`repid-update.ts`, `pipeline.ts` ×2, `agents-external.ts`, `challenge.ts`, `repid-earning.ts`, `substance-gate-writer.ts`) → writers apply `current_repid` directly = today's live behavior. ✅
- `REPIDSYNC_APPLY` defaults **false** (`repid-sync-aggregator.ts:86`) → the aggregator is dry-run/un-cutover, as intended; it is NOT the cause of any freeze (it never wrote `trinity_repid` and explicitly refuses to). ✅

## Recommendation

1. **Leave `trinity_repid` archival.** It is correctly frozen; the guard and D-055 should stand. No unfreeze.
2. **RepID is already live** — no action needed for the scoring path. Verified consistent: `repid_agents` and `repid_score_events` advance together in real time.
3. **Optional cleanup (Sean's call):** the `repid_score` column in `trinity_agent_summary` / `trinity_infection_status` is dead legacy data. Either drop it from those views or annotate it as "legacy, not RepID". Design-only here — these are production views; not changed in this sprint.
4. If a consumer genuinely needs per-agent live RepID, source it from `repid_agents.current_repid`, never `trinity_repid`.
