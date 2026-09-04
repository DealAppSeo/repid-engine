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
