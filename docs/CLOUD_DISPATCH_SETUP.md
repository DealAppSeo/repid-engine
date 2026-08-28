# Cloud dispatch (XC / GA) — setup & operation

Runs **one XC or GA task in GitHub Actions**, entirely off Sean's Windows machine.
Workflow: `.github/workflows/dispatch-agent-cloud.yml`. Sibling to
`docs/CLOUD_BUILD_LOOP_SETUP.md` (T12's cloud loop) — same shape, same PAT, same
"test with workflow_dispatch before trusting it" discipline. Design this
implements: `docs/AGENT-DISPATCH-ENGINE-DESIGN.md`, rollout step 3.

## Why

XC and GA were never actually unreachable by GitHub — they were never reachable
by anything except a human at a specific machine (`E:/dev/handoffs`,
`C:/Users/Cash4/repos/.env.master`) manually running
`scripts/dispatch/run-agent.mjs`. Queuing work in `docs/dispatch/INBOX_XC.md` /
`INBOX_GA.md` is not dispatch if nothing invokes it unattended. This wraps the
same script, unmodified, so a GitHub Actions runner can be the "human" that runs
it.

## One-time setup (Sean — ~5 minutes)

1. **Reuse the existing PAT** from the T12 cloud-loop setup (`LOOP_GH_PAT`) — no
   new token needed. It already has `Contents: Read/Write` + `Pull requests:
   Read/Write` on this repo, which is everything this workflow needs too.
2. **Add repo secrets** (repid-engine → Settings → Secrets and variables →
   Actions → New repository secret):
   - `XAI_API_KEY` — XC's (grok) credential, from console.x.ai. `GROK_API_KEY`
     is accepted too if that's the name already on hand (`run-agent.mjs`
     accepts both — see its `AGENTS.xc.keyVars`).
   - `GEMINI_API_KEY` — GA's (gemini) credential. `GEMINI_API_KEY_2` accepted as
     a fallback name the same way.
   - `REPID_API_KEY` — **optional.** Only used to harvest `LESSON:` blocks the
     agent writes back to the pgvector recall API. Dispatch works without it;
     you just lose the harvest (reported on stderr, never fails the run).

   Nothing else — `LOOP_GH_PAT` (step 1) is a secret already, not something to
   re-add.

## Test before trusting it

1. Actions tab → **dispatch-agent-cloud** → **Run workflow** → pick `agent: xc`
   (or `ga`) → optionally fill `ref_note` with why you're running it manually.
2. Watch the run. Four things have to be true, in order, or it isn't real:
   - **Install agent CLI** succeeds (this step has never run before in CI — the
     package names `@xai-official/grok` / `@google/gemini-cli` are verified
     against npm as of 2026-08-27 but NOT yet exercised here; if either is
     wrong, this is where it shows).
   - **Dispatch `xc`/`ga`** step's log shows a real invocation, not an instant
     ENOENT.
   - A PR opens (draft) carrying one new file under `reports/<date>/DISPATCH_*.md`.
   - **Read the claim manifest at the top of that file first** — it names
     whether the run actually had a shell (no), whether evidence was supplied,
     and whether any execution-shaped claim in the output is grounded in that
     evidence. This is the same manifest `run-agent.mjs` has always produced
     locally; nothing about running it in Actions changes what it means.
3. Only trust a scheduled/automated cadence for this **after** a second real
   need appears — per the design doc's rollout plan, this stays
   `workflow_dispatch`-only on purpose. Run it by hand, the same way Beat 63
   tested T12's loop before its schedule was turned on.

## What this does NOT do

- **No auto-merge, ever, at any tier.** XC/GA hold no write scope (`reasoning +
  repo_read` only — no `shell`), so the only thing this workflow can produce is
  a transcript under `reports/`. That transcript still needs "a different model
  family" to read it before anything downstream treats its claims as fact —
  that rule is `run-agent.mjs`'s own, unchanged by running it in the cloud.
- **No new capability, no relaxed fence.** Capability refusal, the evidence
  allowlist, the claim audit, secret pruning + scrubbing, and the safe-repo-state
  guard are all the exact same code that already runs locally. This workflow is
  the adapter (GitHub secrets → the one `.env.master`-format temp file the
  script expects) — see Part 1 step 2 and Part 3 of
  `docs/AGENT-DISPATCH-ENGINE-DESIGN.md`.
- **No schedule.** Unlike T12, XC/GA tasks here are one-shot specs, not an
  open-ended backlog loop — there is nothing yet to run on a cadence.

## If the first run fails

That is expected to be informative, not embarrassing — this workflow has never
executed before. Likely failure points, in the order they'd surface:
1. **CLI install fails** → the package name for that CLI has drifted or was
   wrong. Fix the `npm install -g` line in the workflow.
2. **Dispatch step reports `res.error` (ENOENT) immediately** → same as (1), or
   the CLI's real binary name differs from `grok`/`gemini` after install.
3. **Dispatch step exits non-zero with real output** → read the transcript; this
   is the normal "the agent said something, here's why the harness flagged it"
   path and is exactly what the claim manifest exists to surface.
4. **No PR opens at all** → check the "Dispatch" step log for a refusal from
   `capabilityRefusal`/`assertSafeRepoState` — those exit before any file is
   written, by design (Part 5's floor: refuse before producing a plausible but
   ungrounded transcript).
