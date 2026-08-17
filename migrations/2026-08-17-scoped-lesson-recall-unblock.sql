-- Scoped-lesson recall: make the one stored lesson reachable, and stop the next one
-- from being silently unreachable the same way.
--
-- ***** NOT APPLIED. NOT AUTO-APPLIABLE. *****
-- Unlike 2026-07-27_add_trinity_tasks_claim_count.sql, this file has NOT been run against
-- production. It is the unapplied half of a measurement. Nothing in the GraphRAG read path
-- changes until someone runs it deliberately, and section 4 CANNOT be run from SQL at all.
-- Read section 0 before applying: applying 1-3 without doing 4 leaves the feature exactly as
-- broken as it is now, because an embedding cannot be computed by Postgres.
--
-- Target: Supabase qnnpjhlxljtqyigedwkb (AITrinitySymphony). Read-only measurements below
-- were taken 2026-08-17 via the Supabase MCP path.
--
-- ============================================================================
-- 0. WHAT WAS MEASURED, AND WHY THIS IS NOT COSMETIC
-- ============================================================================
--
-- The XC/GA dispatcher (repid-engine scripts/dispatch/run-agent.mjs) injects a SCOPED LESSONS
-- block beneath the unconditional LESSONS.md block. Both ends are wired in code:
--   inject:  run-agent.mjs:844 fetchScopedLessons -> GET /api/v1/lessons/recall
--                            :875 scopedLessonBlock -> preamble
--   harvest: run-agent.mjs:1017 extractLessons -> :1018 postLessons -> POST /api/v1/lessons
--
-- The store behind it holds exactly ONE scoped lesson node, and that node is unretrievable by
-- every implemented read path. Measured, not inferred:
--
--   agent_memory_nodes                                430 rows
--     node_type='reflection'                            1
--     scope IS NOT NULL                                 1   (the same row)
--     metadata->>'source'='dispatch_lesson_harvester'   0   <-- nothing ever harvested
--     embedding IS NULL                                42
--
-- The single scoped node (id 62f95ab4-8b13-47bb-be35-1c8cbcd61216, created 2026-08-17 09:17Z,
-- content "CI VERIFICATION RULES (LESSONS A26...)") is blocked THREE independent ways. Fixing
-- any two of them still returns nothing, which is why they are all in one file:
--
--   B1. embedding IS NULL. graph_rag_match_scoped is vector-only and filters
--       `AND n.embedding IS NOT NULL`. Proven by calling the live function with a
--       match-everything threshold -- not by reading it:
--         graph_rag_match_scoped('org', <384-dim probe>, 20, -1.0, ARRAY['reflection']) -> 0 rows
--         graph_rag_match_scoped('org', <384-dim probe>, 20, -1.0, NULL)                -> 0 rows
--       At threshold -1.0 every row with a vector matches. Zero rows is the NULL filter alone.
--
--   B2. scope='org' is not a lesson scope. LESSON_SCOPES is
--       ('global','repid-engine','hal','anfis','zkp') in BOTH repid-engine
--       src/types/graph-rag.ts:21 and the dispatcher's own hardcoded copy at
--       run-agent.mjs:411. The dispatcher never asks for 'org', and
--       GET /api/v1/lessons/recall returns 400 unknown_scope for it. There is NO CHECK
--       constraint on the column, so the DB accepted a value no reader can ever request.
--
--   B3. The node's metadata claims a retrieval leg that does not exist. Verbatim:
--         "retrieval_leg": "lexical/trigram only -- embedding is NULL, so the HNSW vector
--                           leg cannot return this row until it is backfilled"
--       There is no lexical leg. The only recall functions in the project are
--       graph_rag_match_nodes, graph_rag_match_scoped and recall_memory -- all vector-only.
--       No pg_trgm / tsvector / BM25 retrieval path exists in the schema or in repid-engine.
--       The row asserts a fallback that was never built. Left in place, the next auditor reads
--       "retrievable by another leg" and stops looking. That is the house defect -- a system
--       reporting success it has not earned -- recorded in the data itself.
--
-- AND the thing that makes B1 permanent rather than temporary:
--
--   B4. memory_backfill_targets() can never see this row. It INNER JOINs repid_agents on
--       agent_id, and every scoped lesson has agent_id IS NULL by construction (see the
--       agent_memory_nodes_owner_or_scope CHECK: agent_id OR scope, and GraphRagStore
--       .createNode passes agent_id=null for scoped writes). So:
--         memory_backfill_targets(1000) -> 0 rows,  while 42 nodes have embedding IS NULL.
--       "0 targets remaining" is the drain's completion signal and it reads as "0 unembedded".
--       It is not. 41 of the 42 are deliberate exclusions (test/mock agents outside the
--       12-agent fleet list -- correct, keep). The 42nd is the only lesson we have.
--
--       The drain that used to run is also GONE: cron.job has no memory-embed-backfill-drain.
--       cron.job_run_details shows 30 runs, all succeeded, last 2026-08-13 05:46Z, then
--       unscheduled -- correct at the time, since it had drained the fleet. Consequence today:
--       nothing anywhere will ever embed a row that misses the inline write path.
--
-- WHY THE INLINE PATH DOES NOT SAVE US. GraphRagStore.createNode (repid-engine
-- src/services/graph-rag/graph-rag-store.ts:50) embeds at write time and throws if embedding
-- fails, so a lesson arriving through POST /api/v1/lessons is always embedded. The stored node
-- has no embedding because it was INSERTed by direct SQL, bypassing the only writer that
-- embeds. Two writers to one table, one of which embeds -- the drift this stack keeps paying
-- for. Section 3 makes the cheaper of the two failure modes loud instead of silent.
--
-- ============================================================================
-- 1. CORRECT THE STORED LESSON
-- ============================================================================
-- Scope: 'org' -> 'global'. The content is CI-verification rules (LESSONS A26) -- cross-cutting,
-- so 'global' is the correct scope on the merits, and it is the scope the dispatcher falls back
-- to for unmatched work (run-agent.mjs:423 scopeForTask). This rewrites another lane's row;
-- it is targeted by id, and the rollback at the bottom restores the original value exactly.
--
-- Metadata: drop the false retrieval_leg claim. Replaced with a key that states the real
-- position, so the row stops advertising a capability the system does not have.

