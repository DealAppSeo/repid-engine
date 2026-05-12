# Production Deploy Gate

**Owner:** Sean (canonical), enforced by CI (CC Sprint 8 workflow).
**Created:** 2026-05-12 (CC Sprint 8) — structural fix for the 2026-05-11 morning incident where CC Sprint 2's accidentally-included orphan `x402InboundRouter` import broke `main` for ~3 hours via Railway TypeScript build failure.

---

## The gate (run in order before any push to `main`)

1. **`npx tsc --noEmit`** — type-check passes (catches the orphan-import class of bug)
2. **`npm test`** — unit tests pass
3. **`npm run test:integration`** — integration tests pass against live Supabase (CC Sprint 8)
4. **`npm run smoke:prod`** — production-route smoke (read-only, against production)
5. **Manual review:** `git diff --stat origin/main..HEAD` — confirm only your sprint's files
6. **Push:** `git push origin <feature-branch>` (main reachable only via PR + CI green)

`npm run smoke:full` runs steps 3+4 in one call (Sprint 8 deliverable).

The pre-commit hook (CC Sprint 7) gates every commit; this gate sits one level above and runs against the merged-to-main candidate.

---

## What to do if a gate fails

### Type-check fails (step 1)
- The orphan-import pattern: someone in your shared working tree may have edited a file you `git add`'d. Run `git diff --cached --stat` and confirm only your sprint's files are staged.
- If the failing file IS yours: fix the type error before pushing. Don't ship known-broken types.
- If the failing file is NOT yours: you have HEAD-drift contamination. Recover per the pre-commit hook's instructions: stash → checkout correct branch → pop → re-stage.

### Unit tests fail (step 2)
- Look at the assertion that failed. If it's a regression in your sprint's code: fix locally, re-run.
- If it's pre-existing (your sprint didn't touch the file): check `git log -- <test-file>` to see who broke it last.

### Integration tests fail (step 3)
- A regression visible only against live data. Read the failure stderr.
- Common failure modes:
  - Schema constraint: a CHECK constraint rejected the test's synthetic insert. Fix the constraint via `apply_migration` (NEVER `execute_sql`) and document in your sprint report. This caught the `paper_trade_outcome` bug in CC Sprint 8.
  - Spokesperson UUID drift: SOPHIA / VERITAS / SHOFET / CHESED UUIDs changed. Update the test constants.
  - RPC removed: `graph_rag_match_nodes` or similar missing. Restore via `apply_migration`.

### Production smoke fails (step 4)
- Production is unhealthy OR your branch's deployed version regressed something.
- If your branch isn't deployed yet (typical case before merge): production failure means production was already unhealthy. Investigate independently of your sprint.
- If your branch IS deployed (you `git push origin main` already): roll back via `git revert HEAD && git push`. Then diagnose.

### Manual review surprises you (step 5)
- Files appear that aren't yours: HEAD-drift / `git add -A` contamination. Pre-commit hook should have caught this if `.git/EXPECTED_BRANCH` was set; if not set, see CC Sprint 7's `Sprint Discipline` section in the README.

---

## Bypass policy

Only Sean. Only with documented reason. Commit message must start with:

```
BYPASS-DEPLOY-GATE: <reason>
```

Examples of acceptable bypass:
- `BYPASS-DEPLOY-GATE: hotfix for live security incident, full review post-deploy`
- `BYPASS-DEPLOY-GATE: production smoke endpoint itself is down; can't gate on it`

Examples of UNacceptable bypass (the kind that caused incidents):
- `bypass test, will fix later` (vague — we have CI for a reason)
- `urgent demo` (a demo isn't production; deploy to a separate Railway env)
- (no bypass marker at all) — invisible to audit trail

---

## CI integration

CC Sprint 8 ships `.github/workflows/ci.yml` running typecheck + unit tests + integration tests on every PR to main + every push to main.

Required GitHub repo secrets (Sean adds):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `SMOKE_BASE_URL` (e.g., `https://repid-engine-production.up.railway.app`)

Without secrets the integration tests skip gracefully (per `describeIfDb` / `describeIfTarget` patterns in the test files), so CI will still pass typecheck + unit tests for fork PRs.

Make this workflow a **required check** on the `main` branch via Settings → Branches → branch protection rule. Once required, no PR merges without CI green.

---

## Railway deploy interaction

Railway uses `nixpacks.toml` for build (`npm install --legacy-peer-deps`). It does NOT run tests during deploy. The deploy gate above is the only test run between local development and production — DO NOT skip it.

Per-service start commands live in the Railway dashboard (per the comment in `railway.toml`). Don't add a global `startCommand` there; that would override per-service customizations for `receipt-indexer` and `proof-drain-worker`.

---

## Historical context (one-paragraph why-this-doc-exists)

On 2026-05-11 AM, CC Sprint 2's `git add -A` accidentally swept Gemini's in-progress edit (an `import x402InboundRouter` line) into commit `072b0d5`. The matching `./routes/x402-inbound.ts` file lived only on Gemini's branch. When Sean merged Sprint 2 to main, Railway's TypeScript build failed for ~3 hours until CC Sprint 3's audit caught it. CC Sprint 7 shipped the pre-commit hook + EXPECTED_BRANCH discipline to prevent the contamination at the commit layer; CC Sprint 8 ships this gate to catch any contamination that nonetheless reaches the merged-to-main candidate.

Discipline is cheaper than recovery.

---

*"He who walks in integrity walks securely." — Proverbs 10:9*

*Built on faith and Plonky3. Micah 6:8.*
