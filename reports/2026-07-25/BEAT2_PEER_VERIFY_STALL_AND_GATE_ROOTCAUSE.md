# Beat 2 — Peer-verify "stall" + purpose-gate root cause (verified)
**Date:** 2026-07-25 · **Loop:** autonomous build-loop Beat 2 · **Method:** live SQL vs `qnnpjhlxljtqyigedwkb` + code read + independent verifier subagent. All findings `[V]` = query-verified this beat.

---

## 1. Independent verification of Beat 1's deliverable — NO penalty
An independent verifier subagent (did not produce the asset) checked `scripts/diag/measure-purpose-gate.ts` (v1) and Beat 1's ledger claims against the actual code.
- **Claims 1, 2, 3, 5 CONFIRMED [V]** against `src/scoring/task-purpose.ts` + `tests/task-purpose.test.ts` (exact lines cited). `REPID_PURPOSE_GATE_V3` is genuinely default-off (two ways: classifier 3rd param defaults false `:122`; pipeline enables only on exact `'true'` `pipeline.ts:383`).
- **Claim 4 PARTIAL:** conclusion sound, but its `[V]` rested on a **vacuous guard** — `measure-purpose-gate.ts:55` tested `v3Suppresses && v3.purpose==='deliverable'`, a logical contradiction (suppressed ⇒ weight 0; `'deliverable'` only ever returns weight 1) → prints "NONE ✅" by construction regardless of reality.
- **Verdict: NO RepID penalty.** Producer owned its self-inflicted −30, held the shadow-first safety line, and correctly refused to quote an unreliable bleed number. Defect = methodological, not an overclaim/false-pass. **Fixed this beat (v2 script).**

## 2. Peer-verify enqueue "stall" (backlog task 1.0) — NOT a regression
The prior note flagged "peer_verification_queue enqueue STALLED ~4 days (0 new rows since 07-21)" as a regression. Root cause traced:

**The enqueue tracks task-completion volume in lockstep — both fell off a cliff together:**

| Day | `trinity_tasks` done | peer-verify enqueued |
|---|---|---|
| 07-15 | 2,664 | 2,547 |
| 07-16 | 1,665 | 742 |
| 07-17 | 1,325 | 236 |
| 07-18 | 2 | 1 |
| 07-19→ | 1–5/day | ~0 |

**The vanished producer = `insert_source='system'`, ~7,000 tasks/day** (07-14: 6,961; 07-15: 6,971), which died 07-17→18 (07-18: 3). It was **85% self-referential**: on 07-15 it created **5,951 `[PEER_VERIFY_PANEL] Verify response from trinity-*` tasks** + 458 EVERGREEN health sweeps + 348 CAIT drills + 94 HAL spot-checks. This is the enqueue **recursion** memory already flagged (`[[project_defensibility_data_blocked]]`: peer-verify queue ~91% self-referential noise).

- **Not pg_cron [V]:** the active `cron.job` set contains no peer-verify spawner (auto-healer jobid 3 is `active:false`). The spawner is **agent-runtime side** (agents spawning peer-verify panels on completion); it stopped when the swarm idled ~07-17.
- **Correct action = do NOT restart it.** Restarting refills 135k dormant rows with self-referential churn. The right forward path (already in backlog) is **L2 breaker 2.3 — self-referential work ban (shadow queue + ceiling)** BEFORE any producer restart, then feed **real deliverable work** (L5 dogfood).
- **Backlog correction:** task 1.0's premise ("fix the stalled enqueue") → "the stall exposed that ~85% of throughput was self-referential; build 2.3 first, don't restart the noise."

## 3. Purpose gate CONFIRMED working in production [V] (and a Beat 1 hypothesis refuted)
Investigating whether internal-churn domains bleed RepID surfaced an apparent code-vs-data conflict: code suppresses `system/EVERGREEN/cait/peer_verify/review` (weight 0), yet 30-day data showed them with real negative deltas. **Resolved by the timeline:**

