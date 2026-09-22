-- artifact_class on trinity_tasks, and a log for what a typed rule WOULD have said.
--
-- STATUS: **UNAPPLIED.** Not run against any project. Applying it is a separate,
-- deliberate act; nothing in this repo applies migrations automatically.
--
-- TWO OBJECTS, ONE PURPOSE
-- -----------------------
--   1. `trinity_tasks.artifact_class` — what KIND OF EVIDENCE would settle whether
--      this task was done. Set on NEW tasks only; every existing row stays NULL.
--   2. `typed_verdict_shadow` — what a typed evidence rule WOULD have decided,
--      recorded with no power to decide it. The table cannot record a row that
--      claims otherwise; see `had_power` below.
--
-- They ship together because the second is uninterpretable without the first: a
-- would-be verdict about evidence needs to know which evidence was expected.
--
--
-- WHY A NEW COLUMN AND NOT AN EXISTING ONE
-- ----------------------------------------
-- The caveat this answers is "don't invent a parallel enum". Four columns could
-- plausibly already carry this meaning. None does [ALL MEASURED 2026-09-22 against
-- qnnpjhlxljtqyigedwkb, 363,121 rows]:
--
--   task_category               34 non-null, a single value: 'thinking'. Effectively dead.
--   verification_method         51 non-null, free-text prose describing HOW one task was
--                               checked after the fact ("live npm registry + pg_net fetch
--                               of trustshell.dev, 2026-09-12"). A method, not a class,
--                               and written at the end rather than the start.
--   success_criteria            363,072 non-null — but 340,958 of those (93.9%) are the
--                               literal template default "Pass default checks." The rest
--                               are prose deliverable descriptions. High fill, no signal.
--   requires_external_artifact  boolean, true on 74 rows. Two-valued, so it cannot
--                               distinguish "an artifact anyone can re-check" from
--                               "a signed statement nobody can re-run" — which is the
--                               whole distinction.
--   task_type                   362,744 non-null, 40+ organic values. A kind-of-WORK
--                               taxonomy on a different axis entirely.
--
-- So this is a genuinely new axis, not a rename of one of those. Nothing here
-- alters, reads or deprecates any of them.
--
--
-- WHY THERE IS NO DEFAULT, AND WHY THAT IS THE LOAD-BEARING DECISION
-- -----------------------------------------------------------------
-- `DEFAULT 'chore'` would be the obvious convenience and it is the exact house
-- defect: it would silently classify 363,087 legacy rows, and every future row
-- whose author forgot, as "no evidence needed" — a NOT-CHECKED scored as a PASS,
-- in the safe-looking direction, invisibly. So:
--
--     NULL means NOT CLASSIFIED. It is never read as 'chore' and never as a pass.
--
-- That is enforced downstream, not merely documented: `typed-verdict-shadow.ts`
-- returns `not_checked` for a NULL class and has no branch that can turn one into
-- `accept`, and a test asserts that by feeding it a NULL and proving the accept
-- branch is unreachable.
--
-- "NEW tasks only" needs no WHERE clause and no backfill flag for the same reason
-- the lease migration needed none: a column added without a default is NULL on
-- every existing row, and NULL satisfies no classified predicate. The legacy rows
-- are inert BY CONSTRUCTION rather than by a filter someone must remember.
--
--
-- THE THREE VALUES
-- ----------------
--   'checkable'    an independent party can re-run or re-read the thing and reach the
--                  same verdict. A file, a diff, a URL, a query and its output.
--   'attestation'  cannot be re-run — a signed statement that something was observed.
--                  Its evidence is a signature and a signer, not a re-execution.
--   'chore'        no evidence is expected. Housekeeping. Saying so explicitly is the
--                  point: an author declaring "nothing to check here" is a different
--                  fact from an author who did not answer, and NULL keeps them apart.

BEGIN;

ALTER TABLE public.trinity_tasks
  ADD COLUMN IF NOT EXISTS artifact_class text;

COMMENT ON COLUMN public.trinity_tasks.artifact_class IS
  'What kind of evidence would settle whether this task was done: checkable | attestation | chore. '
  'NULL means NOT CLASSIFIED and must never be read as ''chore'' or as a pass. Set on new tasks only; '
  'no backfill — every row that predates this column is NULL by construction.';

-- NOT VALID, then VALIDATE, deliberately. A plain ADD CONSTRAINT takes ACCESS
-- EXCLUSIVE for the length of a 363k-row scan on a table with live writers;
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE. The scan is a formality here — the
-- column is new, so every existing row is NULL and NULL satisfies the check — but
-- the lock is not, so the two-step is used anyway.
ALTER TABLE public.trinity_tasks
  ADD CONSTRAINT trinity_tasks_artifact_class_check
  CHECK (artifact_class IS NULL OR artifact_class IN ('checkable', 'attestation', 'chore'))
  NOT VALID;

ALTER TABLE public.trinity_tasks
  VALIDATE CONSTRAINT trinity_tasks_artifact_class_check;

-- Zero rows on the day this runs. It exists for the agreement measurement the
-- shadow log is for, which scans exactly the classified rows and no others.
CREATE INDEX IF NOT EXISTS idx_trinity_tasks_artifact_class
  ON public.trinity_tasks (artifact_class)
  WHERE artifact_class IS NOT NULL;


-- ---------------------------------------------------------------------------
-- typed_verdict_shadow — a log with no power, and a CHECK that keeps it that way.
-- ---------------------------------------------------------------------------
--
-- WHAT IT IS FOR. Before a typed evidence rule is allowed to reject anything, it
-- runs beside the real path and records what it WOULD have said. The number this
-- produces is not a quality score for the fleet; it is the COST OF SWITCHING IT
-- ON — `would_escalate` divided by rows observed. `owner_ceiling_shadow`'s
-- `would_deny_if_owner_required` is the same shape and the same reasoning.
--
-- WHAT IT WILL SAY AT FIRST, SO NOBODY MISREADS IT LATER. The attestation
-- evidence columns are EMPTY in production: of 143,278 tasks in a done state,
-- `verification_proof`, `signatures` and `verifier_agent_id` are non-null on
-- ZERO, `verified_output` on one, and an artifact URL on 220 (0.15%)
-- [MEASURED 2026-09-22]. So a typed rule that demands evidence will escalate very
-- nearly everything it sees. That is a COVERAGE fact — nothing has ever written
-- those columns — and not a finding about the work. Reading a 99% escalate rate
-- as "the fleet is failing" would be exactly backwards.
--
-- WHY A TABLE AND NOT trinity_agent_logs. Two reasons, and the second is the
-- reason. It needs its own columns to be queryable at all; and it needs the
-- `had_power` CHECK, which is the only statement about this layer that a reader
-- does not have to take on faith.
CREATE TABLE IF NOT EXISTS public.typed_verdict_shadow (
  id                bigserial PRIMARY KEY,

  -- trinity_tasks.id is BIGINT, not UUID (CLAUDE-RULE-5). No FK: this log must
  -- outlive the rows it describes, and a cascade would delete the evidence that a
  -- deleted task was ever observed.
  task_id           bigint      NOT NULL,
  observed_at       timestamptz NOT NULL DEFAULT now(),

  -- The class as it stood WHEN OBSERVED, copied rather than joined. A later edit
  -- to the task must not silently rewrite the input of a verdict already recorded.
  artifact_class    text,

  -- Three outcomes, never two. 'not_checked' is not a lenient 'accept': it is the
  -- rule declining to answer, and it is what an unclassified task gets.
  would_be_verdict  text        NOT NULL
                    CHECK (would_be_verdict IN ('accept', 'escalate', 'not_checked')),

  -- Why, in machine-readable form, so the log can be grouped without parsing prose.
  reason            text        NOT NULL,

  -- Which evidence columns were present at the time. The raw inputs, kept so a
  -- disagreement can be re-derived rather than re-litigated.
  evidence          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The rule's own version. A shadow whose rule changed mid-run and cannot say so
  -- produces an agreement rate that averages two different rules.
  rule_version      text        NOT NULL,

  -- THE POINT OF THE TABLE. A row cannot assert that this verdict was enforced,
  -- because the storage layer refuses to store one that does. If this layer is
  -- ever given power, that is a migration someone has to write and defend — not a
  -- flag flip, and not an app-code change a reviewer might miss. Same reasoning as
  -- social_content_queue_verified_before_publish: app code is where a gate gets
  -- forgotten.
  had_power         boolean     NOT NULL DEFAULT false
                    CHECK (had_power = false)
);

COMMENT ON TABLE public.typed_verdict_shadow IS
  'Append-only log of what a typed evidence rule WOULD have decided. Has no power: the had_power '
  'CHECK makes a row claiming enforcement unstorable. The number it exists to produce is the cost '
  'of switching enforcement on, not a quality score.';

CREATE INDEX IF NOT EXISTS idx_typed_verdict_shadow_task
  ON public.typed_verdict_shadow (task_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_typed_verdict_shadow_verdict
  ON public.typed_verdict_shadow (would_be_verdict, observed_at DESC);

-- RLS on, and DELIBERATELY NO POLICIES.
--
-- Keys are not roles. A `sb_publishable_…` key authenticates as the `anon` role,
-- and `service_role` has rolbypassrls = true [VERIFIED 2026-08-15 against pg_roles],
-- so it never consults a policy at all. Therefore the way to make a table
-- server-side-only is to leave `anon` and PUBLIC with no policy to match — NOT to
-- add a `TO service_role` policy, which would grant nothing the role did not
-- already have and would read to the next author as though it were the control.
ALTER TABLE public.typed_verdict_shadow ENABLE ROW LEVEL SECURITY;

COMMIT;
