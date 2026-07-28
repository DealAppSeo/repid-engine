# BEAT 46 -- Round-3 independent verification: feat/cc-2026-07-27-claim-cap (trinity-symphony-shared PR #34)

Verifier role: independent, did not write this code. Repo DealAppSeo/trinity-symphony-shared,
PR #34, head d27a6bb0b9cdaac9151cd8d20dc4f288d20417d6 (confirmed via gh pr view --json headRefOid
and git log -1 on a fresh clone). This is the third verification round; rounds 1 and 2 each found a
HIGH hole hidden inside the fix for the previous round finding. Round 3 found the same pattern again.

Method: fresh clone into an isolated scratch dir (not the shared worktree), npm install,
baseline node -c plus full local test suite green, then single-line mutations applied one at a time
with the edit verified by diff before drawing any conclusion, suite re-run, then the file
restored from a byte-for-byte backup and re-diffed to confirm zero residue before the next mutation.

## Baseline (unmodified branch, before any mutation)

node -c lib/ConstitutionalAgentV4.js   -> clean
node -c lib/tool-call-logger.js        -> clean
node -c scripts/ops/claim-exhausted.js -> clean
node tests/getNextTask.test.js         -> 8 passed, 0 failed
node tests/claimCap.test.js            -> 15 passed
node tests/claimCallSite.test.js       -> 28 passed
node tests/provenance.test.js          -> passed
node tests/pulseCheckExecutor.test.js  -> 9 passed, 0 failed
node tests/heartbeatDbWritesGate.test.js -> 7 passed, 0 failed

All 6 CI-listed test files green (67+ explicit assertions across the numbered suites). This matches
the claim in the PR body of a green baseline, independently reproduced.

## VERDICT: SEND BACK

Two HIGH mutations survived the full suite (both produce the same production failure mode: the
stale-task reaper silently stops reaping/refunding anything, forever, while continuing to log as if
it is working). One LOW-severity test-pinning gap also survived, in the same family this PR has been
closing for three rounds running but did not fully close this time.

---

## Finding 1 (HIGH) -- runStaleTaskReaper select() never actually proves id is fetched, so a select() edit that drops it is invisible and permanently disables reaping in production

Where: lib/ConstitutionalAgentV4.js line 703, the reaper select call listing the columns
id, claimed_by, claimed_at, title, metadata -- unchanged by this PR, a pre-existing line, but now
load-bearing for the new claim_count refund path -- and the staleSupabase test stub in
tests/claimCallSite.test.js around lines 203-214.

The gap: this round fix hoisted the in/lt/limit calls into asserted constants specifically because
the old stub had implemented select/in/lt/limit as argument-ignoring chainables. The new
staleSupabase stub records what select was called with (seen.select), but the only assertion
against it is a single regex requiring the word metadata to appear somewhere in that string. It
proves metadata is present. It proves nothing about id, claimed_by, claimed_at, or title. Worse,
the stub itself never uses the select string to shape what it returns -- every test injects a
literal object with an id field regardless of what select was asked for, so even a stub that did
filter columns would not matter unless a test also asserted the presence of id in the request.

Mutation (single line, diff-confirmed applied): the select column list was changed from
"id, claimed_by, claimed_at, title, metadata" to "claimed_by, claimed_at, title, metadata" (id
removed).

Result: running tests/claimCallSite.test.js alone -> claimCallSite.test.js: 28 passed, exit 0.
Restored and re-diffed against the pristine backup to confirm zero residue before drawing this
conclusion.

Why this is a real hole, not academic: node-pg converts a JS undefined bind parameter to SQL NULL
(confirmed by reading node_modules/pg/lib/utils.js line 45, which states plainly that null and
undefined are both null for postgres). If id were ever dropped from the select (this exact one-line
edit, made by a future refactor, a merge conflict resolution, or a copy-paste), task.id is
undefined for every stale row. buildReapParams(task.id, ...) then binds the first placeholder to
NULL inside REAP_SQL's WHERE id = param1 AND status = ANY(param3) clause. In SQL, id = NULL is
never true for any row -- the UPDATE ... RETURNING returns zero rows for every stale task, every
time. The code already treats a zero-row result as benign: a comment right at that branch reads
"another reaper won the race, or the task left doing on its own -- not an error," and the loop
simply continues.

So the reaper would log that it found N stale tasks to release on every pass, forever, and then
silently do nothing -- no error, no task_reaped log entries, and the consecutive-failure counter
never trips because nothing throws, so the circuit-breaker guard added this round never engages
either. Every task stuck in doing/in_progress behind a dead or restarted agent would never be
returned to the pool and never refunded. This is strictly worse than the F1/F3 defect this whole PR
exists to fix (that one under-refunded; this one would stop reaping at all) -- and it would be
invisible in production exactly the way this PR's own commit messages describe as the recurring
failure class: reports doing work while nothing is actually happening.

Severity: HIGH. Silent, total, permanent disablement of the reaper (the piece of this PR that makes
the cap safe for blameless releases), reachable by a single innocuous-looking line edit, with zero
test coverage anywhere in the 28-test call-site file that exists specifically to pin the reaper wire
behavior.

