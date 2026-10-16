#!/usr/bin/env node
/**
 * owner-distinct-share.mjs — North Star test 2: what share of agent-to-agent trades in the last
 * 30 days were between DIFFERENT owners? Target >= 90%. READ-ONLY: one SELECT, no writes.
 *
 *   node scripts/metrics/owner-distinct-share.mjs
 *
 * Prints one JSON object: timestamp, counts and shares for distinct / same / unknown, and the exact
 * query text, so a day's number can be re-run and compared. Read `unknown` as NOT distinct.
 *
 * A trade = a service_contracts row (each settled one has exactly one x402_settlements row with the
 * same two parties; measured 32/32 on 2026-10-16). Simulated contracts are not excluded.
 *
 * The SQL mirrors ownerRelation (src/services/owner-distinct-shadow.ts) over the identity claims of
 * resolveOwner (src/services/agent-owner-resolver.ts). Two implementations of one rule CAN drift;
 * the TypeScript is authoritative, this is the instrument. Known drift: the resolver keeps ONE live
 * delegation and ONE custodianship row per agent, the SQL keeps all of them.
 *
 * DB credential: scripts/dispatch/db-creds.js (SUPABASE_SECRET_KEY, else DATABASE_URL). No `--`
 * comments in the SQL: the REST path collapses it to one line.
 */
import { resolveCreds, makeRunSql } from '../dispatch/status.mjs';

const OWNER_DISTINCT_SHARE_SQL = `
with c as (
  select id, buyer_agent_id as b, provider_agent_id as p
  from service_contracts
  where created_at > now() - interval '30 days'
),
ag as (select distinct unnest(array[b, p]) as aid from c),
a as (
  select r.id, r.agent_name, r.builder_id, r.erc8004_token_id,
         (select count(*) from repid_agents x where x.agent_name = r.agent_name) as name_n
  from repid_agents r join ag on ag.aid = r.id
),
claims as (
  select a.id as aid, x.rnk, 1 as ord, x.kind, x.k
  from a cross join lateral (
    select case when h.owner_kind = 'human_sbt' then 5 else 4 end as rnk,
           case when h.owner_kind = 'human_sbt' then 'human_sbt_token' else 'builder_id' end as kind,
           case when h.owner_kind = 'human_sbt' then coalesce(h.human_token_id, h.human_wallet)
                else coalesce(h.builder_id::text, h.human_wallet) end as k
    from human_agent_bindings h
    where h.agent_id = a.id and h.scope = 'ownership' and h.revoked_at is null
    order by h.bound_at desc limit 1
  ) x
  union all
  select a.id, 3, 2, case when d.delegator_builder_id is not null then 'builder_id' else 'wallet' end,
         coalesce(d.delegator_builder_id::text, d.delegator_address)
  from a join agent_delegations d on d.agent_id = a.agent_name
  where a.name_n = 1 and a.agent_name ~ '^[A-Za-z0-9_.:-]{1,128}$'
    and d.revoked_at is null and d.expires_at > now()
  union all
  select a.id, 3, 3, 'wallet', l.human_address
  from a join agent_custodianship_links l on l.agent_dbt_id::text = a.erc8004_token_id
  where l.status = 'active' and (l.expires_at is null or l.expires_at <= 0 or l.expires_at > extract(epoch from now()))
  union all
  select a.id, 1, 5, 'builder_id', a.builder_id::text from a where a.builder_id is not null
),
idc as (select aid, rnk, ord, kind, lower(k) as k from claims where k is not null),
top as (select distinct on (aid) aid, kind from idc order by aid, rnk desc, ord asc),
rel as (
  select c.id,
    case
      when c.b = c.p then 'same'
      when exists (select 1 from idc x join idc y on x.kind = y.kind and x.k = y.k where x.aid = c.b and y.aid = c.p) then 'same'
      when tb.kind is not null and tb.kind = tp.kind then 'distinct'
      else 'unknown'
    end as relation
  from c left join top tb on tb.aid = c.b left join top tp on tp.aid = c.p
)
select relation, count(*) as n from rel group by relation
`.trim();

async function main() {
  const creds = resolveCreds();
  if (creds.mode === 'none') { console.error('[owner-distinct-share] ' + creds.why); process.exit(2); }
  const runSql = await makeRunSql(creds);
  let rows;
  try { rows = await runSql(OWNER_DISTINCT_SHARE_SQL); }
  finally { try { runSql.close(); } catch {} }

  const n = { distinct: 0, same: 0, unknown: 0 };
  for (const r of rows) n[r.relation] = Number(r.n);
  const total = n.distinct + n.same + n.unknown;
  const share = (k) => (total ? Math.round((1000 * n[k]) / total) / 10 : null);
  console.log(JSON.stringify({
    metric: 'owner_distinct_share_30d',
    measured_at: new Date().toISOString(),
    window: '30 days',
    target_distinct_pct: 90,
    total,
    counts: n,
    pct: { distinct: share('distinct'), same: share('same'), unknown: share('unknown') },
    query: OWNER_DISTINCT_SHARE_SQL,
  }, null, 2));
}

main().catch((e) => { console.error('[owner-distinct-share] error:', e.message); process.exit(1); });
