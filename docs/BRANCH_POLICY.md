# Branch policy

Adopted S-QUORUM (2026-06-02), after a cleanup that deleted 103 merged remote branches on
repid-engine and 18 on trinity-symphony-shared.

## Rules

- **`main` is protected.** CI (`.github/workflows/ci.yml` — `tsc --noEmit` + `npm test`) must pass
  before merge. Make it a *required check* in Settings → Branches → branch protection.
- **No self-merge.** A second reviewer (Cowork) co-signs. **No Railway deploy from a PR** — Sean
  deploys after reviewing merged `main`.
- **Branch naming:** `feat/<author>-YYYY-MM-DD-<short-description>`
  (e.g. `feat/cc-2026-06-02-quorum-fix`). Use `fix/`, `docs/`, `chore/`, `ci/` prefixes as apt.
- **One concern per branch.** Prefer small PRs (~≤10 files); split unrelated work.
- **New behavior is opt-in** — gate it behind a default-off env flag (`HAL_STRICTNESS`,
  `TOOL_CALL_LOGGING`, `CAPABILITY_FILTER`, `HAL_SCORE_V2`, …) so merging changes nothing until
  the flag is flipped. Tests must pass with flags at their defaults.
- **Schema changes are design-only in-repo:** put migration SQL under `scripts/migrations/` with a
  rollback line; Sean applies it (the repo never auto-runs DDL).

## Lifecycle / cleanup

- **Delete merged branches.** A branch whose tip is reachable from `origin/main` is fully merged and
  should be deleted (`git push origin --delete <branch>`). Enable "Automatically delete head branches"
  in repo Settings so this happens on every merge.
- **Periodic sweep** (safe — only touches merged branches):
  ```bash
  git fetch --prune origin
  for b in $(git branch -r --merged origin/main | grep -v "HEAD\|origin/main$"); do
    git push origin --delete "${b#origin/}"
  done
  ```
- **Unmerged branches are preserved** by `--merged` — real WIP is never deleted by the sweep. If an
  unmerged branch is abandoned, close its PR and delete it deliberately.

## Deconfliction

When a change overlaps an actively-rewritten file (e.g. `lib/ConstitutionalAgentV4.js` while GA's
`feat/ga-…-t12-concurrency` is in flight), keep the change **small + flag-gated**, ship it on its own
branch, and **flag it for the owner to fold in** rather than blind-merging into a conflict.
