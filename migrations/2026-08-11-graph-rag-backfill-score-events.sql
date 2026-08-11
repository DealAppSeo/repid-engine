-- ============================================================================
-- Graph-RAG backfill from repid_score_events
-- Lane: zkp · branch claude/e2e-mvp-packaging-plttzn
-- ============================================================================
--
-- WHAT THE MEASUREMENT SAID, and why this is not the backfill that was proposed.
--
-- reports/2026-08-11/MEASURED_JUST_CULTURE_AND_CRITIQUE.md §5 recommended backfilling
-- edges from "152,130 score events ... five orders of magnitude more edge material than
-- the 154 you have". Measured against the live database on 2026-08-11, that is wrong,
-- and the error is worth stating precisely because it changes the design:
--
--   repid_score_events has NO counterparty column. One agent_id, nothing else.
--   The only relational hooks are contract_id, llm_call_id and zk_proof_id.
--
--     llm_call_id   147,614 distinct across 147,614 events  → strictly 1:1, shared by 0 agents
--     zk_proof_id   119,310 distinct                        → shared by 0 agents
--     contract_id       627 distinct, 614 with 2+ agents    → the ONLY agent↔agent hook
--
--   Unique agent pairs recoverable from all 152,130 events:  42
--   Adding service_contracts (40 pairs) and x402_settlements (20 pairs) to that union
--   changes it to:                                           42   (both are strict subsets)
--
-- So transcribing events into nodes would create ~267,000 degree-1 pendants and make the
-- degree-1.28 pathology the report complained about dramatically WORSE, while adding no
-- traversable structure. Applying a graph technique to data that lacks the property the
-- technique exploits is the same category of error as the searchable-encryption kill.
--
-- WHAT IS ACTUALLY IN THE DATA. Two things, and this migration derives exactly those:
--
--   1. COMPETENCE (aggregate, not transcript). 152,130 events collapse into agent×domain
--      cells. At >= 5 events per cell that is 104 nodes covering 20 agents. This is the
--      real win and it is not about graph structure at all: right now ZERO of those
--      152,130 events are reachable from agent memory. Aggregation makes them retrievable
--      without pretending each one is a distinct memory.
--
--   2. COUNTERPARTY (the 42 pairs, one node per side = 84). Aggregated per PAIR, never per
--      contract — per-contract nodes would be 614 pendants for the same 42 relationships.
--
-- Domain co-membership is deliberately NOT an edge. "Both agents worked in finance" would
-- add 253 pairs from 163 events in that domain alone, and near-cliques on a shared tag
-- inflate degree without adding anything a traversal can use.
--
-- EMBEDDINGS ARE NOT SET HERE. SQL cannot run all-MiniLM-L6-v2. Backfilled nodes land with
-- embedding IS NULL, which means graph_rag_match_nodes SKIPS them (its WHERE clause requires
-- a non-null embedding) — they are graph-reachable and directly queryable but invisible to
-- vector search until `npm run graph-rag:backfill-embeddings` runs somewhere with network
-- access to the model. That gap is real, is reported by the summary this function returns,
-- and must not be described as a completed backfill until the second pass has run.
--
-- REVERSIBLE. Every row carries metadata->>'backfill_tag'; the rollback block at the bottom
-- deletes exactly those rows and nothing else.
--
-- ── APPLIED TO PRODUCTION 2026-08-11, project qnnpjhlxljtqyigedwkb ─────────────────────────
--
--   inserted   104 competence nodes · 84 counterparty nodes · 84 link edges · 67 competence edges
--   nodes      241 → 429      edges  154 → 305      mean degree (2E/V)  1.278 → 1.422
--   2-hop      264 → 331 pairs;  nodes with any 2-hop path  18 → 70
--   re-run     a second apply inserted 0 of everything (idempotent)
--   embeddings 216 nodes still NULL — 188 new + 28 pre-existing. NOT retrievable by vector
--              search until graph-rag:backfill-embeddings runs.
--   87 of the 188 new nodes are isolated: competence cells for an (agent, domain) with no
--   counterparty in that domain. They are useful as retrievable facts once embedded, but they
--   add no traversal structure and are not counted as if they did.
--
-- These functions were applied by transcription through an MCP client rather than by piping
-- this file, so the deployed bodies were diffed against it afterwards. Normalised (comments
-- stripped, whitespace collapsed) md5 of prosrc, verified equal on 2026-08-11:
--
--   graph_rag_backfill_competence_candidates    b7a5c4a1a3824e2742c80009e0e88681  (1428 chars)
--   graph_rag_backfill_counterparty_candidates  ad7a582e7314869d44d39e9f8577d49e  (1870 chars)
--   graph_rag_backfill_score_events             9877e79c180746e29cb78bc49b4d7980  (5721 chars)
--
-- Re-check with:
--   SELECT p.proname,
--          md5(trim(regexp_replace(regexp_replace(p.prosrc,'--[^\n]*','','g'),'\s+',' ','g')))
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public' AND p.proname LIKE 'graph_rag_backfill%' ORDER BY 1;
-- ============================================================================
BEGIN;