---

## Finding 2 (HIGH) -- buildReapParams first bind (the task id being reaped) is never checked against the actual task; a wrong or hardcoded id reaches the identical silent-no-op failure as Finding 1

Where: lib/ConstitutionalAgentV4.js, the buildReapParams function (around line 2920). It takes
taskId and metadata, and returns an array of three values -- the id, the JSON-stringified metadata,
and the REAPABLE_STATUSES constant -- to be bound as the reap statement three parameters.

The gap: every existing assertion on the reaper params checks the second position (metadata, via
parsing it back to JSON and checking reap_count) and the third position (deep-equal against
REAPABLE_STATUSES). The first position -- the id that actually targets the row being reaped -- is
asserted nowhere. This is precisely the asymmetry this PR closed for CLAIM_SQL/buildClaimParams
this same round (a dedicated test titled "every bind position carries the value the SQL expects at
that position") but never applied to the reap side.

Mutation (single line, diff-confirmed applied): buildReapParams was changed to return a hardcoded
999999 in the first array position instead of the real taskId argument (the second and third
positions left untouched).

Result: running tests/claimCallSite.test.js alone -> claimCallSite.test.js: 28 passed, exit 0.
Restored and re-diffed clean.

Why this matters: functionally identical failure mode to Finding 1 -- a first bind that never
matches a real stale row means the WHERE clause matches nothing, the returned row count is zero on
every call, and the reaper runs and refunds nothing, forever, with no error surfaced. A less
contrived mutation than a hardcoded literal -- an accidental argument-order swap at the one real
call site, which passes task.id then the rebuilt metadata object -- was traced through by hand:
swapping those two arguments would in fact be caught, because the second bind position would then
hold a JSON-stringified plain number, and parsing that back and reading reap_count off a number
yields undefined, which fails the existing metadata-position assertion. So that specific swap is
covered. The uncovered case is any mutation, refactor, or copy-paste that changes what lands in the
first position while leaving the second position correct, which the hardcoded-999999 mutation
demonstrates directly.

Severity: HIGH, same reasoning as Finding 1 -- this is the second of two independent ways to reach
the identical "reaper looks alive, does nothing" production failure, and it sits in code introduced
by the F1/F3 rework and exercised by tests added across rounds 2 and 3, none of which pin the first
bind position.

Recommended fix for both Finding 1 and 2: (a) make the staleSupabase select stub actually require
and check for id (and ideally all five columns) before returning rows -- for example asserting that
the select string contains the words id, claimed_by, and claimed_at in addition to the existing
metadata check; and (b) add an assertion pinning the first bind of a captured reap call to the
specific task id under test in at least one reaper test, symmetric to the value-by-position test
that already exists for the claim side.

---

## Finding 3 (LOW) -- REAP_RELEASE_STATUS is the one trigger-condition constant in this round own fix that is not hardcode-pinned, unlike its three siblings

Where: lib/ConstitutionalAgentV4.js line 2887 (the REAP_RELEASE_STATUS constant, value "pending")
and its only test, tests/claimCallSite.test.js around lines 483-494.

Every other constant this round hoisted for the stated purpose of preventing self-satisfying
mirrors is pinned to a hardcoded literal somewhere in the suite: REAP_STALE_AFTER_MS is compared
against 60 times 60 times 1000 directly; REAP_BATCH_LIMIT is compared against the literal 50;
REAPABLE_STATUSES is deep-equal compared against the literal array doing/in_progress; REFUNDABLE_STATUS
is compared against the literal string doing.

REAP_RELEASE_STATUS is checked only against itself: one assertion checks that CLAIMABLE_STATUSES
includes REAP_RELEASE_STATUS, and another checks that the SQL text contains the release status
interpolated from the same constant. Both assertions use the live constant as the expected value,
not a hardcoded literal.

Mutation (single line, diff-confirmed applied): REAP_RELEASE_STATUS was changed from "pending" to
"assigned".

Result: the full local suite (all 6 CI-listed files) -> ALL_GREEN.

Why LOW, not HIGH: the structural guard this PR cares about -- a reap must release into a claimable
status, and releasing to a non-claimable status like blocked left every test green in an earlier
round -- still holds, because "assigned" genuinely is in CLAIMABLE_STATUSES, so the task is not
permanently stranded and remains servable. I checked whether any other code in this codebase treats
status equal to assigned differently from status equal to pending (dashboards, other agent files,
downstream consumers) and found none; the only behavioral difference is cosmetic or semantic drift
(a reaped task would misleadingly read as assigned rather than released back to pending), not a
cap-defeating defect. Recorded because it is the same weak-pin pattern this PR has repeatedly
self-identified and closed elsewhere, and because a mutation to a genuinely non-claimable status
(blocked, done) would still be caught by the CLAIMABLE_STATUSES membership check -- so the actual
exposure window is narrow, limited to mutating within the claimable set only.

---

## Mutations run this round and their outcome

1. Drop id from reaper select() -- ConstitutionalAgentV4.js line 703 -- SURVIVED, Finding 1 (HIGH)
2. Drop claimed_by and claimed_at from reaper select() -- same line -- survived, but cosmetic-only
   (affects only log text) -- not separately reported as a finding beyond confirming the select()
   gap is broad, not limited to the id column alone
3. buildReapParams hardcodes the first bind to 999999 instead of taskId -- around line 2921 --
   SURVIVED, Finding 2 (HIGH)
4. REAP_RELEASE_STATUS changed from pending to assigned -- line 2887 -- SURVIVED, Finding 3 (LOW)
5. Remove the GREATEST floor on the refund (unsaturate the decrement) -- around line 2902 -- killed
   (claimCallSite.test.js fails)
6. Remove the "if not isSurvivor return" survivor gate -- line 696 -- killed (claimCallSite.test.js
   fails)
7. claim-exhausted.js list() ignores its limit argument and uses DEFAULT_LIMIT instead -- around
   line 54 of scripts/ops/claim-exhausted.js -- killed (claimCallSite.test.js fails)

Mutations 5 through 7 were sanity checks against claims already made in the PR body and commit
messages, to confirm the harness itself was capable of killing real defects and not just
rubber-stamping. All three killed as claimed, which calibrates confidence that Findings 1 through 3
are genuine survivors and not an artifact of a broken harness.

Every mutation above was applied via a scripted string-replace with a strict single-match guard (so
a failed match raises immediately rather than silently mutating nothing), followed by a diff to
visually confirm the edit landed before running tests, and by a second diff against a pristine
backup copy after restoring to confirm zero residue before the next mutation. The working tree was
clean (git status --porcelain empty apart from an added, untracked run_suite.sh harness script) at
the end of the session.

## What I did NOT do, and limits of this method

- No live Postgres was used. The node-pg "undefined binds to NULL" claim underlying Findings 1 and
  2 is sourced from reading node_modules/pg/lib/utils.js line 45 directly, not from executing a
  query against a real trinity_tasks table. I did not independently confirm against a live database
  that a WHERE id equals NULL clause returns zero rows under the Supabase transaction pooler
  specifically (this is standard ANSI SQL NULL-comparison semantics, not something expected to
  differ under a pooler, but it is inference from documented driver behavior, not a live query
  result).
- Not exhaustive mutation coverage. I targeted the six trigger-condition areas the task named
  explicitly (stub argument-discarding, reaper trigger conditions, the refund status condition,
  saturation at zero, REAP_FAILURE_BUDGET versus the circuit-breaker threshold, and the recovery
  tool main/binds), plus the diff between this round parent commit and its head as the most likely
  place for a newly-introduced hole, consistent with the pattern in rounds 1 and 2. I did not mutate
  every literal in the roughly 270-line diff -- for example I did not fuzz the ORDER BY clause of
  EXHAUSTED_TASKS_SQL, or mutate claimHistory/MAX_CLAIM_RETRIES interactions inside getNextTask,
  which were unchanged this round and were the subject of rounds 1 and 2 own scrutiny already.
- getNextTask.test.js exercises a different class (constitutional-agent-base.js's
  ConstitutionalAgent, per a comment in claimCallSite.test.js itself) and was run only as part of
  the baseline and CI-parity check, not mutation-targeted, since it is out of scope for
  ConstitutionalAgentV4 own claim cap.
- I did not check the migration already-applied state in production (the Trinity prod Supabase
  project) -- the claim in the PR body that claim_count is live on trinity_tasks was taken as given
  per the task brief; no database tool was invoked this round, since the task scope was code-level
  mutation testing of the branch, not a live-system check.
- Manual mutation testing, not an automated mutation-testing framework (no Stryker or equivalent is
  configured in this bare-node test setup) -- one mutation at a time, human-selected mutation sites.
  This means the absence of a finding in an area I did not mutate is not evidence of its safety,
  only that I did not test it this round.

## Verdict

SEND BACK.

Two HIGH findings, both reducible to the same root cause: the stale-task reaper targeting of a
specific row (via id, whether lost from the select() call or mis-bound in buildReapParams) is
unverified end-to-end by any test, even though this exact round fix was expressly about pinning the
reaper wire behavior after round 2 found the trigger-condition literals unpinned. Both findings
reproduce the identical failure signature already named twice in this PR own commit history -- the
test's own suite could not see the defect it exists to stop -- one layer further in than where the
last two rounds looked (they pinned when the reaper fires and what column values it filters by;
neither pinned which row it actually touches).

What must change before merge:
1. The staleSupabase select() assertion must require id (and ideally the full column list) to be
   present in what the reaper actually requests.
2. At least one reaper test must assert that the first bind of a captured reap call equals the
   specific task id under test, symmetric to the bind-position-by-value test already added for
   CLAIM_SQL/buildClaimParams this same round.
3. (Optional, LOW) Either hardcode-pin REAP_RELEASE_STATUS to the literal "pending" for consistency
   with its three sibling constants, or explicitly document why membership-only pinning is
   sufficient here and leave it as accepted risk.

Independent verification pass. No code fix applied.
