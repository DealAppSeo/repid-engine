-- repid-ledger-audit.sql
-- The audit behind scripts/repid-recompute.mjs, as plain SQL.
--
-- WHY A SQL COPY EXISTS. The .mjs needs a service key. Most sessions here hold
-- the documented dummy credentials, and node's global fetch ignores HTTPS_PROXY,
-- so the script correctly reports NOT_CHECKED and stops. These queries run over
-- any ordinary SQL connection, which is the path that actually exists. If the
-- two ever disagree, the script is the one that writes -- fix the script.
--
-- Everything below was MEASURED 2026-09-04. Expected results are inline so a
-- drift is visible without re-deriving the reasoning. Re-run before quoting any
-- of it: these are readings with a date, not constants.
--
-- READ-ONLY. Nothing here writes.

-- ---------------------------------------------------------------------------
-- 1. Is `delta` evidence that a score moved?  No.
--    `repid_after - repid_before` is the row's own claim about a movement.
--    Expected 2026-09-04: the two agree exactly (-252,990) for the defect class,
--    which is why an earlier draft that quoted -475,618 was wrong under every
--    predicate the guard uses -- it had summed the TRUE positives in with them.
-- ---------------------------------------------------------------------------
select coalesce(hal_decision, '(null)')                                    as decision,
       case when hallucination_caught is null then '(null)'
            else hallucination_caught::text end                            as caught,
       count(*)                                                            as rows,
       sum(delta)                                                          as sum_delta,
       sum(repid_after - repid_before)                                     as sum_row_movement
