-- Live RepID from service contracts, split by owner independence. READ ONLY.
-- $1 = window in days. Canon: same-controller evidence never verifies (D-127).
-- would_not_count = 'same_owner' marks an event that counted only because the same-owner gate is in shadow.
select e.event_type,
       coalesce(e.metadata->'owner_assurance'->>'assurance', 'unknown') as assurance,
       coalesce(e.metadata->'owner_assurance'->>'reason', 'unknown') as reason,
       coalesce(e.metadata->'same_owner_settlement'->>'would_not_count', '-') as would_not_count,
       count(*) as events,
       round(sum(coalesce(e.repid_delta_applied, e.delta, 0))::numeric, 1) as delta,
       count(*) filter (where e.settled_receipt_id is not null) as with_receipt,
       count(*) filter (where e.idempotency_key is not null) as with_idempotency_key
from repid_score_events e
where not e.is_shadow
  and e.event_type like 'SERVICE_%'
  and e.created_at > now() - make_interval(days => $1::int)
group by 1, 2, 3, 4
order by events desc;