-- Idempotency as a structural property, not a convention. Re-running the backfill cannot
-- duplicate a node even if the NOT EXISTS guard below were removed or raced.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memory_nodes_backfill_key
  ON agent_memory_nodes ((metadata->>'backfill_key'))
  WHERE metadata ? 'backfill_key';

-- ---------------------------------------------------------------------------
-- Candidate derivations.
--
-- These return the FULL row the backfill would write, content and importance included,
-- so the dry-run projection and the apply path read from one definition. A dry run that
-- computes its preview separately from what the writer inserts is a preview of nothing;
-- this repo has already been bitten three times by two copies of one enumeration.
-- ---------------------------------------------------------------------------

-- importance is a ranking scalar with no ground truth. It is defined here as a monotone
-- function of EVIDENCE VOLUME and nothing else — it does not encode quality, and must not
-- be read as a score. Stated rather than tuned, so a later reader knows it was never fitted.
CREATE OR REPLACE FUNCTION graph_rag_backfill_competence_candidates(p_min_events integer)
RETURNS TABLE (
  agent_id      uuid,
  task_domain   text,
  backfill_key  text,
  content       text,
  importance    numeric,
  n             bigint,
  pos           bigint,
  neg           bigint,
  neutral       bigint,
  net           bigint,
  mean_hal      numeric,
  hal_n         bigint,
  first_at      timestamptz,
  last_at       timestamptz,
  max_event_id  bigint
)
LANGUAGE sql STABLE AS $$
  WITH cell AS (
    SELECT
      e.agent_id                                              AS agent_id,
      e.task_domain                                           AS task_domain,
      COUNT(*)                                                AS n,
      COUNT(*) FILTER (WHERE e.delta > 0)                     AS pos,
      COUNT(*) FILTER (WHERE e.delta < 0)                     AS neg,
      -- Zero-delta events are the MAJORITY in the biggest cells (peer_verify: 20,196 of
      -- 32,818). Reporting only pos and neg would invite the reader to assume the
      -- remainder was positive — the content must add up to n or it misleads by omission.
      COUNT(*) FILTER (WHERE e.delta = 0)                     AS neutral,
      SUM(e.delta)::bigint                                    AS net,
      ROUND(AVG(e.hal_score), 3)                              AS mean_hal,
      COUNT(e.hal_score)                                      AS hal_n,
      MIN(e.created_at)                                       AS first_at,
      MAX(e.created_at)                                       AS last_at,
      MAX(e.id)                                               AS max_event_id
    FROM repid_score_events e
    JOIN repid_agents a ON a.id = e.agent_id       -- FK safety: agent_memory_nodes references it
    WHERE e.task_domain IS NOT NULL
    GROUP BY e.agent_id, e.task_domain
    HAVING COUNT(*) >= p_min_events
  )
  SELECT
    c.agent_id,
    c.task_domain,
    'competence:' || c.agent_id::text || ':' || c.task_domain,
    -- Content is what gets embedded, so it is written as a sentence a retrieval query
    -- could plausibly match, not as a key=value dump.
    FORMAT(
      'Domain competence: %s. %s recorded outcomes between %s and %s — %s positive, %s negative, %s neutral (no RepID change), net RepID delta %s.%s%s Source: repid_score_events.',
      c.task_domain,
      c.n,
      TO_CHAR(c.first_at, 'YYYY-MM-DD'),
      TO_CHAR(c.last_at, 'YYYY-MM-DD'),
      c.pos,
      c.neg,
      c.neutral,
      CASE WHEN c.net >= 0 THEN '+' || c.net::text ELSE c.net::text END,
      -- LESSONS #8: a number without its ruler is not evidence. hal_score is stored raw and
      -- the frozen calibrator is not applied anywhere in this path, so the content says so.
      CASE WHEN c.hal_n > 0
           THEN FORMAT(' Mean HAL score %s across %s scored events (RAW, uncalibrated).', c.mean_hal, c.hal_n)
           ELSE '' END,
      -- Every negative event type in this table is detection-shaped (measured 2026-08-11);
      -- none of these negatives were self-reported. A reader of the memory should not infer
      -- that the agent disclosed them.
      CASE WHEN c.neg > 0 THEN ' Negatives here were detected, not self-reported.' ELSE '' END
    ),
    LEAST(0.95, ROUND(0.40 + 0.10 * LOG(c.n::numeric), 2)),
    c.n, c.pos, c.neg, c.neutral, c.net, c.mean_hal, c.hal_n, c.first_at, c.last_at, c.max_event_id
  FROM cell c;
