---
name: supabase-trinity
description: "Use BEFORE any Supabase work on the Trinity / HyperDAG stack — writing or reviewing an RLS policy, choosing a key or client helper, reading or writing repid_agents / repid_score_events / ai_dispatch, touching tier logic, or answering 'is this table safe to expose'. Also use when you meet the words anon, service_role, sb_publishable_, sb_secret_, RLS, compute_tier, counterparty gate, agent_repid, repid_standings, or legacy JWT. This encodes THIS project's measured facts, which differ from generic Supabase guidance and from what the vendor skill covers."
metadata:
  version: 1.0.0
  measured: 2026-09-09
---

# Supabase, on this project

Generic Supabase guidance is not wrong here — it is **insufficient**. The
`supabase-postgres-best-practices` vendor skill mentions RLS three times and
`service_role` / `anon` **zero** times, and the keys-vs-roles conflation below is
the single most re-litigated fact in this codebase. That gap is why this exists.

**Every claim here carries its re-run query. Run it; do not cite this file.**
A fact with a date is a measurement, not a guarantee — and a *negative* finding
("nothing reads that") decays fastest, because anyone can add the reader without
touching this file.

Project ref: `qnnpjhlxljtqyigedwkb`. There is **no staging copy.**

---

## 1. KEYS ARE NOT ROLES — read this before writing any policy

The keys were replaced. **The roles were not.** Both halves are true at once:

| | old | new | status |
|---|---|---|---|
| **API KEY** (what goes in an env var) | `anon` JWT, `service_role` JWT | `sb_publishable_…`, `sb_secret_…` | legacy JWTs **DISABLED here** |
| **POSTGRES ROLE** (what RLS binds) | `anon`, `authenticated`, `service_role` | *unchanged* | **ALIVE — do not remove from policies** |

A `sb_publishable_…` key authenticates **as the `anon` role**. A `sb_secret_…`
key authenticates **as `service_role`**. So "the anon key is deprecated" is true
of the key and false of the role, and `CREATE POLICY … TO anon` is still correct,
current SQL.

**`service_role` bypasses RLS entirely** [MEASURED 2026-09-09: `rolbypassrls = true`;
`anon` is `false`]. Therefore:

- A policy `TO service_role` is **decorative**. It grants nothing.
- To restrict a table to server-side callers, **DROP the policies reaching
  `anon`/`public`.** Do not "add a service_role policy". Secret-key callers keep
  working by bypassing RLS, not by matching a rule.
- RLS **cannot** protect you from a leaked `sb_secret_…` key. It is not a control
  on that path at all.

```sql
select rolname, rolbypassrls from pg_roles
where rolname in ('anon','authenticated','service_role');
```

**Never re-enable legacy JWT API keys on this project.** A copy of the legacy
`service_role` JWT is public in git history and is inert *only* because the key is
disabled. Re-enabling it turns a settled non-incident into a live one.

## 2. Before you expose a table — the anon surface is growing

[MEASURED 2026-09-09] Of **647** public tables: **231 are anon/public READABLE**,
**20 are anon/public WRITABLE**, and **0 have RLS off**. A dated note elsewhere
says "196 tables" as of 2026-08-16 — that number has grown by 35 in three weeks.
The *writable* count is the sharper one and is stated in fewer places.

```sql
select tablename, cmd, roles::text from pg_policies
where schemaname='public' and (roles::text like '%anon%' or roles::text like '%public%')
order by cmd, tablename;
```

**Publishable keys ship in the browser bundle.** Anything reachable under an
`anon` policy is readable by anyone who views source. Before adding an `anon`
SELECT policy to a table holding user data, ask whether it needs read-back at all
— an insert-only capture form does not.

*Worked example, 2026-09-09:* `public.waitlist` had a correct `anon` INSERT policy
**and** a `SELECT` policy granted to `public`, exposing 9 real email addresses to
anyone viewing page source. Fixed by dropping the SELECT. `public.leads` was
already correct: insert-only, no read-back. **Prefer the `leads` shape.**

## 3. Tier is database-derived, and the trigger calls the TWO-argument overload

`repid_agents.tier` is overwritten on every INSERT/UPDATE by `trg_sync_tier`.
App-side `tier` writes are theater the trigger overrides. There are **two**
functions named `compute_tier` and only one decides anything:

