-- event-link-check.sql: does each ERC-8004 write cite the event that caused it?
-- Read-only. Paste into the Supabase SQL editor. Every query is a SELECT.
--
-- erc8004_reputation_writes.repid_event_id is a foreign key to repid_events (the outbox row the
-- writer drained), NOT to repid_score_events. Both tables use bigint ids in the same range, so a
-- join to the wrong one returns rows, and they look plausible. That wrong join is what produced
-- the 2026-11-16 alarm: "the writes cite RepID events from 2026-05-04". They do not.

-- 1. THE TRAP. Joins on the wrong table. Shows May-4 dates for recent writes.
select w.id, w.created_at as write_at, w.repid_event_id, se.created_at as wrong_table_row_at
from erc8004_reputation_writes w
join repid_score_events se on se.id = w.repid_event_id
where w.created_at > now() - interval '30 days'
order by w.id desc limit 5;

-- 2. THE REAL LINK. Follows the foreign key. Expect, for the last 30 days: every write joins,
--    the event is service_fulfilled_settled, its contract_id equals the write's, and it was
--    created minutes before the write. (2026-11-16: 29 of 29, max lag 10 min 23 s.)
select count(*) as writes,
  count(*) filter (where e.id is not null) as joined,
  count(*) filter (where (e.event_data->>'contract_id') = w.contract_id::text) as contract_matches,
  count(*) filter (where e.created_at <= w.created_at) as event_before_write,
  max(w.created_at - e.created_at) as max_lag
from erc8004_reputation_writes w
left join repid_events e on e.id = w.repid_event_id
where w.created_at > now() - interval '30 days';

-- 3. THE VALUE ON CHAIN = THE SCORE THE SETTLEMENT PRODUCED. For each write, the latest live
--    (non-shadow) repid_score_events row for the same agent and contract. Expect repid_value =
--    live_after on every row. (2026-11-16: 29 of 29.)
select w.id, w.repid_value,
  (select se.repid_after from repid_score_events se
    where se.contract_id = w.contract_id and se.agent_id = w.agent_id and se.is_shadow is not true
    order by se.created_at desc limit 1) as live_after
from erc8004_reputation_writes w
where w.created_at > now() - interval '30 days'
order by w.id desc;

-- 4. THE DEFECT THIS PR FIXES. One event written on chain twice. Expect 0 rows after the fix;
--    2026-11-16 shows one pair: event 1564 on 2026-07-08, once with no contract_id (the inline
--    trigger) and once with it (FeedbackLoopWorker), 4 s apart.
select w.repid_event_id, count(*) as writes, min(w.created_at), max(w.created_at),
  count(*) filter (where w.contract_id is null) as without_contract
from erc8004_reputation_writes w
where w.repid_event_id is not null
group by 1 having count(*) > 1;
