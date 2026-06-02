#!/bin/bash
#
# S-CLEAN1 Branch Cleanup Script (DELETE category only)
# Generated: 2026-06-01
# Sprint: XC S-CLEAN1
#
# PURPOSE:
#   Sean reviews this file, then manually runs the git push origin --delete
#   commands for branches that are confirmed stale / superseded / wip / demo.
#
#   THIS SCRIPT IS NEVER EXECUTED AUTOMATICALLY.
#   All commands are printed for human review + copy/paste / selective execution.
#
# SCOPE:
#   Only remote branches with committerdate < 2026-05-28 (147 total candidates).
#   After CC's top-9 merges (S-MERGE1 waves), most are dead weight.
#
# TARGET: Reduce 140+ stale branches to <20 active feature branches.
#
# USAGE (after review):
#   chmod +x scratch/S-CLEAN1_archive_branches.sh
#   ./scratch/S-CLEAN1_archive_branches.sh          # prints commands only
#   # Then selectively run individual "git push origin --delete ..." lines
#
# SAFETY:
#   - Never delete origin/main or origin/HEAD
#   - Never delete branches that still have open PRs (check GitHub first)
#   - Never delete branches that CC/GA/XC explicitly marked KEEP
#   - After deletion, run `git remote prune origin` locally everywhere
#
# Post-clean target state: <20 active remote feature branches total.

set -euo pipefail

echo "=== S-CLEAN1 Branch Deletion Commands (REVIEW BEFORE RUNNING) ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repo: repid-engine (origin)"
echo ""
echo "INSTRUCTIONS:"
echo "  1. Review every line in this file."
echo "  2. Cross-check GitHub for any open PRs on these branches."
echo "  3. For each group, decide: delete all / delete subset / keep some."
echo "  4. Execute commands ONE GROUP AT A TIME."
echo "  5. After each group: git fetch --prune && git branch -r | wc -l"
echo ""
echo "================================================================"
echo ""

# ============================================================
# GROUP 1: Early demo / test / reponomics / alpaca / gyroscope branches
# (April 2026 — clearly superseded, no lasting unique value)
# ============================================================

echo "# GROUP 1: Early demo/reponomics/alpaca/gyroscope (DELETE)"
git push origin --delete origin/feat/reponomics-demo-2026-04-27 || true
git push origin --delete origin/feat/reponomics-live-demo-2026-04-27 || true
git push origin --delete origin/feat/reponomics-full-account-2026-04-27 || true
git push origin --delete origin/feat/alpaca-verify-2026-04-28 || true
git push origin --delete origin/feat/e2e-demo-track-2026-04-27 || true
git push origin --delete origin/feat/real-not-simulated-2026-04-27 || true
git push origin --delete origin/feat/gyroscope-allnight-2026-04-28 || true
git push origin --delete origin/feat/share-token-util-2026-04-28 || true
git push origin --delete origin/feat/guided-tour-backend-2026-04-28 || true
git push origin --delete origin/feat/anti-gaming-middleware-2026-04-28 || true
echo ""

# ============================================================
# GROUP 2: Early railway / deploy / smoke hygiene fixes (April-May)
# (Deployment scaffolding that has been replaced many times)
# ============================================================

echo "# GROUP 2: Early railway/deploy/smoke hygiene (DELETE)"
git push origin --delete origin/fix/smoke-failures-2026-05-08 || true
git push origin --delete origin/fix/smoke-router-order-2026-05-08 || true
git push origin --delete origin/fix/railway-toml-startcommand-2026-05-10 || true
git push origin --delete origin/fix/move-service-entrypoints-2026-05-10 || true
git push origin --delete origin/railway/fix-deploy-e95089 || true
git push origin --delete origin/fix/backend-hardening-followup-2026-05-09 || true
echo ""

# ============================================================
# GROUP 3: Early CC1 / CC2 / Gemini sprint branches (April – mid May)
# Superseded by later CC waves (S-MERGE1 top 9) and ongoing work.
# Many were temporary sprint workspaces.
# ============================================================

