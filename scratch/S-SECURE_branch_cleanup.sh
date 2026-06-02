#!/bin/bash
# S-SECURE Branch Cleanup Script (NOT EXECUTED — Sean reviews + runs manually)
# Generated: 2026-06-02 on XC worktree
# Based on: git branch -r counts (171 total on engine, 31 on trinity), merged lists, wip/recovery, prior S-CLEAN1 data.

set -euo pipefail

echo "=== S-SECURE BRANCH CLEANUP ==="
echo "Review every line. Check GitHub for open PRs on each branch before delete."
echo "Run one group at a time. git fetch --prune && git branch -r | wc -l after each."
echo ""

# ============================================================
# GROUP 1: FULLY MERGED TO MAIN (101 on repid-engine)
# Safe. From `git branch -r --merged origin/main | grep -v HEAD/main`
# ============================================================
echo "# GROUP 1: Merged to main (safe deletes) — repid-engine"
# Sample from scan (full list in prior S-CLEAN1 or re-generate):
git push origin --delete origin/feat/agent-registration-2026-05-07-A5 || true
git push origin --delete origin/feat/alpaca-verify-2026-04-28 || true
git push origin --delete origin/feat/audit-chain-merkle-2026-04-28 || true
# ... (add the other ~98 from the merged list file or re-run `git branch -r --merged origin/main | grep -v "HEAD\|main"`)
echo "Add remaining merged from /tmp or re-generate list before running."
echo ""

# GROUP 1b: trinity-symphony-shared merged (17)
echo "# GROUP 1b: Merged — trinity-symphony-shared"
# (17 from scan; list similarly)
# git push origin --delete origin/feat/xxx || true
echo ""

# ============================================================
# GROUP 2: WIP / RECOVERY / TEMP snapshots (explicitly temporary)
# Safe.
# ============================================================
echo "# GROUP 2: WIP/recovery/temp (safe)"
git push origin --delete origin/recovery/ga-authority-2026-05-30 || true
git push origin --delete origin/recovery/ga-x402-hardening-2026-06-01 || true
git push origin --delete origin/wip/hal-scorer-recalibration-2026-05-29 || true
git push origin --delete origin/wip/worktree-snapshot-2026-05-29 || true
# Add any others from `git branch -r | grep -E 'wip/|recovery/|temp/'`
echo ""

# ============================================================
# GROUP 3: STALE (>30 days old, low activity)
# Review for unique work first. Many overlap with merged.
# ============================================================
echo "# GROUP 3: Stale (review for unique work before delete)"
# From prior scans + S-CLEAN1: early April/May demos, cc1/cc2/gemini sprints, etc.
# Example:
# git push origin --delete origin/feat/reponomics-demo-2026-04-27 || true
# ... (generate full list with date filter before running)
echo "Generate full stale list with: for b in $(git branch -r | grep -v HEAD/main); do d=$(git log -1 --format=%ci $b | cut -d' ' -f1); [[ $d < 2026-05-03 ]] && echo $b; done"
echo ""

# ============================================================
# GROUP 4: REVIEW FIRST (has unmerged unique work or recent activity)
# From previous S-CLEAN1 REVIEW list + any not merged/stale.
# Examples from prior: early audit-chain, hal wiring, specific migrations that may have value.
# DO NOT DELETE until diff vs main + subject reviewed.
# ============================================================
echo "# GROUP 4: REVIEW (unique work — inspect before delete)"
# git push origin --delete origin/docs/hal-canonical-v1 || true   # example only
# ... list from scratch/S-CLEAN1_review.txt or re-diff interesting subjects (migrations, feat( not demo)
echo ""

# ============================================================
# GROUP 5: KEEP (active sprint / current work)
# ============================================================
echo "# GROUP 5: KEEP (active)"
# - origin/feat/ga-2026-06-01-docs-overhaul (under co-sign)
# - Recent CC/GA sprint branches post 2026-05-25 that are not yet merged (rls-lockdown waves, s-stable, hal-measure, crosscheck, zkp, authority fixes, etc.)
# - Any with open PRs or explicit "do not delete" in subject
echo ""

echo "=== END ==="
echo "After all deletes: git fetch --prune && echo 'Engine remotes:' && git branch -r | wc -l"
echo "Same for trinity-symphony-shared."
echo "Target: significantly under 20-30 active feature branches total."
