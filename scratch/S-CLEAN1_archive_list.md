# S-CLEAN1 Archive List (branches older than 2026-05-25)

**Generated:** 2026-06-01  
**Total old branches analyzed:** 141  
**After CC merged 9 branches today**  
**Classification method:** merge-base --is-ancestor vs origin/main OR wip/recovery prefix OR diff --name-only vs main (read-only via git -C on shared)

## SUMMARY
- ARCHIVE (safe to delete): 93
- REVIEW (has unique unmerged work): 48
- KEEP (active sprint work - recent or explicitly live): see section below (identified from current main + open worktree branches + recent subjects)

Target: prune to <20 active remote feature branches.

## ARCHIVE (93 branches - safe to git push origin --delete after review)

These are either already ancestors of main (merged in the recent waves) or wip/recovery snapshots or no unique diff.


- origin/feat/reponomics-demo-2026-04-27 | merged to main (ancestor) | docs: REPONOMICS-API.md ΓÇö endpoint reference + Sean-signature recipe
- origin/feat/reponomics-live-demo-2026-04-27 | merged to main (ancestor) | test(reponomics): anonymous signup + round runner (13 new tests)
- origin/feat/reponomics-full-account-2026-04-27 | merged to main (ancestor) | fix(health): allow /api/v1/health in auth middleware
- origin/feat/real-not-simulated-2026-04-27 | merged to main (ancestor) | feat(oracle): real Base Sepolia block-hash oracle with HMAC fallback
- origin/feat/erc8004-canonical-2026-04-27 | merged to main (ancestor) | chore(erc8004): canonical registration output log
- origin/feat/wire-canonical-writer-2026-04-28 | merged to main (ancestor) | feat: phase 1 - wire canonical writer into anonymous round runner
- origin/feat/erc8004-validation-2026-04-28 | merged to main (ancestor) | feat: phase A - validation registry writer
- origin/feat/real-x402-settler-2026-04-28 | merged to main (ancestor) | feat: phase B - real x402 USDC settler
- origin/feat/hardening-2026-04-28-jwt | merged to main (ancestor) | fix(test): gate src/index.ts side-effects on NODE_ENV !== 'test'
- origin/feat/e2e-tests-2026-04-28 | merged to main (ancestor) | test(e2e): live Railway flow walker (token-signup ΓåÆ stake ΓåÆ round ΓåÆ snapshot)
- origin/feat/canonical-register-all-2026-04-28 | merged to main (ancestor) | feat: phase C - register 10 trinity agents canonically
- origin/feat/alpaca-verify-2026-04-28 | merged to main (ancestor) | verify(alpaca): paper-trading flow verifier ΓÇö creds + order + poll + cancel
- origin/feat/guided-tour-backend-2026-04-28 | merged to main (ancestor) | feat(demo): backend hooks for guided-tour pedagogy
- origin/feat/audit-chain-merkle-2026-04-28 | merged to main (ancestor) | fix(hal): wire 5-signal combiner into score-event handler
- origin/feat/cross-llm-verification-layer-2026-05-03 | merged to main (ancestor) | feat(hal): Phase 1.5 ext ΓÇö Pythagorean Comma BFT veto + 3-provider cross-LLM
- origin/feat/receipt-bridge-integration-2026-05-03 | merged to main (ancestor) | feat: erc8004 poster, receipt indexer, and trinity validators schema
- origin/feat/receipt-bridge-v1-2026-05-03 | merged to main (ancestor) | [CC1 sprint 2026-05-04] Phase 4+5 ΓÇö smoke script and live verification
- origin/feat/hal-extraction-library-2026-05-04 | merged to main (ancestor) | [CC1 sprint 2026-05-04] P5-A ΓÇö widen Layer 1 gate to include 'math' + smoke test wiring
- origin/feat/repid-staking-mvp-2026-05-05 | merged to main (ancestor) | feat: staking mvp backend route
- origin/feat/tiered-router-direct-only-2026-05-07 | merged to main (ancestor) | feat: Tiered Router with Direct Adapters only
- origin/feat/agent-registration-2026-05-07-A5 | merged to main (ancestor) | feat(A5): external agent registration ΓÇö Maya-shape additive contract
- origin/fix/hal-decision-enum-2026-05-08 | merged to main (ancestor) | fix(scoring): add hal_decision enum derivation to scoring pipeline
- origin/fix/smoke-failures-2026-05-08 | merged to main (ancestor) | test: update smoke script to handle manual redirects and 301s
- origin/fix/hygiene-1-2026-05-08 | merged to main (ancestor) | fix: hygiene-1 ΓÇö silence JSON parse traces, gate HAL benchmark, and add tests
- origin/fix/smoke-router-order-2026-05-08 | merged to main (ancestor) | fix: mount discovery/hal-stats/bounties/prove-repid routes before auth middleware (SMOKE-FIXES-ROUTER-ORDER)
- origin/feat/hal-autorunner-2026-05-08 | merged to main (ancestor) | feat(hal): persistent HAL autorunner with F1/precision/recall metrics (HAL-AUTORUNNER)
- origin/revert/hal-autorunner-2026-05-09 | merged to main (ancestor) | revert: HAL autorunner pending unified-evaluation architecture
- origin/feat/hal-evaluations-unified-table-2026-05-09 | merged to main (ancestor) | feat(hal): unified evaluations table + dual-write hook
- origin/feat/indexer-worker-hardening-2026-05-10 | merged to main (ancestor) | feat(indexer,worker): retry + stall detection hardening
- origin/fix/move-service-entrypoints-2026-05-10 | merged to main (ancestor) | fix(deploy): move service entry points to src/scripts/ + add npm scripts
- origin/fix/railway-toml-startcommand-2026-05-10 | merged to main (ancestor) | fix(deploy): remove global startCommand override in railway.toml
- origin/feat/erc8004-spec-compliance-2026-05-10 | merged to main (ancestor) | fix(worker): improve healthcheck robustness
- origin/feat/v1-gap-inventory-2026-05-10 | merged to main (ancestor) | fix(worker): improve healthcheck robustness
- origin/fix/indexer-healthcheck-2026-05-10 | merged to main (ancestor) | fix(worker): improve healthcheck robustness
- origin/feat/graph-rag-foundation-2026-05-10 | merged to main (ancestor) | feat(graph-rag): foundation ΓÇö embedded memory nodes + edges
- origin/feat/erc8004-minting-flow-2026-05-10 | merged to main (ancestor) | feat(erc8004): minter + HTTP routes + backfill for 4 headline agents
- origin/feat/megasprint-mass-mint-graphrag-canon-2026-05-10 | merged to main (ancestor) | feat(megasprint): mass-mint backfill + Graph RAG HAL wiring + canon
- origin/feat/repid-earning-rate-limit-2026-05-11 | merged to main (ancestor) | feat(sprint-2): RepID earning + rate limiter + V1 gap inventory
- origin/feat/x402-mesh-bidirectional-2026-05-11 | merged to main (ancestor) | Merge branch 'main' into feat/x402-mesh-bidirectional-2026-05-11
- origin/feat/pnl-writer-repair-2026-05-11 | merged to main (ancestor) | feat(sprint-3): pnl_realized investigation + scoreTrade reality alignment
- origin/feat/hal-accuracy-view-cleanups-2026-05-11 | merged to main (ancestor) | feat(sprint-4): hal_accuracy_summary view + housekeeping
- origin/feat/recovery-substrate-and-evidence-2026-05-11 | merged to main (ancestor) | feat(sprint-6): trinity_swarm_health view + heartbeat interval tracking
- origin/feat/gap-closure-and-distribution-2026-05-12 | merged to main (ancestor) | feat(sprint-7): gap closure + distribution hardening
- origin/feat/rls-wave-1-and-integration-tests-2026-05-12 | merged to main (ancestor) | feat(sprint-8): RLS Wave 1 (40 Category A) + integration test suite + CI gate
- origin/feat/substrate-wakeup-and-micro-tx-loop-2026-05-12 | merged to main (ancestor) | CC Sprint 9: substrate wake-up scaffolding (probes, breakers, runbooks, mocks)
- origin/feat/x402-first-microtx-hardening-2026-05-12 | merged to main (ancestor) | feat(x402): sprint 4 complete - idempotency, governor, circuit breaker, tests
- origin/feat/schema-canon-and-graph-rag-substrate-2026-05-12 | merged to main (ancestor) | fix(sprint-10): restore Phase 5 files lost during branch turbulence
- origin/feat/cc-sprint-11-surface-fixes-2026-05-12 | merged to main (ancestor) | feat(types): wire Supabase TS type generator + npm scripts
- origin/feat/x402-recovery-and-mvp-corrective-2026-05-12 | merged to main (ancestor) | feat(x402): extend health CLI with recovery worker status
- origin/feat/cc-sprint-12-worktree-topology-2026-05-12 | merged to main (ancestor) | feat(git): worktree doctor health-check CLI
- origin/feat/x402-wakeup-readiness-2026-05-12 | merged to main (ancestor) | docs(x402): append protocol for first real micro-transaction
- origin/feat/gemini-2026-05-14-phase2-4-shareable-zkp-card-generator | merged to main (ancestor) | fix: resolve package.json merge conflict markers
- origin/feat/gemini-2026-05-14-phase2-5-substance-gate-hardening | merged to main (ancestor) | fix(repid-engine): Phase 2.5.2 schema fixes and tier mismatches
- origin/feat/gemini-2026-05-16-phase2-7-4-delta-restoration | merged to main (ancestor) | Phase 2.7.4: restore canonical RepID deltas + tier lookup + audit trace + patent trail
- origin/feat/cc-2026-05-16-phase2-8-wire-swarm-hal | merged to main (ancestor) | Phase 2.8: bypass SQL-keyword sanitizer for /api/v1/substance-gate/events
- origin/feat/cc-2026-05-16-phase2-9-1-pcp-validator-schema-fix | merged to main (ancestor) | Phase 2.9.1: fix pcp-validator schema drift (name -> agent_name, drop metadata)
- origin/feat/cc-2026-05-16-phase2-9-2-worker-stall | merged to main (ancestor) | Phase 2.9.2: fix validation_queue claim violating processed_check constraint
- origin/feat/cc-2026-05-16-phase2-9-4-hal-audit-rpc-signature | merged to main (ancestor) | Phase 2.9.4: fix append_hal_audit_chain RPC signature (gate + non-HITL worker)
- origin/feat/gemini-2026-05-17-phase2-11-storage-audit-dispute | merged to main (ancestor) | Phase 2.11: storage + reputation audit handlers + dispute resolution worker
- origin/feat/gemini-2026-05-16-phase2-9-a2a-foundation-typescript | merged to main (ancestor) | Phase 2.9: a2a foundation TypeScript implementation (delta functions, routes, sanitizer bypasses, worker mods)
- origin/hygiene/pcp-validator-tests | merged to main (ancestor) | Hygiene: export selectWeightedValidators and add unit tests for pcp-validator
- origin/hygiene/validation-fixes | merged to main (ancestor) | Hygiene: fix mapResolutionToOutcome typo and add missing agent logs in applyValidationDeltas
- origin/feat/cc-2026-05-16-phase2-10-three-services | merged to main (ancestor) | Phase 2.10: three production service handlers (verification, cross-validation, anfis-routing)
- origin/feat/gemini-2026-05-17-checktimeouts-health | merged to main (ancestor) | feat(worker): harden checkTimeouts against NULL processed_at and add detailed /health surface
- origin/feat/gemini-2026-05-18-phase-2-11-migration-relocate | merged to main (ancestor) | fix(migrations): relocate phase 2.11 SQL files from root migrations/ to supabase/migrations/ with 14-digit timestamps
- origin/feat/gemini-2026-05-18-rpc-validation-queue | merged to main (ancestor) | feat(observability): create get_validation_queue_status_24h RPC
- origin/feat/gemini-2026-05-18-mvp-cascade-harness | merged to main (ancestor) | feat(harness): MVP cascade verification SQL script
- origin/feat/cc-2026-05-18-defect-3-fix | merged to main (ancestor) | feat(observability): provider_health per judge rotation attempt
- origin/feat/gemini-2026-05-18-defect-4-fix | merged to main (ancestor) | fix(hal): correct typescript compilation error for undefined validatorBeliefs
- origin/feat/cc-2026-05-20-mvp-delivery | merged to main (ancestor) | feat(erc8004): wire FeedbackLoopWorker.start() + drain-mode rate-limit + AbortSignal + circuit breaker (Phase 8)
- origin/feat/cc-2026-05-21-postgrest-bypass-repid | merged to main (ancestor) | feat(boot): direct-pg pgPing diagnostic in API + proof-drain worker
- origin/feat/cc-2026-05-21-erc8004-key-sanitize | merged to main (ancestor) | fix(erc8004): sanitize and validate private key with loud-on-bad-input behavior
- origin/feat/gemini-2026-05-22-handler-registry-completion | merged to main (ancestor) | feat(handlers): register reputation_audit + decentralized_storage handlers
- origin/feat/cc-2026-05-22-pipeline-restoration | merged to main (ancestor) | feat(cascade): server-side escrowed->fulfilled settlement worker
- origin/feat/cc-2026-05-22-x402-wiring | merged to main (ancestor) | fix(x402): RULE-11 error check on post-settlement repid_events insert
- origin/feat/gemini-2026-05-22-agent-registry-hygiene | merged to main (ancestor) | feat(agent-registry): soft-retire RAVEN & test agents, add name validation utility and tests
- origin/feat/cc-2026-05-22-defensive-filters-and-testing | merged to main (ancestor) | feat(testing): 4 MVP scenarios + run-all CLI
- origin/feat/cc-2026-05-22-onchain-write-selffeedback-guard | merged to main (ancestor) | fix(erc8004): pre-flight self-feedback guard in first-onchain-write script
- origin/feat/gemini-2026-05-22-jtbd-social-flywheel | merged to main (ancestor) | feat(bridge): wire SERVICE_FULFILLED to ERC-8004 attestation via service_fulfilled_settled event
- origin/feat/cc2-2026-05-22-fseries-patch | merged to main (ancestor) | fix(security): normalize is_simulated gate (case/type/nested) ΓÇö F-series patch
- origin/feat/cc2-2026-05-22-hal-enrichment | merged to main (ancestor) | feat(hal): add HAL_STRICTNESS env (1|2) with provider fallback to s1 on error
- origin/feat/cc2-2026-05-23-hal-truth-signal | merged to main (ancestor) | feat(hal): HalService + REST endpoint + Trust* product profiles
- origin/feat/gemini-2026-05-23-x402-real-implementation | merged to main (ancestor) | feat(x402): implement server-side payment enforcement and verification
- origin/feat/gemini-2026-05-23-x402-cleanup-batch | merged to main (ancestor) | fix(x402): domain fix + P5 double-fulfill + CC2 handoff integration
- origin/feat/cc1-2026-05-23-hal-provider-failure-hardening | merged to main (ancestor) | sim(hal): provider-failure simulation over CC2 calibration corpus (full/partial/low quorum, pre vs post gate)
- origin/feat/cc2-2026-05-23-repid-inflation-cb | merged to main (ancestor) | docs(security): mark Patch B applied (zero-demotion floor + is_human exclusion); Patch C z=2.5
- origin/feat/gemini-2026-05-23-x402-facilitator-format-fix | merged to main (ancestor) | feat: Update x402-facilitator to send standard x402 envelope to x402.org
- origin/feat/gemini-2026-05-23-x402-facilitator-format-fix-r2 | merged to main (ancestor) | feat: wrap x402 requests in paymentPayload and inject name and version into paymentRequirements extra
- origin/feat/gemini-2026-05-23-hal-endpoint-mount | merged to main (ancestor) | feat: import and mount halEvaluateRouter at /api/v1/hal and add to SQL sanitizer bypass
- origin/feat/gemini-2026-05-24-security-audit-mainnet-observability | merged to main (ancestor) | test(security): update auth-gating tests to expect 401 for /prove-repid without auth
- origin/feat/cc1-2026-05-24-mainnet-readiness-telemetry | merged to main (ancestor) | test(regression): V1 critical-path coverage
- origin/feat/gemini-2026-05-25-v1-launch-readiness | merged to main (ancestor) | test(integration): fix race condition in smoke-zkp test by allowing completed status
- origin/feat/gemini-2026-05-25-v1.5-redis-zk | merged to main (ancestor) | fix(v1.5): add missing erc8004_token_id to RepIdAttestation interface