UPDATE public.agent_memory_nodes
   SET scope = 'global',
       metadata = (metadata - 'retrieval_leg')
                  || jsonb_build_object(
                       'retrieval_leg', 'vector only -- no lexical/trigram leg exists in this project',
                       'scope_corrected_from', 'org',
                       'scope_corrected_on', '2026-08-17',
                       'scope_corrected_why', 'org is not in LESSON_SCOPES; no reader can request it'
                     )
 WHERE id = '62f95ab4-8b13-47bb-be35-1c8cbcd61216'
   AND scope = 'org';   -- no-op if another lane already fixed it

-- ============================================================================
-- 2. LET THE BACKFILL SEE SCOPED NODES  (fixes B4)
-- ============================================================================
-- INNER JOIN -> LEFT JOIN, plus an explicit arm for agent-independent scoped nodes.
--
-- RED/GREEN, run read-only against production 2026-08-17 by executing each body as a bare
-- SELECT (neither function was replaced to measure this):
--   CURRENT body  -> 1 targets: 0   scoped: 0
--   PROPOSED body -> 1 targets: 1   scoped: 1
-- The delta is exactly the one scoped lesson. No test/mock-agent row leaks in: those have a
-- non-NULL agent_id that is absent from the fleet list, so they fail both arms and stay
-- excluded, which is the behaviour the 12-agent allowlist was added to guarantee.
--
-- Signature and return type are unchanged. agent_name is NULL for scoped rows; the only
-- consumer (trinity-ecosystem supabase/functions/embed-memory-backfill) uses it solely for the
-- dry-run `sample` display and writes using r.id / r.content, so NULL is inert there.
--
-- NOTE, not fixed here: this function is SECURITY DEFINER and EXECUTE is granted to PUBLIC /
-- anon, so the browser-shipped publishable key can enumerate the CONTENT of unembedded memory
-- nodes. Bounded -- unembedded rows only, agent memory not credentials -- but it is a real
-- anon read surface and revoking it is a behaviour change that belongs in its own change with
-- its own callers checked. Recorded, deliberately NOT bundled.