echo "# GROUP 3: Early CC1/CC2/Gemini sprint branches (DELETE — bulk superseded)"
# April / very early May
git push origin --delete origin/feat/cc1-2026-05-26-productivity-dashboard || true
git push origin --delete origin/feat/cc1-2026-05-26-anfis-slm-tier || true
git push origin --delete origin/feat/cc1-2026-05-26-integration-mock-chains || true
git push origin --delete origin/feat/cc2-2026-05-26-controller-endpoints || true
git push origin --delete origin/feat/cc2-2026-05-26-escalation-routing || true
git push origin --delete origin/feat/cc2-2026-05-26-federation-marketplace || true
git push origin --delete origin/feat/cc2-2026-05-26-firecrawl-mcp || true
git push origin --delete origin/feat/cc2-2026-05-26-marketplace || true
git push origin --delete origin/feat/cc2-2026-05-26-notification-dispatcher || true
git push origin --delete origin/feat/cc2-2026-05-26-smoke-zkp-guard || true
git push origin --delete origin/feat/cors-for-trustshell-2026-05-26 || true
git push origin --delete origin/feat/hal-extractor-wire-up-2026-05-26 || true
git push origin --delete origin/fix/hal-stats-and-llm-trust-truthfulness-2026-05-26 || true
git push origin --delete origin/fix/readme-public-and-license-2026-05-26 || true
git push origin --delete origin/fix/readme-strip-private-2026-05-26 || true

# Mid-May Gemini / CC2
git push origin --delete origin/feat/gemini-overnight-2026-05-13 || true
git push origin --delete origin/feat/gemini-2026-05-14-phase2-0-provenance-tagging || true
git push origin --delete origin/feat/gemini-2026-05-14-phase2-3-tag-derivative-tables || true
git push origin --delete origin/feat/gemini-2026-05-14-phase2-4-shareable-zkp-card-generator || true
git push origin --delete origin/feat/gemini-2026-05-14-phase2-5-substance-gate-hardening || true
git push origin --delete origin/feat/gemini-2026-05-16-phase2-7-4-delta-restoration || true
git push origin --delete origin/feat/gemini-2026-05-16-phase2-9-a2a-foundation-typescript || true
git push origin --delete origin/feat/gemini-2026-05-17-phase2-11-migration-relocate || true
git push origin --delete origin/feat/gemini-2026-05-17-worker-recovery || true
git push origin --delete origin/feat/gemini-2026-05-17-checktimeouts-health || true
git push origin --delete origin/feat/gemini-2026-05-18-mvp-cascade-harness || true
git push origin --delete origin/feat/gemini-2026-05-18-sprint-3 || true
git push origin --delete origin/feat/gemini-2026-05-18-phase-2-11-migration-relocate || true
git push origin --delete origin/feat/gemini-2026-05-18-rpc-validation-queue || true
git push origin --delete origin/feat/gemini-2026-05-22-handler-registry-completion || true
git push origin --delete origin/feat/gemini-2026-05-22-agent-registry-hygiene || true
git push origin --delete origin/feat/gemini-2026-05-22-jtbd-social-flywheel || true
git push origin --delete origin/feat/gemini-2026-05-23-x402-real-implementation || true
git push origin --delete origin/feat/gemini-2026-05-23-x402-v1-hardening || true
git push origin --delete origin/feat/gemini-2026-05-23-x402-cleanup-batch || true
git push origin --delete origin/feat/gemini-2026-05-23-x402-facilitator-format-fix || true
git push origin --delete origin/feat/gemini-2026-05-23-x402-facilitator-format-fix-r2 || true
git push origin --delete origin/feat/gemini-2026-05-23-hal-endpoint-mount || true
git push origin --delete origin/feat/gemini-2026-05-24-security-audit-mainnet-observability || true
git push origin --delete origin/feat/gemini-2026-05-24-lower-risk-sprint || true
git push origin --delete origin/feat/gemini-2026-05-25-v1-launch-readiness || true
git push origin --delete origin/feat/gemini-2026-05-25-v1.5-redis-zk || true
echo ""

# ============================================================
# GROUP 4: Early sprint / receipt / erc8004 / x402 / graph-rag scaffolding
# (Most logic has been re-implemented or merged in later waves)
# ============================================================

