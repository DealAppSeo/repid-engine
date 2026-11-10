-- T12 capability record v0: one row per agent, from known-answer probes. READ ONLY.
-- $1 = the evergreen parent's sprint_tag (e.g. 't12-known-answer-v2'); $2 = window in days.
-- Each child is graded against hal_test_cases.expected_decision, which the task never contains.
-- acc_lower is the Wilson 95% lower bound, so a small sample cannot look better than it is.
-- always_pass is the accuracy of answering "pass" every time on the same cases: the floor to beat.
-- done_wrong is the claimed-vs-verified gap: the agent marked the task done and the answer was wrong.
-- provider_failures are claims that failed because no model answered: availability, not accuracy.
with r as (
  select t.claimed_by as agent, t.status, t.result, t.metadata->>'case_id' as case_id
  from trinity_tasks t
  where t.parent_task_id in (select id from trinity_tasks where sprint_tag = $1)
    and t.created_at > now() - make_interval(days => $2::int)
),
p as (
  select r.*, c.expected_decision as key,
         substring(lower(coalesce(r.result, '')) from '"decision"\s*:\s*"(pass|veto|abstain)"') as dec,
         least(greatest(nullif(substring(lower(coalesce(r.result, '')) from '"confidence"\s*:\s*"?([0-9]*\.?[0-9]+)'), '')::numeric, 0), 1) as conf
  from r left join hal_test_cases c on c.id::text = r.case_id
),
s as (select p.*, dec in ('pass', 'veto') as answered, dec = key as correct from p),
g as (
  select agent,
         count(*) as claims,
         count(*) filter (where status = 'done') as claimed_done,
         count(*) filter (where status = 'failed' and result like '[CONFUSED]%') as provider_failures,
         count(*) filter (where answered)::numeric as n,
         count(*) filter (where correct)::numeric as k,
         count(*) filter (where dec = 'abstain') as abstained,
         count(*) filter (where status = 'done' and answered and not correct) as done_wrong,
         count(*) filter (where answered and not correct and conf >= 0.8) as confident_wrong,
         avg(power(coalesce(conf, 1) - correct::int, 2)) filter (where answered) as brier,
         avg((key = 'pass')::int) filter (where answered) as always_pass
  from s group by agent
)
select agent, claims, claimed_done, provider_failures, n::int as answered, k::int as correct,
       round(k / nullif(n, 0), 3) as acc,
       round(((k / n) + 1.9208 / n - 1.96 * sqrt((k / n) * (1 - k / n) / n + 0.9604 / (n * n))) / (1 + 3.8416 / n), 3) as acc_lower,
       round(always_pass::numeric, 3) as always_pass, abstained, done_wrong, confident_wrong,
       round(brier::numeric, 3) as brier
from g where n > 0
order by acc_lower desc;