CREATE OR REPLACE FUNCTION public.memory_backfill_targets(p_limit integer DEFAULT 25)
 RETURNS TABLE(id uuid, content text, agent_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select n.id, n.content, r.agent_name
  from public.agent_memory_nodes n
  left join public.repid_agents r on r.id::text = n.agent_id::text
  where n.embedding is null
    and n.content is not null
    and length(trim(n.content)) > 0
    and (
      -- the twelve real fleet agents (unchanged: keeps the ~164 mock/test agents out)
      r.agent_name in (
        'trinity-apm','trinity-chesed','trinity-gcm','trinity-hdm',
        'trinity-mel','trinity-nexus','trinity-orch','trinity-shofet',
        'trinity-sophia','trinity-torch','trinity-veritas','trinity-w3c'
      )
      -- OR any agent-independent scoped node: these are lessons, they have agent_id IS NULL
      -- by construction, and before this arm existed no drain could ever reach them.
      or (n.agent_id is null and n.scope is not null)
    )
  order by n.created_at
  limit greatest(0, p_limit);
$function$;

-- ============================================================================
-- 3. MAKE AN UNREACHABLE SCOPE FAIL LOUD  (prevents B2 recurring)
-- ============================================================================
-- The allowed-scope list lived only in TypeScript, in two separate hardcoded copies. The DB
-- accepted 'org' without complaint and the row became invisible with no error anywhere -- the
-- write succeeded, the read returned [], and an empty result set is not an error.
--
-- This trades "silently unreachable forever" for "23514 at write time". That is the right
-- trade for a scope column whose ONLY purpose is to be matched against a closed list of
-- reader-side constants. Cost, stated: adding a sixth lesson scope now requires a migration
-- alongside the TypeScript change. That coupling is the point -- the two lists are already
-- coupled in fact, and this makes a disagreement surface as an error instead of a silence.
--
-- Ordering is load-bearing: section 1 must run first or this constraint cannot be created
-- (1 row currently violates it). NOT VALID is deliberately NOT used -- validating the existing
-- row is the entire point.

ALTER TABLE public.agent_memory_nodes
  ADD CONSTRAINT agent_memory_nodes_scope_check
  CHECK (scope IS NULL OR scope IN ('global','repid-engine','hal','anfis','zkp'));

-- ============================================================================
-- 4. THE STEP THIS FILE CANNOT DO  (B1 -- still open after 1-3)
-- ============================================================================
-- Postgres cannot compute a 384-dim MiniLM vector, and this migration MUST NOT fake one.
-- Sections 1-3 only make the row ELIGIBLE to be embedded. Until the step below runs,
-- graph_rag_match_scoped('global', ...) still returns 0 rows and the dispatcher still injects
-- no scoped lessons. Applying 1-3 and declaring the feature fixed would be the exact
-- unearned-success this file was written to document.
--
-- Run it deliberately, from SQL, AFTER applying sections 1-3. Not enabled here.
--
-- The edge function embeds with the same quantized Xenova/all-MiniLM-L6-v2 export production
-- uses, and self-gates: it re-embeds a node whose vector is already stored and refuses to write
-- unless it reproduces it to >= 0.9999 cosine. Do not substitute a local run -- the fp32 export
-- scores 0.994 against the same stored vectors, which silently splits the corpus into two
-- embedding spaces. Source of record:
--   trinity-ecosystem/supabase/functions/embed-memory-backfill/index.ts
--
--   -- dry run first; expect would_write: 1, gate_passed: true
--   select net.http_post(
--     url := 'https://qnnpjhlxljtqyigedwkb.supabase.co/functions/v1/embed-memory-backfill',
--     headers := jsonb_build_object('Content-Type','application/json'),
--     body := '{"dry_run": true, "limit": 18}'::jsonb);
--
--   -- then the write, only if the dry run reported gate_passed
--   select net.http_post(
--     url := 'https://qnnpjhlxljtqyigedwkb.supabase.co/functions/v1/embed-memory-backfill',
--     headers := jsonb_build_object('Content-Type','application/json'),
--     body := '{"dry_run": false, "limit": 18}'::jsonb);
--
-- VERIFY -- this is the only statement that proves the feature works. It must return 1.
-- Threshold -1.0 matches everything that HAS a vector, so a 0 here means still no embedding:
--
--   select count(*) from graph_rag_match_scoped(
--     'global', array_fill(0.05::real, ARRAY[384])::vector, 20, -1.0, ARRAY['reflection']);
--
-- STANDING GAP, not closed by this file: no scheduled drain exists any more
-- (cron.job has no memory-embed-backfill-drain; it was unscheduled after 2026-08-13). Any
-- future node inserted by direct SQL rather than through POST /api/v1/lessons will sit
-- unembedded and unretrievable, exactly as this one did. The durable fix is to write lessons
-- through the API (which embeds inline) or to re-schedule the drain. Section 2 only guarantees
-- that a drain, if one runs, can now see them.

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- ALTER TABLE public.agent_memory_nodes DROP CONSTRAINT agent_memory_nodes_scope_check;
--
-- CREATE OR REPLACE FUNCTION public.memory_backfill_targets(p_limit integer DEFAULT 25)
--  RETURNS TABLE(id uuid, content text, agent_name text)
--  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
-- AS $function$
--   select n.id, n.content, r.agent_name
--   from public.agent_memory_nodes n
--   join public.repid_agents r on r.id::text = n.agent_id::text
--   where n.embedding is null and n.content is not null and length(trim(n.content)) > 0
--     and r.agent_name in (
--       'trinity-apm','trinity-chesed','trinity-gcm','trinity-hdm',
--       'trinity-mel','trinity-nexus','trinity-orch','trinity-shofet',
--       'trinity-sophia','trinity-torch','trinity-veritas','trinity-w3c')
--   order by n.created_at limit greatest(0, p_limit);
-- $function$;
--
-- UPDATE public.agent_memory_nodes
--    SET scope = 'org',
--        metadata = (metadata - 'scope_corrected_from' - 'scope_corrected_on'
--                             - 'scope_corrected_why' - 'retrieval_leg')
--                   || jsonb_build_object('retrieval_leg',
--                        'lexical/trigram only — embedding is NULL, so the HNSW vector leg cannot return this row until it is backfilled')
--  WHERE id = '62f95ab4-8b13-47bb-be35-1c8cbcd61216';
--
-- Rolling back does NOT unwrite an embedding created by section 4. That is intentional and
-- harmless: the vector is correct under the gate, and graph_rag_match_scoped simply stops
-- being asked for 'global' once the scope is reverted.
