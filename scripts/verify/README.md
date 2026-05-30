# Cross-Check Harness (`verify:crosscheck` + `verify:claims`)

Re-derives the **load-bearing claims** about this system from the code + DB so a report can't
assert something the harness contradicts. The peer-review ring stays for judgment; the harness
handles the reproducible facts. Built 2026-05-30 (CC) after a run of agent claims each needed
manual verification and several were wrong.

## `npm run verify:crosscheck`

Runs every check and emits a machine-readable PASS/FAIL report (`verify-crosscheck-report.json`).
Exit code is **non-zero iff a BLOCKING check FAILs** → CI blocks the merge.

| id | what it re-derives | how | blocking |
|---|---|---|---|
| `authority` | `computeAuthority == min(R, 100·√S_usd)` (D-053) | runs 5 canonical vectors against the live `computeAuthority` | yes |
| `f2-authz` | `/llm/complete` can't be used to spoof another agent | source-invariant on `route.ts`: `agent_id` mismatch → 403 on the unconditional path, no env-key bypass | yes |
| `rls` | the CRITICAL-16 + `repid_score_events` have RLS on | `pg_tables.rowsecurity` via the `exec_sql` RPC; reports total disabled | yes |
| `hal` | HAL discriminates (not "blind") | runs the labeled corpus through fact-check (strictness 2); asserts F1 ≥ `HAL_CHECK_MIN_F1` and separation > 0 | yes |
| `repid-guards` | penalty + earned-floor triggers exist; no active agent below floor | `pg_trigger` + `repid_agents` via `exec_sql` | yes |

`SKIP` (e.g. no provider keys, no DB credentials) **never blocks and never silently passes** —
it shows as `⚠️` with a reason. The `hal` check also SKIPs (not FAILs) when >50% of samples hit
provider failures, because fact-check is provider-fragile — that's a known property, not a scorer
regression, so it must not false-block a merge.

### flags / env
- `--only authority,rls` — run a subset.  `--json-only` — print JSON to stdout, no console table.
- `WARN_ONLY=rls,authority` (env) — demote those checks' FAIL to non-blocking. For phasing a
  currently-failing **pre-existing-gap** check into the gate without blocking every PR on day one.
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — required for `rls` / `repid-guards` / `hal` (else SKIP).
- `GROQ_API_KEY` / `FIREWORKS_API_KEY` / `CEREBRAS_API_KEY` — ≥2 required for `hal` (else SKIP).
- `HAL_CHECK_SAMPLE` (30), `HAL_VETO_THRESHOLD` (0.43), `HAL_CHECK_MIN_F1` (0.70).

## `npm run verify:claims -- <report.md>`

The **sprint-end self-check**: parses a report's quantitative/structural claims and re-derives each
against the live code + DB. Exit non-zero iff any claim is **CONTRADICTED**. Run it on your own
report before handoff. Extractors today: authority-formula, concurrency-mechanism (phantom-claim
detector), RLS-disabled-count, HAL F1/separation. Unrecognized prose is left alone (it is not a
universal NLP checker); claims it can't currently derive are `UNVERIFIED`, never a silent pass.

The concurrency extractor scans **cross-repo** — repid-engine `src/` **and** sibling repos (default
`../trinity-symphony-shared`, `.ts`+`.js`), because a claim's mechanism may live in another repo
(e.g. the swarm's atomic `claimed_by` claim is in trinity-symphony-shared, not repid-engine).
Override roots with `VERIFY_CLAIMS_SCAN_DIRS` (comma-separated paths).

## Adding a new invariant

1. Write `scripts/verify/checks/<id>.ts` exporting `async function xCheck(): Promise<CheckResult>`.
   Use the `pass/fail/skip` helpers from `../lib/types`. Put structured evidence in `detail`.
   Use `sqlExec(query)` from `../lib/db` for raw SQL (goes through the `exec_sql` RPC — service-role
   key only, no DATABASE_URL needed). Make DB/key-dependent checks **SKIP** (not crash) when creds
   are absent — import heavy/optional modules with `require(...)` inside a `try`, never at top level.
2. Register it in `REGISTRY` in `scripts/verify/crosscheck.ts`.
3. (optional) Add a matching extractor to `scripts/verify/claims.ts` so reports asserting that fact
   get auto-checked.

## CI wiring

`.github/workflows/crosscheck.yml` runs `verify:crosscheck` on every PR/push to `main`. Secrets
(`SUPABASE_*`, provider keys) come from repo Actions secrets; `vars.CROSSCHECK_WARN_ONLY` feeds
`WARN_ONLY`. **It is not yet a required check** — Cowork co-signs, then it's marked required in
branch protection. See the header comment in the workflow for the exact Sean/Cowork steps and why
`main` is currently RED (authority fix unmerged + standing RLS gap — both real findings).