$$;

COMMENT ON FUNCTION graph_rag_backfill_competence_candidates(integer) IS
  'agent x task_domain aggregates from repid_score_events, as agent_memory_nodes rows. '
  'Aggregate, not transcript: 152,130 events collapse to ~104 cells at min_events=5.';

CREATE OR REPLACE FUNCTION graph_rag_backfill_counterparty_candidates()
RETURNS TABLE (
  self_id       uuid,
  other_id      uuid,
  backfill_key  text,
  content       text,
  importance    numeric,
  contracts     bigint,
  domains       text[],
  events        bigint,
  pos           bigint,
  neg           bigint,
  neutral       bigint,
  first_at      timestamptz,
  last_at       timestamptz,
  max_event_id  bigint
)
LANGUAGE sql STABLE AS $$
  WITH sides AS (
    -- One row per (this agent's event, other agent). DISTINCT collapses the fan-out when the
    -- counterparty has several events on the same contract; without it a busy counterparty
    -- would silently inflate this agent's pos/neg counts.
    SELECT DISTINCT
      a.agent_id    AS self_id,
      b.agent_id    AS other_id,
      a.contract_id AS contract_id,
      a.id          AS event_id,
      a.delta       AS delta,
      a.task_domain AS task_domain,
      a.created_at  AS created_at
    FROM repid_score_events a
    JOIN repid_score_events b
      ON b.contract_id = a.contract_id
     AND b.agent_id <> a.agent_id
    WHERE a.contract_id IS NOT NULL
      AND a.agent_id IS NOT NULL
      AND b.agent_id IS NOT NULL
  ),
  pair AS (
    SELECT
      s.self_id,
      s.other_id,
      COALESCE(NULLIF(ra.display_name, ''), NULLIF(ra.agent_name, ''), LEFT(s.other_id::text, 8)) AS other_name,
      COUNT(DISTINCT s.contract_id)                    AS contracts,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.task_domain), NULL) AS domains,
      COUNT(*)                                         AS events,
      COUNT(*) FILTER (WHERE s.delta > 0)              AS pos,
      COUNT(*) FILTER (WHERE s.delta < 0)              AS neg,
      COUNT(*) FILTER (WHERE s.delta = 0)              AS neutral,
      MIN(s.created_at)                                AS first_at,
      MAX(s.created_at)                                AS last_at,
      MAX(s.event_id)                                  AS max_event_id
    FROM sides s
    JOIN repid_agents rs ON rs.id = s.self_id          -- both ends must satisfy the FK
    JOIN repid_agents ra ON ra.id = s.other_id
    GROUP BY s.self_id, s.other_id, ra.display_name, ra.agent_name
  )
  SELECT
    p.self_id,
    p.other_id,
    'counterparty:' || p.self_id::text || ':' || p.other_id::text,
    FORMAT(
      'Shared work with %s (%s): %s shared contract(s) between %s and %s.%s This agent''s %s recorded outcomes on that shared work: %s positive, %s negative, %s neutral (no RepID change). Source: repid_score_events joined on contract_id.',
      p.other_name,
      LEFT(p.other_id::text, 8),
      p.contracts,
      TO_CHAR(p.first_at, 'YYYY-MM-DD'),
      TO_CHAR(p.last_at, 'YYYY-MM-DD'),
      CASE WHEN COALESCE(ARRAY_LENGTH(p.domains, 1), 0) > 0
           THEN ' Domains: ' || ARRAY_TO_STRING(p.domains, ', ') || '.'
           ELSE '' END,
      p.events,
      p.pos,
      p.neg,
      p.neutral
    ),
    LEAST(0.90, ROUND(0.45 + 0.10 * LOG(p.contracts::numeric), 2)),
    p.contracts, p.domains, p.events, p.pos, p.neg, p.neutral, p.first_at, p.last_at, p.max_event_id
  FROM pair p;
