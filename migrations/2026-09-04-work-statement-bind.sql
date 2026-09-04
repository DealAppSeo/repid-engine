-- 2026-09-04-work-statement-bind.sql
--
-- BLAST RADIUS: service_contracts (additive columns + one new BEFORE trigger)
--               + helper functions + schema_evolution row.
--               Does NOT rewrite existing rows. Does NOT touch RepID.
-- MAINTENANCE WINDOW: none. ADD COLUMN nullable, trigger only fires on write.
-- PROMOTION: apply is the task (Sean asked to make the hash real, then attack it).
--
-- WHY: work_statement_hash exists on all 218 service_contracts rows and is NULL
-- on all 218. Fulfilment, settlement and rating do not consult it. A claim is
-- not bound to a spec. Same defect class as job_id linkage at 0.153% and the
-- nightly "Criteria missing or too short".
--
-- LEGACY: the 218 existing rows stay NULL. They are labelled legacy by COMMENT
-- and by v_service_contracts_work_statement.bind_state. Do not backfill.
-- New transitions TO fulfilled require a non-null hash.
--
-- HASH: SHA-256 of the canonical work-statement JSON, computed in this trigger.
-- A client-supplied hash is rejected. The provider cannot write it.
--
-- VERIFICATION:
--   SELECT count(*) FILTER (WHERE work_statement_hash IS NULL) FROM service_contracts;
--     -- still 218 (or more, if new unbound pending rows exist)
--   -- then the five attacks in tests/work-statement-bind-attacks.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── columns (additive, nullable) ────────────────────────────────────────────
ALTER TABLE public.service_contracts
  ADD COLUMN IF NOT EXISTS work_statement jsonb,
  ADD COLUMN IF NOT EXISTS work_statement_bound_at timestamptz,
  ADD COLUMN IF NOT EXISTS criterion_ratings jsonb;

-- work_statement_hash already exists live (text, nullable). Keep IF NOT EXISTS
-- so a fresh clone of this file is still apply-safe.
ALTER TABLE public.service_contracts
  ADD COLUMN IF NOT EXISTS work_statement_hash text;

COMMENT ON COLUMN public.service_contracts.work_statement IS
  'Canonical work-statement JSON: deliverable, numbered acceptance_criteria, deadline, agreed_price. Hashed server-side. Immutable once bound.';

COMMENT ON COLUMN public.service_contracts.work_statement_hash IS
  'SHA-256 (0x-hex) of canonical work_statement JSON, computed by trg_service_contracts_work_statement. NULL = unbound. Rows unbound as of 2026-09-04 are LEGACY — do not backfill. A client-supplied value is rejected.';

COMMENT ON COLUMN public.service_contracts.work_statement_bound_at IS
  'Set by trigger at first bind. NULL on legacy unbound rows.';

COMMENT ON COLUMN public.service_contracts.criterion_ratings IS
  'Per-criterion {n, met}[] matching the hashed acceptance_criteria. buyer_satisfaction_score is derived from this, not a bare star.';

CREATE OR REPLACE VIEW public.v_service_contracts_work_statement AS
SELECT
  id,
  status,
  created_at,
  work_statement_hash,
  work_statement_bound_at,
  criterion_ratings,
  buyer_satisfaction_score,
  CASE
    WHEN work_statement_hash IS NOT NULL THEN 'bound'
    WHEN created_at < TIMESTAMPTZ '2026-09-04 00:00:00+00' THEN 'legacy'
    ELSE 'unbound'
  END AS bind_state
FROM public.service_contracts;

COMMENT ON VIEW public.v_service_contracts_work_statement IS
  'bind_state: bound | legacy (pre-2026-09-04, hash NULL) | unbound (created after the bind, still no spec). Legacy rows are grandfathered; they are not backfilled.';

DO $$ BEGIN
  ALTER VIEW public.v_service_contracts_work_statement SET (security_invoker = true);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
REVOKE ALL ON public.v_service_contracts_work_statement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_service_contracts_work_statement TO service_role;

-- ── canonical JSON (must match src/services/work-statement-spec.ts) ─────────
-- Hashed object, keys sorted, no whitespace:
-- {"acceptance_criteria":[{"n":1,"text":"..."}],"agreed_price":{"amount_usdc_raw":N,"currency":"USDC"},"deadline":"...","deliverable":"..."}

