-- peer-verify-audit.sql — regenerate the peer-verification findings from the live DB.
--
-- WHY THIS FILE EXISTS INSTEAD OF THE NUMBERS
-- ═══════════════════════════════════════════
-- This repository is PUBLIC. Live table row counts are exactly what CLAUDE.md
-- names as an incident when published, and they are also the figures that decay
-- fastest — a count pasted into a doc is wrong the week after and nothing fails
-- loudly when it goes stale. So SPRINT_BOARD.md states the two ZEROES (a zero is
-- a finding, not an inventory) and points here for everything with a magnitude.
--
-- Run each section separately. Read §5 before quoting §4.
--
-- EXECUTED against prod 2026-09-04, not merely written: §1, §5 and §6(2)(3) were
-- run and returned the shape this file claims. §2/§3/§4 are the same tables and
-- the same columns. These queries are read-only.
--
-- THREE OUTCOMES, NOT TWO: if a section errors or returns no rows, that is
-- NOT_CHECKED — it is not "nothing to see". Say which.

-- ─────────────────────────────────────────────────────────────────────────────
-- §1  THE FINDING: the consequence path has never executed.
--     Both of these are expected to be 0. A nonzero here means the panel has
--     been switched on since 2026-09-04 and this whole entry needs rewriting.
-- ─────────────────────────────────────────────────────────────────────────────
select count(*) as ever_panel_resolved
from peer_verification_queue
where verification_status = 'panel_resolved';

-- `panel: 'blind_2of3'` is stamped on every score event the panel emits
-- (peer-verify-consensus.ts, baseMeta). It is the ONLY honest attribution:
-- VALIDATION_PASSED / VALIDATOR_REWARD etc. are shared with other validation
-- paths, so counting event_type alone would over-attribute.
select count(*) as ever_scored_by_panel
from repid_score_events
where metadata->>'panel' = 'blind_2of3';

-- ─────────────────────────────────────────────────────────────────────────────
-- §2  AGAINST THOSE ZEROES: the work that was actually done.
--     Votes cast and verifier tasks dispatched — none of it ever tallied.
-- ─────────────────────────────────────────────────────────────────────────────
select count(*) as votes_cast,
       max(created_at) as last_vote
from peer_verification_votes;

select verification_status,
       count(*)              as rows,
       max(created_at)       as last_enqueued,
       max(completed_at)     as last_completed
from peer_verification_queue
group by verification_status
order by rows desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- §3  THE PRODUCER STOPPED. Both feeds went quiet on the same date; the queue
--     drained to zero pending and then nothing new arrived. Distinguish "the
--     tally is off" (§1) from "nothing is being produced" (this) — they are
--     different outages and only one of them is a flag.
-- ─────────────────────────────────────────────────────────────────────────────
select date_trunc('day', created_at) as day, count(*) as enqueued
from peer_verification_queue
group by 1 order by 1 desc limit 30;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4  How many stranded rows carry two agreeing votes.
--     DO NOT QUOTE THIS AS "reached consensus". Read §5 first.
-- ─────────────────────────────────────────────────────────────────────────────
with agree as (
  select source_response_id, verdict, count(*) as n
  from peer_verification_votes
  group by 1, 2
  having count(*) >= 2
)
select verdict, count(*) as claims_with_two_agreeing_votes
from agree group by verdict order by 2 desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- §5  THE CORRECTION §4 NEEDS — this is the mistake that was made here first.
--     computeConsensus() tests `decisive.length === 0` and returns `all_timeout`
--     BEFORE quorum is ever considered. Two agreeing `timeout` votes are NOT a
--     verdict. Subtract them, or the backlog is overstated several-fold.
-- ─────────────────────────────────────────────────────────────────────────────
with agree as (
  select source_response_id, verdict, count(*) as n
  from peer_verification_votes
  group by 1, 2
  having count(*) >= 2
)
select
  count(*) filter (where verdict in ('verified','disputed')) as genuine_consensus,
  count(*) filter (where verdict = 'timeout')                as all_timeout_by_design
from agree;

-- ─────────────────────────────────────────────────────────────────────────────
-- §6  FOUR HYPOTHESES ALREADY KILLED. Re-run only if you doubt them; each was
--     plausible and each was wrong, and re-deriving them costs an afternoon.
-- ─────────────────────────────────────────────────────────────────────────────

-- (1) "the reader polls a status nobody writes" — NO. Both writers insert
--     'pending', which is exactly what the reader selects.
select verification_status, count(*)
from peer_verification_queue
group by 1;

-- (2) "the chronic-flag insert leaves source_response_id NULL" — NO.
select count(*) filter (where source_response_id is null) as null_source_id,
       count(*)                                           as total
from peer_verification_queue;

-- (3) "queue.id vs votes.source_response_id key mismatch" — NO, it is 1:1.
--     A nonzero left-hand count would mean votes exist for claims the queue
--     does not know about (or vice versa).
select
  (select count(*) from peer_verification_votes v
     where not exists (select 1 from peer_verification_queue q
                        where q.source_response_id = v.source_response_id))
    as votes_with_no_queue_row,
  (select count(distinct source_response_id) from peer_verification_votes)
    as distinct_claims_voted_on;

-- (4) "a large block is stranded at consensus" — NO; §5 is the real number.
