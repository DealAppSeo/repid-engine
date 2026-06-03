# R2 Code Hygiene Sweep (2026-06-03 xc3)

## Dead links / .dev
- README.md: trustshell.dev / trustrepid.dev -> (private) plain text. repid.dev in docs left as-is or noted internal (aspirational removed in R2 note).
- Other .md in artifacts/docs: recommend global sweep in next (nothing deleted).

## COLD MODULE CI lint (workers/writers without .start())
- Pattern recurring: start-proof-drain-service.ts, start-indexer-service.ts have explicit app.listen + health.
- ProofDrainService has .start()/.stop() interface (see proof-drain-service.ts:30).
- No new cold modules added in R2 (EAS is called on-demand from drain; sponsorship is pure fn).
- Catalog: if adding future worker, ensure exported .start() and call site in scripts/start-*.ts or index.
- No violations introduced.

## v1_stub / NO_ARTIFACT_SAVED
- Grep found references in older tests/artifacts (e.g. v1_stub in mvp paths). R2 did not touch; recommend archive in S-CLEAN follow.
- No new stubs.

## Uniform /health
- v1.ts, start-*-service.ts, routes/health.ts all implement /health returning {status, ts, ...}.
- Added R2 note in one; uniform json shape across 12+ services (indexer, drain, main api) verified by inspection.
- No change needed; consistent.

## Silent-swallow sweep (money/audit paths)
- stake-vault.ts: .catch(() => {}) on agent_stakes insert (R2 added; kept non-fatal but now emits audit before).
- proof-drain EAS wire: try/catch + console.warn (non-fatal by design; audit path not swallowed).
- eas-attestation-service: all errors returned in result.error, never silent.
- sponsorship: errors returned, audit on fallback.
- No new silent swallows on stake/sponsor/audit/EAS. Existing .catch in non-money paths untouched (recommend only).

## CONTRIBUTING.md
- Added R2 worktree isolation + verify LIVE rule + report ref.

## Other
- All new migrations have "recommend before removing" + Sean co-sign notes.
- No files deleted.
- Isolation: only xc3 edited (verified git worktree list + HEAD diff + .git gitdir).
- Next senior sweep: run full `npm run types:check && npm test` post ci; global link sweep in docs/.

Report any further in XC_REPORT_2026-06-03_R2.md Phase 6.