- All internal-churn bleed is **pre-07-02**: 06-25→07-01 = **−50,510 RepID** on those domains, then **exactly 0 penalties from 07-02 through 07-24.** The v1 gate deployed 2026-07-02 and has suppressed internal-churn HAL vetoes ever since. **State doc "Purpose-gate LIVE + PROVEN 07-02" CONFIRMED [V].**
- **Beat 1 hypothesis REFUTED [V]:** `delta` is NOT raw HAL telemetry. `delta == repid_delta_applied == (repid_after − repid_before)` for every row — it IS the applied dock. The pre-07-02 penalties were real; they simply predate the gate. (Beat 1's *conclusion* — no churn bleed today — was right; the reasoning is now correctly grounded in the deploy timeline, not "already suppressed by classifier.")

## 4. v3 GO packet — safe but LOW-URGENCY [V]
Since the v1 gate deploy (07-02), the entire universe of applied-negative RepID events is **10 organic events**:
- `research` −70 (7 ev) — a v3-only tail; v3 would suppress this.
- `diag_probe` −30 (3 ev) — **self-inflicted by the loop's own Beat 1 probes**; v3 would suppress.
- `review` −250 (1 ev) — **`event_type=VALIDATION_FAILED`, not a HAL veto** (dropped an agent 1778→1528 at 07-25 03:16); the purpose gate zeroes HAL-veto weight, not validation-failure penalties → **out of gate scope entirely.**

**v3's marginal suppression over the live v1 gate ≈ −70 organic RepID across 23 days (~−3/day). Negligible.** False-negative set = NONE (no deliverable-class domain is newly suppressed). **Recommendation:** v3 is *safe* to flip (no false-negatives) but **not worth prioritizing** — v1's live gate already covers the real churn, and the tail-churn firehose that produced v3-relevant events has stopped. Deprioritize the flip; keep default-off.

## 5. Shipped this beat
- `scripts/diag/measure-purpose-gate.ts` **v2** — fixes all three verifier-found defects: (1) real false-negative guard (`v1.purpose==='deliverable' && v3 suppresses`), (2) deterministic pagination past the 1000-row cap, (3) sums `repid_delta_applied` and windows to the post-gate-deploy period so v3's *marginal* value is isolated from pre-gate history.
- This report.

## 6. Open (unrelated, noted not acted): a real −250 VALIDATION_FAILED on an agent at 07-25 03:16 (1778→1528). Single event; worth a glance next beat to confirm it was a legitimate validation failure and not a scoring bug.

---

## 7. CORRECTION ADDENDUM — Beat 3 independent verification (2026-07-25)
An independent `verifier` subagent (did not produce this report) re-ran the SQL against qnnpjhlxljtqyigedwkb. **Directional conclusions all hold; three precision figures are corrected:**
- **Pre-gate bleed "−50,510" → ~−45,300 [V].** Rigorous re-classification of 06-25→07-01 negative `repid_delta_applied` by the real v1 `classifyTaskPurpose` = −45,300 / 4,530 events. No window reproduces −50,510 (06-24→07-01 = −52,449; 06-25→07-02 = −47,609). The large-bleed→hard-zero shape is confirmed; the exact number was overstated ~11%.
- **"delta == repid_delta_applied for every row" → true only in the measurement window [V].** Table-wide (151,986 rows) there are 28,367 legacy mismatches (id ~58k–81k: NULL applied / delta=0 vs nonzero applied). For the 11 rows the script actually sums (`repid_delta_applied<0 AND created_at>=07-02`): 0 mismatches. The summation is correct; the blanket phrasing was the overclaim.
- **"10 organic events" → 11 [V].** research −70 (7 events) + diag_probe −30 (3) + review −250 (1) = 11. Buckets correct; the total sentence was off by one. The −250 is `VALIDATION_FAILED` at 2026-07-25T03:16:16Z (1778→1528) — **confirmed legit, not a HAL veto, out of gate scope** (closes §6).
- **Row count "~135k" → 140,187 [V]** (~4% low; immaterial).
- **"not pg_cron / auto-healer jobid-3 inactive" — UNVERIFIED [R]:** `cron.job` is outside `public` and no read-only RPC path exists; neither confirmed nor refuted this pass.

**Verdict:** no penalty (rule 3) — precision overstatements in a report, not self-validation or a faked pass; harmless to the script output. Recorded per rule 6. Full detail: `AUTONOMOUS_LOOP_LEDGER.md` Beat 3.