from repid_score_events
where event_type = 'HAL_SCORE_EVENT'
group by 1, 2
order by rows desc;
-- vetoed/true  -> true positives, correct penalties
-- vetoed/false -> THE DEFECT CLASS
-- flagged/*    -> delta 0. `flagged` has never docked a score.

-- ---------------------------------------------------------------------------
-- 2. Nor is a before/after pair evidence. Ask what the NEXT event OBSERVED.
--    A row claiming `after = before - 10` whose successor reads `before` back
--    unchanged describes a write that never reached repid_agents.
--    Expected: evaporated 21,276 (-212,760) vs stuck 4,014 (-40,140).
--    84% of the recorded damage never landed.
-- ---------------------------------------------------------------------------
with o as (
  select repid_before, repid_after,
         lead(repid_before) over (partition by agent_id order by created_at, id) as next_before
  from repid_score_events
  where repid_before is not null and repid_after is not null
    and event_type = 'HAL_SCORE_EVENT'
    and hal_decision = 'vetoed' and hallucination_caught = false
)
select case when next_before is null        then 'no successor'
            when next_before = repid_after  then 'stuck'
            when next_before = repid_before then 'evaporated'
            else                                 'other' end as fate,
       count(*)                        as rows,
       sum(repid_after - repid_before) as movement
from o
where repid_after <> repid_before
group by 1
order by rows desc;

-- ---------------------------------------------------------------------------
-- 3. The defect class has a start and an end. It is not an ongoing bleed.
--    Expected: every penalty that moved a score is May 2026. June disarms it
--    (vetoed/false rows persist at delta 0 while true positives appear); July
--    onward has none at all.
-- ---------------------------------------------------------------------------
select date_trunc('month', created_at)::date                                     as month,
       count(*) filter (where hal_decision='vetoed' and hallucination_caught=false) as fp_rows,
       sum(delta) filter (where hal_decision='vetoed' and hallucination_caught=false) as fp_delta,
       count(*) filter (where hal_decision='vetoed' and hallucination_caught=true)  as true_positives
from repid_score_events
where event_type = 'HAL_SCORE_EVENT'
group by 1 order by 1;

-- ---------------------------------------------------------------------------
-- 4. Ledger self-consistency, by month. This is the one to re-run.
--    `apply_repid_score_event` now sets repid_before/repid_after from the
--    UPDATE's own RETURNING -- what landed, not what was asked for -- so the
--    clamp identity should hold for every new row.
--    Expected: 82% broken in May, 19% in June, then 1 row in 39,644 from July
--    on. A rising count here means a writer is bypassing the trigger again
--    (it returns early when the caller pre-sets `repid_delta_applied`).
-- ---------------------------------------------------------------------------
select date_trunc('month', created_at)::date as month,
       count(*)                              as rows,
       count(*) filter (
         where repid_after is not null
           and repid_after <> greatest(10, least(10000,
                 repid_before + coalesce(repid_delta_applied, delta, 0)))
       )                                     as breaks_clamp_identity
from repid_score_events
group by 1 order by 1;

-- ---------------------------------------------------------------------------
-- 5. THE VERDICT. Per agent: does replaying the recorded movements land on
--    current_repid, and does that agent carry any false-positive penalty?
--    Expected: eligible_and_affected = 0. The set that can be defensibly
--    rewritten and the set that was harmed do not intersect, so the recompute
--    proposes nothing. That is the finding, not a failure to find one.
--
--    This is the heavy query in the file -- three window functions over the
--    whole ledger. It has been seen to hit a short statement timeout on a
--    pooled connection and succeed on a direct one. A timeout is NOT_CHECKED;
--    do not record it as "no eligible agents".
-- ---------------------------------------------------------------------------
with o as (
  select agent_id, repid_before, repid_after,
         row_number() over (partition by agent_id order by created_at desc, id desc) as rrn,
         lag(repid_after) over (partition by agent_id order by created_at, id)       as prev_after,
         (event_type = 'HAL_SCORE_EVENT'
          and hal_decision in ('flagged','vetoed')
          and hallucination_caught = false)                                          as fp
  from repid_score_events
  where repid_before is not null and repid_after is not null
),
agg as (
  select agent_id,
         count(*) filter (where prev_after is not null and prev_after <> repid_before) as breaks,
         max(repid_after) filter (where rrn = 1)                                       as last_after,
         count(*) filter (where fp and repid_after < repid_before)                     as fp_n,
         coalesce(sum(repid_after - repid_before)
                  filter (where fp and repid_after < repid_before), 0)                 as fp_moved
  from o group by agent_id
),
j as (
  select a.*, g.current_repid,
         (a.breaks = 0 and a.last_after = g.current_repid) as reconciles
  from agg a left join repid_agents g on g.id = a.agent_id
)
select count(*)                                             as agents_with_events,
       count(*) filter (where reconciles)                   as reconciling,
       count(*) filter (where fp_n > 0)                     as affected,
       count(*) filter (where reconciles and fp_n > 0)      as eligible_and_affected,
       coalesce(sum(fp_moved) filter (where reconciles), 0) as movement_recoverable
from j;

-- ---------------------------------------------------------------------------
-- 6. Clusters the ledger does not explain, kept because they are the reason
--    step 5's reconciling set is small. Several groups of agents share one
--    score, a peak_repid equal to it, and a last_updated of 2026-06-16 --
--    while their own events record values several times higher. peak_repid is a ratchet
--    (`greatest(new, old, current)`), so a peak that LOW cannot be the residue
--    of those events; it was written directly.
--
--    Do not read this as "someone did something wrong". It is a June 2026 batch
--    normalisation of load-test agents, outside the ledger, before the applier
--    trigger was the single writer. It matters only as evidence that
--    repid_agents has been written outside repid_score_events -- so the audit
--    log is not, historically, a complete record of score changes. Step 4 is
--    what tells you whether that is still true.
-- ---------------------------------------------------------------------------
select current_repid, peak_repid, floor_override,
       count(*)                as agents,
       min(last_updated)::date as first_updated,
       max(last_updated)::date as last_updated
from repid_agents
group by 1, 2, 3
having count(*) > 5
order by agents desc;

-- ---------------------------------------------------------------------------
-- 7. WHERE THE [10, 10000] CLAMP IS ACTUALLY ENFORCED, because three source
--    files name the wrong thing.
--
--    `src/testing/redteam-adjudication.ts`, `src/testing/t12-e2e-proof.ts` and
--    `src/testing/red-team.ts` each write current_repid directly as
--    `Math.max(0, ...)` and comment that the earned-floor trigger enforces the
--    floor. It does not. `trg_repid_earned_floor` enforces
--    `tier_lower_bound(peak_repid)` -- a RATCHET that returns 0 / 500 / 1000 /
--    5000 / 8000, so for a low-peak agent its floor is 0, not 10. It also never
--    caps: it only ever raises a value.
--
--    The real enforcement point is a CHECK constraint on the table:
--        repid_agents_current_repid_check
--        CHECK (current_repid >= 10 AND current_repid <= 10000)
--
--    This is good news and it is why those three files were left alone. A
--    harness that drives an agent past either end does not silently write an
--    out-of-range score -- the UPDATE raises 23514 and the run dies. It fails
--    CLOSED. The `Math.max(0, ...)` is a clamp that does not do what it says,
--    but the database refuses the write it would have allowed, so it is a
--    latent crash and not a data-integrity hole. Do not "fix" it expecting to
--    close a live risk; there is not one.
--
--    The transferable part: the invariant lives in ONE place that all writers
--    pass through, and neither the app code nor the trigger the comments cite
--    is that place. Before trusting a comment about where a rule is enforced,
--    ask the catalog.
-- ---------------------------------------------------------------------------
select conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'repid_agents'::regclass
  and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%current_repid%';

-- ---------------------------------------------------------------------------
-- 8. THE SIGNAL MIX: RepID is STARVED, not mis-tuned [MEASURED 2026-09-04].
--
--    The question this answers: "HAL is ~99% of scoring events and has awarded
--    almost nothing in reward -- are the earning paths broken?" No. Three
--    separate investigations each ended in "working as designed":
--
--    (a) THE TARIFF ISN'T THE PROBLEM. 9 of the engine's 11 positive-reward
--        event types (REFERRAL, CODE_CONTRIBUTION, SELF_MONITOR, TOOL_PIONEER,
--        AUDIT_CONTRIBUTION, WORKFLOW_CONTRIBUTION, HANDOFF_COSIGN_VERIFIED,
--        STAKE, and the deception classes) have NEVER produced a row. They are
--        reachable only by an agent self-reporting to POST /api/v1/score, which
--        the engine itself flags as unproven and self-awardable. Turning them on
--        would be a minting surface, not a fix.
--
--    (b) THE REWARD CURVE IS CORRECT. `npm run repid:sim` (real computeDelta +
--        deriveHalDecision): clean pays +3.00 at risk 0.00 falling to +1.40 at
--        risk 0.388, monotone, ZERO violations. The 2026-08-17 orientation fix
--        (hal_score is RISK, the clean branch consumes QUALITY) holds.
--
--    (c) THE PREFERENCE ARBITRAGE IS NOT LIVE. The simulator measures a
--        user-settable flag threshold worth +73 RepID on identical work. No such
--        knob reaches scoring: `deriveHalDecision` hardcodes 0.40 and takes no
--        threshold argument, the veto threshold comes from a server-side config
--        row, and `repid_agents.risk_tolerance` is read by NO code. It is a
--        design warning about a feature not yet shipped. Do not report it as a
--        live hole -- but re-run the greps before shipping a risk-tolerance knob.
--
--    WHAT IS ACTUALLY TRUE: the purpose gate (symmetric, default ON, correct)
--    refuses to score work that is not a deliverable, in BOTH directions -- and
--    almost nothing flowing through HAL is a deliverable. Since 2026-07-01:
--
--        peer_verify   19,029   48.6%     applied 0
--        operational   10,370   26.5%     applied 0
--        drill          7,085   18.1%     applied 0
--        monitoring     1,144    2.9%     applied 0
--        DELIVERABLE       81    0.21%    applied -305
--
--    81 events out of 39,135, and the LAST ONE WAS 2026-08-17. The system is
--    overwhelmingly evaluating itself. No weight change fixes that; deliverable
--    traffic does.
--
--    AND THE FIX HAS NO LIVE WITNESS. Deliverable traffic stopped the same day
--    the orientation fix landed, so the corrected curve has never scored a real
--    deliverable. Its 27 clean deliverable rows (avg risk 0.197, quality ~0.80)
--    computed -3 under the OLD inverted formula where the corrected one pays
--    ~+2.2 each (~+59). VERIFIED in simulation, NOT_CHECKED in production.
--    The first real deliverable after 2026-08-17 is the observation that closes
--    it -- check it rather than assuming the fix works.
-- ---------------------------------------------------------------------------
select coalesce(metadata->>'purpose', '(legacy: no purpose recorded)') as purpose,
       count(*)                                        as rows,
       round(100.0 * count(*) / sum(count(*)) over (), 2) as pct,
       sum(repid_delta_calculated)                     as calculated,
       sum(repid_delta_applied)                        as applied,
       max(created_at)::date                           as last_seen
from repid_score_events
where event_type = 'HAL_SCORE_EVENT' and created_at >= '2026-07-01'
group by 1
order by rows desc;