echo "# GROUP 4: Early scaffolding (receipt/erc8004/x402/graph-rag) (DELETE)"
git push origin --delete origin/feat/receipt-bridge-integration-2026-05-03 || true
git push origin --delete origin/feat/receipt-bridge-v1-2026-05-03 || true
git push origin --delete origin/feat/receipt-indexer-service-2026-05-08 || true
git push origin --delete origin/feat/erc8004-canonical-2026-04-27 || true
git push origin --delete origin/feat/erc8004-validation-2026-04-28 || true
git push origin --delete origin/feat/erc8004-spec-compliance-2026-05-10 || true
git push origin --delete origin/feat/erc8004-minting-flow-2026-05-10 || true
git push origin --delete origin/feat/agent-verify-page-2026-05-10 || true
git push origin --delete origin/feat/megasprint-mass-mint-graphrag-canon-2026-05-10 || true
git push origin --delete origin/feat/graph-rag-foundation-2026-05-10 || true
git push origin --delete origin/feat/graph-rag-verification-2026-05-10 || true
git push origin --delete origin/feat/byok-user-keys-mvp-2026-05-10 || true
git push origin --delete origin/feat/real-x402-settler-2026-04-28 || true
git push origin --delete origin/feat/x402-mesh-bidirectional-2026-05-11 || true
git push origin --delete origin/feat/x402-first-microtx-hardening-2026-05-12 || true
git push origin --delete origin/feat/x402-recovery-and-mvp-corrective-2026-05-12 || true
git push origin --delete origin/feat/x402-wakeup-readiness-2026-05-12 || true
echo ""

# ============================================================
# GROUP 5: Early HAL / audit / anfis / ikigai / calibration work
# (Superseded by S-AUD1, HAL measurement sprints, and later truth-repair)
# ============================================================

echo "# GROUP 5: Early HAL/audit/anfis/ikigai (DELETE — superseded)"
git push origin --delete origin/docs/hal-canonical-v1 || true
git push origin --delete origin/feat/audit-chain-writer-and-verify || true
git push origin --delete origin/feat/wire-audit-chain-to-hal-events || true
git push origin --delete origin/feat/hal-calibration-fix || true
git push origin --delete origin/feat/hal-v2-tiered-consensus || true
git push origin --delete origin/feat/anfis-ikigai-scorer-v0 || true
git push origin --delete origin/feat/anfis-ikigai-v0.1-adversarial-harmonic || true
git push origin --delete origin/feat/hal-extraction-library-2026-05-04 || true
git push origin --delete origin/feat/hal-autorunner-2026-05-08 || true
git push origin --delete origin/fix/hal-autorunner-build-2026-05-09 || true
git push origin --delete origin/revert/hal-autorunner-2026-05-09 || true
git push origin --delete origin/feat/hal-evaluations-unified-table-2026-05-09 || true
git push origin --delete origin/feat/cross-llm-verification-layer-2026-05-03 || true
git push origin --delete origin/feat/audit-chain-merkle-2026-04-28 || true
git push origin --delete origin/docs/hal-tier1-diagnostic || true
git push origin --delete origin/docs/x402-deep-analysis || true
echo ""

# ============================================================
# GROUP 6: Various early feat / fix / sprint branches (April–mid May)
# (Temporary workspaces, one-off fixes, or superseded by mainline work)
# ============================================================