| signature | behaviour | called by |
|---|---|---|
| `compute_tier(integer)` | pure score→tier ladder | **nothing in the live path** |
| `compute_tier(integer, uuid)` | score→tier, **then demotes on counterparty count** | `sync_tier()` — the trigger |

[MEASURED 2026-09-09: `sync_tier` calls the 2-arg form; the 2-arg form references
`count_unique_counterparties`; the 1-arg form does **not**.] Inspecting the
one-argument version tells you nothing about production.

**The counterparty gate is deliberate anti-Sybil design, not a bug.** `VETERAN`
and `AUTONOMOUS` each require **≥ 2 unique counterparties**, else demote one step.
`is_human = true` skips demotion. [MEASURED 2026-09-09: **0 agents** in AUTONOMOUS
or VETERAN; the ESTABLISHED band holds a score of **10000**, i.e. an agent at the
cap sitting in ESTABLISHED.] **That is the gate working. Do not "fix" it.**

`tier` cannot drift from `current_repid`, but it **can lag counterparty count** —
the trigger fires `BEFORE INSERT OR UPDATE OF current_repid`, while the tier also
depends on a count that changes without any write to that column. So a newly
2nd-counterparty agent is not promoted until its score next moves.

```sql
select id, current_repid, tier as stored, compute_tier(current_repid, id) as now
from repid_agents where tier is distinct from compute_tier(current_repid, id);
```
[MEASURED 2026-09-09: 0 rows. A live window, not a live wound.]

**To change tier names or thresholds you must update the function AND the
`repid_agents_tier_check` CHECK constraint in one migration.** Updating either
alone breaks every write with a 23514 check_violation.

## 4. Canonical tables

- **Agents: `repid_agents`.** NOT `agent_repid` — that is stale.
- **Scores: `repid_score_events`** (append-only audit log).
- `repid_standings` reads from `agent_repid`. It is not a lagging leaderboard; it
  is a **uniformly incorrect** one — frozen since early June, disagreeing with the
  canonical table on *every* shared agent name. Do not propagate it. Dropping or
  repointing it is DDL against a shared database whose consumers this repo cannot
  enumerate — that is a decision, not a cleanup.
- `trinity_tasks.id` is **BIGINT, not UUID**.
- **Never assume a column name.** Read the schema or ask. A query naming a column
  that does not exist errors `42703`, and that has burned this project more than
  once — including a "canonical fact" that cited a `repid_earned` column which has
  never existed.

```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='<table>' order by ordinal_position;
```

## 5. Client construction

Use the helpers, never `createClient` directly:
`getSupabaseAdmin()` (server, reads `SUPABASE_SECRET_KEY` then legacy names) and
`getSupabaseBrowser()` (client, reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`).

**Never construct a Supabase client at module scope.** `next build` imports every
route module to collect page data, so a module-scope client runs at build time and
fails the build when a key is absent. This broke every deployment of one project
for two months.

`NEXT_PUBLIC_*` is inlined by **static analysis of literal references**.
`process.env[name]` is not inlined and is `undefined` in the browser — so a
multi-name fallback in client code must spell out each candidate literally. An
unset `NEXT_PUBLIC_*` name silently becomes `undefined`; that is how one lead-capture
form failed for **217 days** while its catch block only reset the button.

## 6. Reporting

**Three outcomes, never two: VERIFIED / NOT CHECKED / FAILED.** Collapsing the
middle into "passed" is this system's most expensive recurring defect — a
non-responding validator counted as a score of zero disputed twelve consecutive
runs and moved real testnet money against work nobody had assessed.

If the sandbox proxy refuses a host (`curl: (56) CONNECT tunnel failed, response
403`), that is **the proxy**, not the service. Say NOT CHECKED. Any ordinary HTTP
status in a response body means you connected and the server answered.

## 7. Hard stops

- **No DDL without explicit permission from Sean.** There is no staging copy.
- Never re-enable legacy JWT API keys.
- Never paste a key value anywhere. Naming the variable is fine; `repid-engine` is
  a **PUBLIC** repository and a published secret cannot be withdrawn.
- The RepID scoring formula and ANFIS parameters must never appear in public docs.