## REVIEW (48 branches - unique work not on main - needs manual inspection before delete)

These have file changes vs current main. May contain useful SQL, docs, or logic that was not merged. Inspect diffs before archiving.


- origin/docs/hal-canonical-v1 | unique files (695): .claude/settings.json, .claude/settings.local.json, .env.local | feat(db): add hal_audit_chain migration (schema only)
- origin/sprint-prove-repid-wire-to-zkp-postcard | unique files (696): .claude/settings.json, .claude/settings.local.json, .env.example | feat(repid-engine): wire /prove-repid to live zkp-postcard Plonky3 service
- origin/docs/readme-upgrade | unique files (696): .claude/settings.json, .claude/settings.local.json, .env.example | docs(readme): expand HAL / RepID / ZKP acronyms on first mention
- origin/feat/audit-chain-writer-and-verify | unique files (690): .claude/settings.json, .claude/settings.local.json, .env.local | feat(audit): hash-chain writer + /api/v1/audit/verify endpoint
- origin/feat/wire-audit-chain-to-hal-events | unique files (688): .claude/settings.json, .claude/settings.local.json, .env.local | feat(hal): wire hal_production_events writes into hal_audit_chain
- origin/docs/x402-deep-analysis | unique files (702): .claude/settings.json, .claude/settings.local.json, .env.local | docs(x402): convergence vs independence vs create-8004-agent
- origin/docs/hal-tier1-diagnostic | unique files (686): .claude/settings.json, .claude/settings.local.json, .env.local | docs(hal): Tier-1 boot 0% F1 vs production /hal/signals diagnostic
- origin/feat/hal-calibration-fix | unique files (686): .claude/settings.json, .claude/settings.local.json, .env.local | fix(hal): gate +0.35 epistemic boost on independent overreach signal
- origin/feat/hal-v2-tiered-consensus | unique files (695): .claude/settings.json, .claude/settings.local.json, .env.local | docs(hal-v2): architecture, tiers, escalation rules, benchmarks
- origin/feat/anfis-ikigai-scorer-v0 | unique files (697): .claude/settings.json, .claude/settings.local.json, .env.local | docs(anfis-ikigai): v0 architecture + P-014 reduction-to-practice
- origin/feat/anfis-ikigai-v0.1-adversarial-harmonic | unique files (707): .claude/settings.json, .claude/settings.local.json, .env.local | docs(p-014): extend reduction-to-practice with harmonic + antagonist + SBFA + federated
- origin/feat/fleet-registration-complete | unique files (703): .claude/settings.json, .claude/settings.local.json, .env.local | docs(fleet): wallet-identity blocker + gas budget notes
- origin/feat/e2e-demo-track-2026-04-27 | unique files (693): .claude/settings.json, .claude/settings.local.json, .env.local | test: integration tests for SBT mint + ZKP threshold + audit chain
- origin/feat/readme-updates-2026-04-28 | unique files (667): .claude/settings.json, .claude/settings.local.json, .env.local | docs(readme): rewrite with real-vs-simulated table per CLAUDE-RULE-4
- origin/feat/overnight-cc-report-2026-04-28 | unique files (668): .claude/settings.json, .claude/settings.local.json, .env.local | docs(report): overnight hardening sprint summary 2026-04-28
- origin/feat/plonky3-observability-2026-04-28 | unique files (663): .claude/settings.json, .claude/settings.local.json, .env.local | feat(zkp-bridge): /health pre-flight cache (60s TTL) before prove attempt
- origin/feat/share-token-util-2026-04-28 | unique files (598): .claude/settings.json, .claude/settings.local.json, .env.local | feat(utils): HMAC-signed share-token utility for gyroscope flywheel
- origin/feat/anti-gaming-middleware-2026-04-28 | unique files (602): .claude/settings.json, .claude/settings.local.json, .env.local | feat(middleware): rate-limit, request-dedup, ip-fingerprint trio
- origin/feat/query-perf-2026-04-28 | unique files (601): .claude/settings.json, .claude/settings.local.json, .env.local | perf(db): query consolidation helpers + builder-dashboard N+1 fix
- origin/feat/gyroscope-allnight-2026-04-28 | unique files (600): .claude/settings.json, .claude/settings.local.json, .env.local | fix(migration): add is_simulated and plonky3_proof_bytes to linked_bets
- origin/feat/backend-hardening-2026-05-04 | unique files (573): .claude/settings.local.json, .env.local, .firecrawl/install-check.md | feat: use env var for repid engine public URL
- origin/feat/embedding-provider-swap-2026-05-04 | unique files (539): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | Sprint R-G complete ΓÇö RepID weighted staking MVP shipped.
- origin/fix/zk-queue-drain-2026-05-08-Z3 | unique files (445): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(zk): drain proof queue (Z3) ΓÇö fixed payload mismatch and added drain script
- origin/feat/receipt-indexer-service-2026-05-08 | unique files (428): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat: implement persistent receipt indexer service with health check (RECEIPT-INDEXER-RAILWAY-SERVICE)
- origin/fix/hal-autorunner-build-2026-05-09 | unique files (430): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(hal): add missing certainty field to HALContext construction (TS2741)
- origin/fix/certainty-levels-data-shape-2026-05-09 | unique files (428): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(hal): handle {test:[...]} object shape in certainty_levels_to_test
- origin/fix/mvp-backend-readiness-2026-05-09 | unique files (425): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | test(hal-evaluations): cover Layer 0 fixes + paper-trade payloads
- origin/fix/backend-hardening-followup-2026-05-09 | unique files (429): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | test(hal): expand dual-write coverage
- origin/feat/agent-verify-page-2026-05-10 | unique files (420): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(engine): public verification page + STARK proof retrieval
- origin/feat/byok-user-keys-mvp-2026-05-10 | unique files (409): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(byok): user-side encrypted key storage MVP + Public Docs
- origin/feat/graph-rag-verification-2026-05-10 | unique files (406): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat: graph-rag end-to-end verification harness
- origin/feat/gemini-overnight-2026-05-13 | unique files (375): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(gemini): overnight Phase 2 - Heartbeat Schema Fix
- origin/feat/trust-wrapper-cleanup-2026-05-13 | unique files (306): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | chore: token holder lookup script
- origin/feat/artifact-ghost-fix-2026-05-13 | unique files (312): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(artifacts): deploy CHECK constraint and test suite for ghost prevention
- origin/feat/gemini-2026-05-14-phase2-0-provenance-tagging | unique files (306): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(provenance): tag all trinity_tasks writers with test_tier per Provenance Framework v1.0
- origin/feat/gemini-2026-05-14-phase2-3-tag-derivative-tables | unique files (313): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat: phase 2.3 derivative table tags (trinity_agent_logs)
- origin/feat/gemini-2026-05-17-worker-recovery | unique files (257): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(worker): rewrite checkTimeouts for NULL-aware recovery and add health metrics
- origin/feat/gemini-2026-05-18-sprint-3 | unique files (253): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | test: enhance verify harness with Sections H and I
- origin/diag/worker-liveness-instrumentation-2026-05-19 | unique files (250): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(diag): implement /runloop-liveness endpoint per Sprint 13 spec
- origin/feat/cc-2026-05-21-e2e-verify-fix-1 | unique files (241): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(feedback-loop): supabase-js fallback when direct-pg poll unavailable
- origin/feat/cc-2026-05-22-hal-x402-verdict-wiring | unique files (230): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(e2e): MVP go-gate verification script (verify-mvp-loop)
- origin/feat/cc-2026-05-22-freellm-router-fix | unique files (226): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(agent-testing): correct cerebras model id + free-LLM provider fallthrough
- origin/feat/cc2-2026-05-23-research-queue | unique files (210): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(research): add disagreement quotas to cross-validation prompts
- origin/feat/gemini-2026-05-23-x402-v1-hardening | unique files (208): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | feat(x402): gas estimation + observability metrics
- origin/feat/cc2-2026-05-23-hardening-r1 | unique files (214): .env.local, .firecrawl/install-check.md, .github/workflows/ci.yml | fix(security): block direct self-dealing via constraint + endpoint check
- origin/feat/gemini-2026-05-24-lower-risk-sprint | unique files (163): .env.local, .firecrawl/install-check.md, .github/workflows/crosscheck.yml | fix(test): execute settler simulation mode only when MOCK_FACILITATOR is explicitly true
- origin/fix/cc2-2026-05-26-hyperdag-dev-purge | unique files (155): .env.local, .firecrawl/install-check.md, .github/workflows/crosscheck.yml | docs(fix): purge unowned hyperdag.dev domain refs (RULE-4 cross-repo sweep)
- origin/railway/fix-deploy-e95089 | unique files (155): .env.local, .firecrawl/install-check.md, .github/workflows/crosscheck.yml | fix: move @types/pg from devDependencies to dependencies

## KEEP (active / recent sprint work)

These are NOT in the "older than 2026-05-25" list or are known live from worktrees / recent commits:
- origin/feat/ga-2026-06-01-docs-overhaul (current on shared, awaiting merge - see TASK 2)
- Recent CC branches that were part of the 9 merged today or still open (e.g. feat/cc-2026-06-01-rls-lockdown, feat/cc-2026-05-30-s-stable2, etc. - verify post-merge)
- Any branches with subjects containing "S-MERGE", "S-RLS", "S-AUD1", current sprint markers after cutoff
- trinity-symphony-shared-ga related branches if mirrored

**Recommendation for Sean:**
1. Delete all in ARCHIVE (after confirming no open PRs on GitHub).
2. For REVIEW: for each, run git diff origin/<branch> main --name-only | head -10 and git log --oneline main..origin/<branch> . If the unique work is superseded or low value, move to ARCHIVE.
3. After cleanup, re-count: git branch -r | wc -l  (goal <20 feature branches + main).

**Next step after prune:** Rebuild worktree list and update SCHEMA_TRUTH_MAP if needed.

---
End of S-CLEAN1_archive_list.md
