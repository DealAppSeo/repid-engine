# Cloud Build-Loop — setup & operation

Runs the HyperDAG autonomous build-loop **entirely in GitHub Actions** — zero footprint on Sean's machine. Workflow: `.github/workflows/build-loop-cloud.yml`.

## Why
The local loop kept crushing a 16 GB box by re-running `tsc`/`jest`/worktrees. All verification already happens in cloud CI (`test` / `crosscheck` / `gitleaks`). This moves the *build* half to the cloud too, so building → measuring → learning continues without the laptop in the loop.

## One-time setup (Sean — ~3 minutes)
1. **Create a fine-grained PAT** (github.com → Settings → Developer settings → Fine-grained tokens):
   - Repository access: **only `DealAppSeo/repid-engine`**.
   - Permissions: **Contents → Read and write**, **Pull requests → Read and write**.
   - Copy the token.
2. **Add two repo secrets** (repid-engine → Settings → Secrets and variables → Actions → New repository secret):
   - `ANTHROPIC_API_KEY` — an Anthropic API key. **This is what bills** — the loop calls Claude each beat.
   - `LOOP_GH_PAT` — the PAT from step 1. *(Required, not optional: the default `GITHUB_TOKEN` cannot trigger the CI checks on PRs it opens — a GitHub anti-recursion rule — so the loop's PRs would never get verified. The PAT fixes that.)*

## Test before going hands-off
1. Actions tab → **hyperdag-build-loop-cloud** → **Run workflow** (manual `workflow_dispatch`).
2. Watch the run: it should read the contract, open a PR, and set `--auto`. Confirm the PR then gets CI + crosscheck + gitleaks and merges on green.
3. Only once a beat looks right: **uncomment the `schedule:` block** in the workflow (hourly `7 * * * *`) → commit → it's now hands-off.

## IMPORTANT — don't run two loops
Once the cloud loop is scheduled, **disable the LOCAL scheduled task** so beats don't run in two places (double PRs, conflicts):
- Ask Claude to disable it, or
- Disable `hyperdag-build-loop` in the scheduled-tasks UI.

## Cost & safety knobs (in the workflow)
- **Cadence:** `schedule` cron — dial hourly → every few hours to cut API spend.
- **`timeout-minutes: 30`** — hard per-beat cap.
- **`--max-turns 40`** — bounds a beat's work.
- **`--model claude-sonnet-5`** — cost/capability default; bump to Opus only for hard beats.
- **`concurrency` (cancel-in-progress: false)** — only one beat at a time.
- **Guardrails in the prompt:** shadow-first (never flips Sean-gated flags), `--auto` only on safe-class PRs, never an immediate merge, surfaces real decisions to the ledger.
- The `enforce_admins=true` + required `test` check means **nothing merges without green CI**, agents included — so even a bad beat can't land unverified.

## Adjust if the first run fails
This is a scaffold. If the action rejects the model id or an input, tweak `claude_args` / inputs in the workflow (the action is `anthropics/claude-code-action@v1`). The rest (triggers, permissions, PAT, concurrency) is standard and correct.
