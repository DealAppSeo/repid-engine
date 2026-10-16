#!/usr/bin/env node
/**
 * owner-distinct-share.mjs — North Star test 2: what share of agent-to-agent trades SETTLED in the
 * last 30 days were between DIFFERENT owners? Target >= 90%. READ-ONLY: one SELECT, no writes.
 *
 *   node scripts/metrics/owner-distinct-share.mjs
 *
 * Prints one JSON object: timestamp, the headline, counts and shares per relation x evidence, and
 * the exact query text, so a day's number can be re-run and compared.
 *
 * THE HEADLINE IS distinct_strong (XC1 review of #1429). `distinct` on ADMINISTRATIVE evidence
 * (an unsigned repid_agents.builder_id) does NOT count toward the 90% target: a test-fixture builder
 * with its own id reads as an independent owner. `unknown` is NOT distinct either.
 *
 * A trade = a service_contracts row with status = 'settled' and settled_at in the window. Each one
 * has exactly one x402_settlements row with the same two parties (32/32 on 2026-10-16). The status
 * domain is the table's CHECK: pending, escrowed, fulfilled, satisfied, settled, disputed, resolved,
 * expired, cancelled. Simulated contracts are not excluded.
 *
 * The SQL mirrors ownerRelation (src/services/owner-distinct-shadow.ts) over the identity claims of
 * resolveOwner (src/services/agent-owner-resolver.ts). Two implementations of one rule CAN drift;
 * the TypeScript is authoritative, this is the instrument. Known drift: the resolver keeps ONE live
 * delegation and ONE custodianship row per agent, the SQL keeps all of them.
 * Evidence: rnk >= 3 (binding 4/5, delegation 3, custodianship 3) is a signed claim = strong;
 * rnk 1 (builder_id) is administrative. A non-SBT binding without a builder_id is a wallet.
 *
 * DB credential: scripts/dispatch/db-creds.js (SUPABASE_SECRET_KEY, else DATABASE_URL). No `--`
 * comments in the SQL: the REST path collapses it to one line.
 */
import { resolveCreds, makeRunSql } from '../dispatch/status.mjs';

const OWNER_DISTINCT_SHARE_SQL = `
with c as (
  select id, buyer_agent_id as b, provider_agent_id as p
  from service_contracts
  where status = 'settled' and settled_at > now() - interval '30 days'
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
           case when h.owner_kind = 'human_sbt' then 'human_sbt_token'
                when h.builder_id is not null then 'builder_id' else 'wallet' end as kind,
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
top as (select distinct on (aid) aid, kind, rnk from idc order by aid, rnk desc, ord asc),
rel as (
  select c.id,
    case
      when c.b = c.p then 'same'
      when sh.n > 0 then 'same'
      when tb.kind is not null and tb.kind = tp.kind then 'distinct'
      else 'unknown'
    end as relation,
    case
      when c.b = c.p then 'strong'
      when sh.n > 0 then case when sh.strong then 'strong' else 'administrative' end
      when tb.kind is not null and tb.kind = tp.kind then
        case when tb.rnk >= 3 and tp.rnk >= 3 then 'strong' else 'administrative' end
      else 'none'
    end as evidence
  from c
  left join top tb on tb.aid = c.b
  left join top tp on tp.aid = c.p
  left join lateral (
    select count(*) as n, bool_or(x.rnk >= 3 and y.rnk >= 3) as strong
    from idc x join idc y on x.kind = y.kind and x.k = y.k
    where x.aid = c.b and y.aid = c.p
  ) sh on true
)
select relation, evidence, count(*) as n from rel group by relation, evidence
`.trim();

const BUCKETS = ['distinct_strong', 'distinct_administrative', 'same_strong', 'same_administrative', 'unknown_none'];

async function main() {
  const creds = resolveCreds();
  if (creds.mode === 'none') { console.error('[owner-distinct-share] ' + creds.why); process.exit(2); }
  const runSql = await makeRunSql(creds);
  let rows;
  try { rows = await runSql(OWNER_DISTINCT_SHARE_SQL); }
  finally { try { runSql.close(); } catch {} }

  const n = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of rows) {
    const key = `${r.relation}_${r.evidence}`;
    if (!(key in n)) throw new Error(`unexpected bucket ${key}: the SQL and this script disagree`);
    n[key] = Number(r.n);
  }
  const total = BUCKETS.reduce((s, b) => s + n[b], 0);
  const pct = (k) => (total ? Math.round((1000 * n[k]) / total) / 10 : null);
  console.log(JSON.stringify({
    metric: 'owner_distinct_share_30d',
    measured_at: new Date().toISOString(),
    window: "status = 'settled' and settled_at > now() - interval '30 days'",
    headline: {
      name: 'distinct_strong_pct',
      value: pct('distinct_strong'),
      target: 90,
      met: total > 0 && pct('distinct_strong') >= 90,
      note: 'administrative-only distinct and unknown do not count toward the target',
    },
    total,
    counts: n,
    pct: Object.fromEntries(BUCKETS.map((b) => [b, pct(b)])),
    query: OWNER_DISTINCT_SHARE_SQL,
  }, null, 2));
}

main().catch((e) => { console.error('[owner-distinct-share] error:', e.message); process.exit(1); });