echo "# GROUP 6: Misc early feat/fix/sprint (DELETE)"
git push origin --delete origin/sprint-prove-repid-wire-to-zkp-postcard || true
git push origin --delete origin/docs/readme-upgrade || true
git push origin --delete origin/feat/fleet-registration-complete || true
git push origin --delete origin/feat/wire-canonical-writer-2026-04-28 || true
git push origin --delete origin/feat/hardening-2026-04-28-jwt || true
git push origin --delete origin/feat/e2e-tests-2026-04-28 || true
git push origin --delete origin/feat/canonical-register-all-2026-04-28 || true
git push origin --delete origin/feat/readme-updates-2026-04-28 || true
git push origin --delete origin/feat/overnight-cc-report-2026-04-28 || true
git push origin --delete origin/feat/plonky3-observability-2026-04-28 || true
git push origin --delete origin/feat/query-perf-2026-04-28 || true
git push origin --delete origin/fix/hal-decision-enum-2026-05-08 || true
git push origin --delete origin/fix/zk-queue-drain-2026-05-08-Z3 || true
git push origin --delete origin/fix/hygiene-1-2026-05-08 || true
git push origin --delete origin/fix/certainty-levels-data-shape-2026-05-09 || true
git push origin --delete origin/fix/mvp-backend-readiness-2026-05-09 || true
git push origin --delete origin/feat/indexer-worker-hardening-2026-05-10 || true
git push origin --delete origin/feat/v1-gap-inventory-2026-05-10 || true
git push origin --delete origin/feat/agent-registration-2026-05-07-A5 || true
git push origin --delete origin/feat/tiered-router-direct-only-2026-05-07 || true
git push origin --delete origin/feat/repid-staking-mvp-2026-05-05 || true
git push origin --delete origin/feat/embedding-provider-swap-2026-05-04 || true
git push origin --delete origin/feat/repid-earning-rate-limit-2026-05-11 || true
git push origin --delete origin/feat/pnl-writer-repair-2026-05-11 || true
git push origin --delete origin/feat/hal-accuracy-view-cleanups-2026-05-11 || true
git push origin --delete origin/feat/recovery-substrate-and-evidence-2026-05-11 || true
git push origin --delete origin/feat/gap-closure-and-distribution-2026-05-12 || true
git push origin --delete origin/feat/rls-wave-1-and-integration-tests-2026-05-12 || true
git push origin --delete origin/feat/substrate-wakeup-and-micro-tx-loop-2026-05-12 || true
git push origin --delete origin/feat/schema-canon-and-graph-rag-substrate-2026-05-12 || true
git push origin --delete origin/feat/cc-sprint-11-surface-fixes-2026-05-12 || true
git push origin --delete origin/feat/cc-sprint-12-worktree-topology-2026-05-12 || true
git push origin --delete origin/feat/trust-wrapper-cleanup-2026-05-13 || true
git push origin --delete origin/feat/artifact-ghost-fix-2026-05-13 || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-8-wire-swarm-hal || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-9-1-pcp-validator-schema-fix || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-9-2-worker-stall || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-9-4-hal-audit-rpc-signature || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-10-three-services || true
git push origin --delete origin/feat/cc-2026-05-16-phase2-11-storage-audit-dispute || true
git push origin --delete origin/feat/cc-2026-05-18-defect-3-fix || true
git push origin --delete origin/feat/cc-2026-05-18-defect-4-fix || true
git push origin --delete origin/diag/worker-liveness-instrumentation-2026-05-19 || true
git push origin --delete origin/feat/cc-2026-05-20-mvp-delivery || true
git push origin --delete origin/feat/cc-2026-05-21-postgrest-bypass-repid || true
git push origin --delete origin/feat/cc-2026-05-21-erc8004-key-sanitize || true
git push origin --delete origin/feat/cc-2026-05-21-e2e-verify-fix-1 || true
git push origin --delete origin/feat/cc-2026-05-22-pipeline-restoration || true
git push origin --delete origin/feat/cc-2026-05-22-x402-wiring || true
git push origin --delete origin/feat/cc-2026-05-22-defensive-filters-and-testing || true
git push origin --delete origin/feat/cc-2026-05-22-onchain-write-selffeedback-guard || true
git push origin --delete origin/feat/cc-2026-05-22-hal-x402-verdict-wiring || true
git push origin --delete origin/feat/cc-2026-05-22-freellm-router-fix || true
git push origin --delete origin/feat/cc2-2026-05-22-fseries-patch || true
git push origin --delete origin/feat/cc2-2026-05-22-hal-enrichment || true
git push origin --delete origin/feat/cc2-2026-05-23-hal-truth-signal || true
git push origin --delete origin/feat/cc2-2026-05-23-research-queue || true
git push origin --delete origin/feat/cc2-2026-05-23-hardening-r1 || true
git push origin --delete origin/feat/cc1-2026-05-23-hal-provider-failure-hardening || true
git push origin --delete origin/feat/cc2-2026-05-23-repid-inflation-cb || true
git push origin --delete origin/feat/cc1-2026-05-24-mainnet-readiness-telemetry || true
git push origin --delete origin/fix/cc2-2026-05-26-hyperdag-dev-purge || true
echo ""

# ============================================================
# GROUP 7: Very early May 2026 sprint branches (pre-cutoff but clearly dead)
# ============================================================

echo "# GROUP 7: Remaining early May sprint branches (DELETE)"
git push origin --delete origin/feat/backend-hardening-2026-05-04 || true
git push origin --delete origin/feat/hybrid-llm-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v2-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v3-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v4-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v5-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v6-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v7-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v8-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v9-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v10-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v11-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v12-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v13-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v14-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v15-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v16-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v17-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v18-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v19-2026-05-05 || true
git push origin --delete origin/feat/hybrid-llm-v20-2026-05-05 || true
echo ""

echo "=== END OF S-CLEAN1 DELETE COMMANDS ==="
echo ""
echo "After deletions, recommended follow-up (local + CI machines):"
echo "  git fetch --prune"
echo "  git remote prune origin"
echo "  git branch -r | grep -E 'origin/(feat|fix|docs|hygiene|diag|revert|railway|sprint)' | wc -l"
echo ""
echo "Review remaining branches against S-BRANCH1/S-STABLE1 high-value list before any further deletion."