$$;

COMMENT ON FUNCTION graph_rag_backfill_counterparty_candidates() IS
  'Directed agent->counterparty sides derived from shared contract_id in repid_score_events. '
  'Aggregated per PAIR, not per contract: 614 shared contracts represent only 42 relationships.';

-- ---------------------------------------------------------------------------
-- The backfill itself. p_apply defaults to FALSE: the destructive-by-default
-- direction for a data writer is the wrong one, and every other tool in this repo
-- (infer-edges, the release workflow) dry-runs by default too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION graph_rag_backfill_score_events(
  p_apply      boolean DEFAULT false,
  p_min_events integer DEFAULT 5,
  p_tag        text    DEFAULT 'score-events-v1'
) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_nodes_before      bigint;
  v_edges_before      bigint;
  v_nodes_after       bigint;
  v_edges_after       bigint;
  v_comp_candidates   bigint;
  v_cp_candidates     bigint;
  v_link_candidates   bigint;
  v_reinf_candidates  bigint;
  v_comp_inserted     bigint := 0;
  v_cp_inserted       bigint := 0;
  v_link_inserted     bigint := 0;
  v_reinf_inserted    bigint := 0;
  v_no_embedding      bigint;
BEGIN
  IF p_min_events < 1 THEN
    RAISE EXCEPTION 'p_min_events must be >= 1 (got %); a cell of 0 events is not a competence fact', p_min_events;
  END IF;

  SELECT COUNT(*) INTO v_nodes_before FROM agent_memory_nodes;
  SELECT COUNT(*) INTO v_edges_before FROM agent_memory_edges;

  SELECT COUNT(*) INTO v_comp_candidates
    FROM graph_rag_backfill_competence_candidates(p_min_events);
  SELECT COUNT(*) INTO v_cp_candidates
    FROM graph_rag_backfill_counterparty_candidates();

  -- A counterparty link needs BOTH sides to exist. Symmetric by construction today, but
  -- counted rather than assumed so an asymmetry would show up as a number instead of a
  -- missing edge nobody looks for.
  SELECT COUNT(*) INTO v_link_candidates
    FROM graph_rag_backfill_counterparty_candidates() a
    JOIN graph_rag_backfill_counterparty_candidates() b
      ON b.self_id = a.other_id AND b.other_id = a.self_id;

  SELECT COUNT(*) INTO v_reinf_candidates
    FROM graph_rag_backfill_counterparty_candidates() cp
    CROSS JOIN LATERAL UNNEST(cp.domains) AS d(domain)
    JOIN graph_rag_backfill_competence_candidates(p_min_events) c
      ON c.agent_id = cp.self_id AND c.task_domain = d.domain;

  IF p_apply THEN
    -- 1. competence nodes
    WITH ins AS (
      INSERT INTO agent_memory_nodes
        (agent_id, node_type, content, metadata, source_event_id, importance)
      SELECT
        c.agent_id,
        'fact',
        c.content,
        jsonb_build_object(
          'backfill_tag',  p_tag,
          'backfill_key',  c.backfill_key,
          'kind',          'competence',
          'task_domain',   c.task_domain,
          'events',        c.n,
          'positive',      c.pos,
          'negative',      c.neg,
          'neutral',       c.neutral,
          'net_delta',     c.net,
          'mean_hal_raw',  c.mean_hal,
          'hal_scored_n',  c.hal_n,
          'window_start',  c.first_at,
          'window_end',    c.last_at,
          'derived_at',    NOW(),
          'min_events',    p_min_events
        ),
        c.max_event_id,
        c.importance
      FROM graph_rag_backfill_competence_candidates(p_min_events) c
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_nodes n
        WHERE n.metadata->>'backfill_key' = c.backfill_key
      )
      RETURNING 1
    ) SELECT COUNT(*) INTO v_comp_inserted FROM ins;

    -- 2. counterparty nodes
    WITH ins AS (
      INSERT INTO agent_memory_nodes
        (agent_id, node_type, content, metadata, source_event_id, importance)
      SELECT
        cp.self_id,
        'interaction',
        cp.content,
        jsonb_build_object(
          'backfill_tag',  p_tag,
          'backfill_key',  cp.backfill_key,
          'kind',          'counterparty',
          'other_agent_id', cp.other_id,
          'contracts',     cp.contracts,
          'domains',       to_jsonb(cp.domains),
          'events',        cp.events,
          'positive',      cp.pos,
          'negative',      cp.neg,
          'neutral',       cp.neutral,
          'window_start',  cp.first_at,
          'window_end',    cp.last_at,
          'derived_at',    NOW()
        ),
        cp.max_event_id,
        cp.importance
      FROM graph_rag_backfill_counterparty_candidates() cp
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_nodes n
        WHERE n.metadata->>'backfill_key' = cp.backfill_key
      )
      RETURNING 1
    ) SELECT COUNT(*) INTO v_cp_inserted FROM ins;

    -- 3. counterparty <-> counterparty edges.
    -- BOTH directions on purpose: RetrievalService traverses with
    -- .eq('from_node_id', ...) only, so a single directed edge is invisible from the
    -- other side. One edge here would be a relationship only half the mesh can see.
    WITH ins AS (
      INSERT INTO agent_memory_edges (from_node_id, to_node_id, edge_type, weight, metadata)
      SELECT
        na.id,
        nb.id,
        'references',
        LEAST(0.95, ROUND(0.50 + 0.10 * LOG(a.contracts::numeric), 2)),
        jsonb_build_object(
          'backfill_tag', p_tag,
          'kind',         'counterparty_link',
          'contracts',    a.contracts,
          'producer',     'graph_rag_backfill_score_events'
        )
      FROM graph_rag_backfill_counterparty_candidates() a
      JOIN graph_rag_backfill_counterparty_candidates() b
        ON b.self_id = a.other_id AND b.other_id = a.self_id
      JOIN agent_memory_nodes na ON na.metadata->>'backfill_key' = a.backfill_key
      JOIN agent_memory_nodes nb ON nb.metadata->>'backfill_key' = b.backfill_key
      WHERE na.id <> nb.id                            -- no_self_edges, held explicitly
      ON CONFLICT ON CONSTRAINT unique_edge DO NOTHING
      RETURNING 1
    ) SELECT COUNT(*) INTO v_link_inserted FROM ins;

    -- 4. counterparty -> own competence in the domain the shared work happened in.
    -- 'reinforces' is used in its plain sense (this interaction is evidence for that
    -- competence). The edge-inference engine also emits 'reinforces' from a cosine rule;
    -- metadata.producer is what tells the two apart, since edge_type alone cannot.
    WITH ins AS (
      INSERT INTO agent_memory_edges (from_node_id, to_node_id, edge_type, weight, metadata)
      SELECT
        ncp.id,
        nc.id,
        'reinforces',
        LEAST(0.85, ROUND(0.40 + 0.10 * LOG(cp.contracts::numeric), 2)),
        jsonb_build_object(
          'backfill_tag', p_tag,
          'kind',         'counterparty_competence',
          'task_domain',  d.domain,
          'producer',     'graph_rag_backfill_score_events'
        )
      FROM graph_rag_backfill_counterparty_candidates() cp
      CROSS JOIN LATERAL UNNEST(cp.domains) AS d(domain)
      JOIN graph_rag_backfill_competence_candidates(p_min_events) c
        ON c.agent_id = cp.self_id AND c.task_domain = d.domain
      JOIN agent_memory_nodes ncp ON ncp.metadata->>'backfill_key' = cp.backfill_key
      JOIN agent_memory_nodes nc  ON nc.metadata->>'backfill_key'  = c.backfill_key
      WHERE ncp.id <> nc.id
      ON CONFLICT ON CONSTRAINT unique_edge DO NOTHING
      RETURNING 1
    ) SELECT COUNT(*) INTO v_reinf_inserted FROM ins;
  END IF;

  SELECT COUNT(*) INTO v_nodes_after FROM agent_memory_nodes;
  SELECT COUNT(*) INTO v_edges_after FROM agent_memory_edges;
  SELECT COUNT(*) INTO v_no_embedding
    FROM agent_memory_nodes WHERE embedding IS NULL;

  RETURN jsonb_build_object(
    'applied',      p_apply,
    'tag',          p_tag,
    'min_events',   p_min_events,
    'candidates',   jsonb_build_object(
      'competence',                v_comp_candidates,
      'counterparty',              v_cp_candidates,
      'edge_counterparty_link',    v_link_candidates,
      'edge_counterparty_competence', v_reinf_candidates
    ),
    'inserted',     jsonb_build_object(
      'competence',                v_comp_inserted,
      'counterparty',              v_cp_inserted,
      'edge_counterparty_link',    v_link_inserted,
      'edge_counterparty_competence', v_reinf_inserted
    ),
    'graph',        jsonb_build_object(
      'nodes_before',      v_nodes_before,
      'nodes_after',       v_nodes_after,
      'edges_before',      v_edges_before,
      'edges_after',       v_edges_after,
      -- 2E/V, the same definition the report used for "average degree 1.28", so the
      -- before/after numbers are comparable to the figure that motivated this work.
      'mean_degree_before',
        CASE WHEN v_nodes_before = 0 THEN NULL
             ELSE ROUND((2.0 * v_edges_before) / v_nodes_before, 3) END,
      'mean_degree_after',
        CASE WHEN v_nodes_after = 0 THEN NULL
             ELSE ROUND((2.0 * v_edges_after) / v_nodes_after, 3) END
    ),
    -- Load-bearing. A node with a NULL embedding is skipped by graph_rag_match_nodes, so
    -- reporting this backfill as "done" while this number is above zero would be claiming
    -- retrievability the system does not have.
    'nodes_without_embedding', v_no_embedding,
    'next_step',
      CASE WHEN v_no_embedding > 0
           THEN 'run: npm run graph-rag:backfill-embeddings -- --apply  (needs network access to the MiniLM model; until then these nodes are invisible to vector search)'
           ELSE 'none' END
  );
END;
$fn$;

COMMENT ON FUNCTION graph_rag_backfill_score_events(boolean, integer, text) IS
  'Backfills agent_memory_nodes/edges from repid_score_events. Dry-run by default. '
  'Leaves embedding NULL — see graph-rag:backfill-embeddings.';

COMMIT;

-- ROLLBACK (manual, uncomment to use). Deletes only rows this backfill wrote; the
-- edge deletes are redundant given ON DELETE CASCADE from the nodes, and are listed
-- first anyway so the intent survives a schema change that drops the cascade.
-- BEGIN;
--   DELETE FROM agent_memory_edges WHERE metadata->>'backfill_tag' = 'score-events-v1';
--   DELETE FROM agent_memory_nodes WHERE metadata->>'backfill_tag' = 'score-events-v1';
--   DROP FUNCTION IF EXISTS graph_rag_backfill_score_events(boolean, integer, text);
--   DROP FUNCTION IF EXISTS graph_rag_backfill_counterparty_candidates();
--   DROP FUNCTION IF EXISTS graph_rag_backfill_competence_candidates(integer);
--   DROP INDEX IF EXISTS uq_agent_memory_nodes_backfill_key;
-- COMMIT;
