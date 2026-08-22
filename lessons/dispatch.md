<!-- triggers: dispatch daemon run-agent run-sprint sprint queue inbox agent lane handoff swarm capability spawn worktree -->
# Dispatch / daemon / agent-runner lessons

Full narratives behind LESSONS §1, §2, §3, §6. Appended when a brief concerns dispatch.

## Capability produces the claim (§1)
An agent asked for what it has no instrument to obtain returns a **plausible answer, not a
failure** — always a capability mismatch, never discipline. T12 with one tool produced 18/18
reports and zero real measurements. GA, holding no shell, returned a PR review citing exact line
numbers for a file whose own stderr showed it never opened it (`Path not in workspace`,
`run_shell_command not available`). Given real tools, the same swarm declared an unreachable
metric **unmeasurable rather than guessing**. Fence WHERE each lane may write and verify what it
reports; a finding is `[reported]` until a query/test/chain-read makes it `[verified]`.

## Verify the call, not a proxy (§2)
`gemini -p` worked in an interactive shell, so "headless auth works" was recorded — but the
dispatcher used `spawnSync` with no shell → **ENOENT**, and GA never ran once. "Not on main"
checked ancestry, not content: a squash-merge hides the SHA, not the change. `npm i -g pkg@latest`
**succeeded** and installed a build this Node cannot run (npm warns on an unmet engine, never
refuses) — installed ≠ runnable. A confirming script "exited 0" for the `git` call that ran last,
not for the intent. Exit 0 covers the last command in a chain; capture the summary you actually
care about.

## Wired at one end = false coverage (§3)
`canAssign()` was built and tested with **zero callers**. The L0 halt sat unmerged 9 days. The
lane write-fence was registered against an empty registry, failing open on every write for weeks.
Two dispatch-specific instances measured here:
- **Self-chain deadlock:** `run-agent` writes a tracked transcript to `reports/` and refused a
  dirty tree, so dispatch #2 refused on dispatch #1's own output — the loop was never capable of a
  second cycle. Fixed by excluding `reports/` from the pre/post cleanliness check (still refuses
  `main`, still refuses real source edits, still no auto-commit). Validated by two consecutive
  dispatches in one tree.
- **Unchecked write = silent loss:** `sprint-daemon` logged `phase N: COMPLETE` while its
  Supabase `.update({status,handoff_body,…})` returned an error it never checked. GA's updates
  landed (8/8); XC's did not — 7 phases ran and were paid for, but their handoffs never reached
  the queue (transcripts survive only in `reports/`). Check the write's `error`, not just that you
  called it. This is the L9 ledger-vs-state divergence in a new dress.

## A test that cannot fail (§6)
A suite reported "11 passed" in BOTH its enabled and disabled runs — flag-guarded tests returned
early and still counted. Encode checks so time/main-drift breaks them (filesystem scans), not a
human re-reading. Break the property, watch it go red, revert. A skip must report as skipped.