CREATE OR REPLACE FUNCTION public.work_statement_canonical_text(ws jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $$
DECLARE
  parts text[] := '{}';
  c jsonb;
BEGIN
  FOR c IN
    SELECT value
      FROM jsonb_array_elements(ws->'acceptance_criteria')
     ORDER BY (value->>'n')::int
  LOOP
    parts := parts || (
      '{"n":' || (c->>'n') || ',"text":' || to_json(c->>'text')::text || '}'
    );
  END LOOP;

  RETURN '{"acceptance_criteria":[' || array_to_string(parts, ',') ||
         '],"agreed_price":{"amount_usdc_raw":' || (ws#>>'{agreed_price,amount_usdc_raw}') ||
         ',"currency":' || to_json(ws#>>'{agreed_price,currency}')::text ||
         '},"deadline":' || to_json(ws->>'deadline')::text ||
         ',"deliverable":' || to_json(ws->>'deliverable')::text || '}';
END;
$$;

CREATE OR REPLACE FUNCTION public.work_statement_sha256(ws jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
  SELECT '0x' || encode(digest(convert_to(public.work_statement_canonical_text(ws), 'UTF8'), 'sha256'::text), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.normalize_work_statement(raw jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  src jsonb;
  deliverable text;
  criteria jsonb := '[]'::jsonb;
  item jsonb;
  n int;
  txt text;
  i int := 0;
  price bigint;
  currency text;
  deadline text;
  deadline_ts timestamptz;
  vacuous text[] := ARRAY['pass default checks','n/a','none','tbd','-'];
BEGIN
  IF raw IS NULL OR jsonb_typeof(raw) <> 'object' THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: work_statement must be a JSON object';
  END IF;

  src := CASE WHEN raw ? 'work_statement' AND jsonb_typeof(raw->'work_statement') = 'object'
              THEN raw->'work_statement'
              ELSE raw END;

  deliverable := btrim(COALESCE(src->>'deliverable', src->>'title', src->>'description', src->>'content', src->>'task', ''));
  IF length(deliverable) < 8 THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: deliverable must be a string of at least 8 characters';
  END IF;

  IF src ? 'acceptance_criteria' AND jsonb_typeof(src->'acceptance_criteria') = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(src->'acceptance_criteria')
    LOOP
      i := i + 1;
      IF jsonb_typeof(item) = 'string' THEN
        n := i;
        txt := btrim(item #>> '{}');
      ELSE
        n := COALESCE((item->>'n')::int, (item->>'id')::int, i);
        txt := btrim(COALESCE(item->>'text', item->>'criterion', item->>'description', ''));
      END IF;
      criteria := criteria || jsonb_build_array(jsonb_build_object('n', n, 'text', txt));
    END LOOP;
  ELSIF src ? 'criteria' AND jsonb_typeof(src->'criteria') = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(src->'criteria')
    LOOP
      i := i + 1;
      IF jsonb_typeof(item) = 'string' THEN
        txt := btrim(item #>> '{}');
      ELSE
        txt := btrim(COALESCE(item->>'text', item->>'criterion', ''));
      END IF;
      criteria := criteria || jsonb_build_array(jsonb_build_object('n', i, 'text', txt));
    END LOOP;
  END IF;

  IF jsonb_array_length(criteria) IS NULL OR jsonb_array_length(criteria) < 1 THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: acceptance_criteria must be a non-empty numbered list';
  END IF;

  i := 0;
  FOR item IN
    SELECT value FROM jsonb_array_elements(criteria) ORDER BY (value->>'n')::int
  LOOP
    i := i + 1;
    n := (item->>'n')::int;
    txt := item->>'text';
    IF n <> i THEN
      RAISE EXCEPTION 'WORK_STATEMENT_INVALID: acceptance_criteria n values must be consecutive from 1';
    END IF;
    IF txt IS NULL OR length(txt) < 24 THEN
      RAISE EXCEPTION 'WORK_STATEMENT_INVALID: each acceptance criterion must be explicit (≥24 chars)';
    END IF;
    IF lower(regexp_replace(txt, '\.$', '')) = ANY (vacuous) THEN
      RAISE EXCEPTION 'WORK_STATEMENT_INVALID: criterion n=% is a vacuous placeholder', n;
    END IF;
  END LOOP;

  -- rebuild sorted
  SELECT jsonb_agg(value ORDER BY (value->>'n')::int) INTO criteria
    FROM jsonb_array_elements(criteria);

  price := COALESCE(
    (src#>>'{agreed_price,amount_usdc_raw}')::bigint,
    (src->>'agreed_price_usdc_raw')::bigint,
    (src->>'price_usdc_raw')::bigint
  );
  currency := COALESCE(src#>>'{agreed_price,currency}', 'USDC');
  IF price IS NULL OR price <= 0 THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: agreed_price.amount_usdc_raw must be a positive integer';
  END IF;
  IF currency IS DISTINCT FROM 'USDC' THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: agreed_price.currency must be USDC';
  END IF;

  deadline := COALESCE(src->>'deadline', src->>'deadline_at');
  IF deadline IS NULL OR btrim(deadline) = '' THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: deadline must be a valid ISO-8601 timestamp';
  END IF;
  BEGIN
    deadline_ts := deadline::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'WORK_STATEMENT_INVALID: deadline must be a valid ISO-8601 timestamp';
  END;
  deadline := to_char(timezone('UTC', deadline_ts), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  RETURN jsonb_build_object(
    'acceptance_criteria', criteria,
    'agreed_price', jsonb_build_object('amount_usdc_raw', price, 'currency', 'USDC'),
    'deadline', deadline,
    'deliverable', deliverable
  );
END;
$$;

-- ── trigger: hash, immutability, fulfil, rating ─────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_work_statement_bind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  computed text;
  expected_ns int[];
  rated_ns int[];
  extra_n int;
  met_count numeric;
  total_count numeric;
  derived numeric;
  r jsonb;
BEGIN
  -- 1. First bind / immutability of the spec.
  IF TG_OP = 'UPDATE'
     AND OLD.work_statement IS NOT NULL
     AND NEW.work_statement IS DISTINCT FROM OLD.work_statement THEN
    RAISE EXCEPTION 'WORK_STATEMENT_IMMUTABLE: work_statement cannot be altered after it is bound';
  END IF;

  IF NEW.work_statement IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.work_statement IS DISTINCT FROM NEW.work_statement) THEN
    NEW.work_statement := public.normalize_work_statement(NEW.work_statement);
    computed := public.work_statement_sha256(NEW.work_statement);
    IF NEW.work_statement_hash IS NOT NULL AND NEW.work_statement_hash IS DISTINCT FROM computed THEN
      RAISE EXCEPTION 'WORK_STATEMENT_HASH_NOT_CLIENT_SET: work_statement_hash is computed server-side from work_statement; a client-supplied hash is rejected';
    END IF;
    NEW.work_statement_hash := computed;
    NEW.work_statement_bound_at := COALESCE(NEW.work_statement_bound_at, now());
  END IF;

  -- 2. A hash without a statement is always a client forge.
  IF NEW.work_statement IS NULL AND NEW.work_statement_hash IS NOT NULL THEN
    RAISE EXCEPTION 'WORK_STATEMENT_HASH_NOT_CLIENT_SET: work_statement_hash is computed server-side from work_statement; a client-supplied hash is rejected';
  END IF;

  -- 3. Once hashed, the hash itself is frozen (covers UPDATE hash-only).
  IF TG_OP = 'UPDATE'
     AND OLD.work_statement_hash IS NOT NULL
     AND NEW.work_statement_hash IS DISTINCT FROM OLD.work_statement_hash THEN
    RAISE EXCEPTION 'WORK_STATEMENT_IMMUTABLE: work_statement cannot be altered after it is bound';
  END IF;

  -- 4. Fulfil requires a hash that was already on the row. Existing fulfilled
  --    rows (OLD.status already fulfilled) are grandfathered. Binding in the
  --    SAME update as the fulfil is refused — that is how a provider would
  --    supply its own spec+hash at delivery time.
  IF NEW.status = 'fulfilled'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'fulfilled') THEN
    IF NEW.work_statement_hash IS NULL
       OR (TG_OP = 'UPDATE' AND OLD.work_statement_hash IS NULL) THEN
      RAISE EXCEPTION 'WORK_STATEMENT_REQUIRED: cannot move to fulfilled with a NULL work_statement_hash (legacy rows already past fulfilled are grandfathered)';
    END IF;
  END IF;

  -- 5. Per-criterion ratings → derived score. Extra n is the attack.
  IF NEW.criterion_ratings IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.criterion_ratings IS DISTINCT FROM NEW.criterion_ratings) THEN
    IF NEW.work_statement IS NULL OR NEW.work_statement_hash IS NULL THEN
      RAISE EXCEPTION 'RATING_REQUIRED: cannot rate criteria on an unbound (legacy) contract; bind a work statement first';
    END IF;

    SELECT COALESCE(array_agg((c->>'n')::int ORDER BY (c->>'n')::int), '{}')
      INTO expected_ns
      FROM jsonb_array_elements(NEW.work_statement->'acceptance_criteria') c;

    IF jsonb_typeof(NEW.criterion_ratings) <> 'array' THEN
      RAISE EXCEPTION 'CRITERION_RATING_INCOMPLETE: every numbered acceptance criterion must be rated before satisfy/settle';
    END IF;

    SELECT COALESCE(array_agg((x->>'n')::int ORDER BY (x->>'n')::int), '{}')
      INTO rated_ns
      FROM jsonb_array_elements(NEW.criterion_ratings) x;

    FOREACH extra_n IN ARRAY rated_ns LOOP
      IF NOT extra_n = ANY (expected_ns) THEN
        RAISE EXCEPTION 'CRITERION_NOT_IN_STATEMENT: criterion n=% is not in the hashed work statement', extra_n;
      END IF;
    END LOOP;

    IF rated_ns <> expected_ns THEN
      RAISE EXCEPTION 'CRITERION_RATING_INCOMPLETE: every numbered acceptance criterion must be rated before satisfy/settle';
    END IF;

    met_count := 0;
    total_count := 0;
    FOR r IN SELECT value FROM jsonb_array_elements(NEW.criterion_ratings)
    LOOP
      IF jsonb_typeof(r->'met') <> 'boolean' THEN
        RAISE EXCEPTION 'CRITERION_RATING_INCOMPLETE: every numbered acceptance criterion must be rated before satisfy/settle';
      END IF;
      total_count := total_count + 1;
      IF (r->>'met')::boolean THEN
        met_count := met_count + 1;
      END IF;
    END LOOP;

    derived := round(met_count / total_count, 4);
    IF NEW.buyer_satisfaction_score IS NOT NULL
       AND NEW.buyer_satisfaction_score IS DISTINCT FROM derived THEN
      RAISE EXCEPTION 'RATING_REQUIRED: buyer_satisfaction_score must be derived from criterion ratings, not supplied as a bare star';
    END IF;
    NEW.buyer_satisfaction_score := derived;
  END IF;

  -- 6. Satisfy/settle requires a rating. Bound contracts: the derived score
  --    from criterion_ratings. Legacy (NULL hash): a buyer_satisfaction_score
  --    is enough so the 148 fulfilled rows can still settle if rated.
  IF NEW.status IN ('satisfied', 'settled')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.work_statement_hash IS NOT NULL THEN
      IF NEW.criterion_ratings IS NULL OR NEW.buyer_satisfaction_score IS NULL THEN
        RAISE EXCEPTION 'RATING_REQUIRED: cannot satisfy/settle without a rating';
      END IF;
    ELSE
      IF NEW.buyer_satisfaction_score IS NULL THEN
        RAISE EXCEPTION 'RATING_REQUIRED: cannot satisfy/settle without a rating';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_contracts_work_statement ON public.service_contracts;
CREATE TRIGGER trg_service_contracts_work_statement
  BEFORE INSERT OR UPDATE ON public.service_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_work_statement_bind();

REVOKE ALL ON FUNCTION public.work_statement_canonical_text(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.work_statement_sha256(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normalize_work_statement(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_statement_canonical_text(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.work_statement_sha256(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.normalize_work_statement(jsonb) TO service_role;

INSERT INTO public.schema_evolution (
  version, description, migration_sql, rollback_sql, applied_by, verified
)
SELECT
  '2026-09-04-work-statement-bind',
  'Bind service_contracts.work_statement_hash to a canonical spec JSON (SHA-256, server-side). Fulfil requires it. Ratings are per numbered criterion. Existing 218 NULL hashes left as legacy.',
  'migrations/2026-09-04-work-statement-bind.sql',
  $rollback$
DROP TRIGGER IF EXISTS trg_service_contracts_work_statement ON public.service_contracts;
DROP FUNCTION IF EXISTS public.enforce_work_statement_bind();
DROP FUNCTION IF EXISTS public.normalize_work_statement(jsonb);
DROP FUNCTION IF EXISTS public.work_statement_sha256(jsonb);
DROP FUNCTION IF EXISTS public.work_statement_canonical_text(jsonb);
DROP VIEW IF EXISTS public.v_service_contracts_work_statement;
ALTER TABLE public.service_contracts
  DROP COLUMN IF EXISTS criterion_ratings,
  DROP COLUMN IF EXISTS work_statement_bound_at,
  DROP COLUMN IF EXISTS work_statement;
-- work_statement_hash column PRE-EXISTED; not dropped.
$rollback$,
  'grok-work-statement-bind',
  false
WHERE NOT EXISTS (
  SELECT 1 FROM public.schema_evolution WHERE version = '2026-09-04-work-statement-bind'
);

COMMIT;
