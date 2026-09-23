# LESSONS — the operating rules every agent reads before it works

**INJECTED, not filed.** `run-agent.mjs` prepends this to every dispatch; a SessionStart hook
injects it into Claude sessions. One file, many readers — disagreement is a merge conflict, not
two quiet truths. Filing a lesson never prevented recurrence (116 unread reports prove it).

**HARD CAP 6000 chars** (`tests/lessons-injectable.test.ts`) — the cap IS the mechanism, never
raise it. Every RULE plus a one-line proof; narratives live in `lessons/<domain>.md` packs the
dispatcher appends by trigger. New lessons replace or generalise old ones.

---

## 1. A claim needs the capability that produces it
*Proof:* T12 with one tool → 18/18 reports, zero real measurements; GA with no shell → a review citing line numbers for a file it never opened. [lessons/dispatch.md]
**Apply:** refuse the dispatch or supply the evidence, and say what you could not check. **"I could not measure this" is a SUCCESS** — else a guess that scores better wins. Every failure returns a REASON; `''` reads as "nothing there" and the model fills it.

## 2. Verify the thing itself end to end — a proxy, or one wired end, is worse than nothing
A half-wired mechanism turns a known gap into false coverage — you stop looking.
*Proof:* `gemini -p` worked in a shell so "headless auth works" was recorded, but the dispatcher's `spawnSync` had none → ENOENT; `canAssign()` built + tested with zero callers; a daemon logged COMPLETE while its DB update silently failed, losing 7 handoffs. [lessons/dispatch.md]
**Apply:** call what you will call, how you will call it; name the caller AND the consumer, or say it is inert. Exit 0 covers the last command, not your intent. Check the write's error. Installed ≠ runnable; committed ≠ deployed.

## 3. Evidence outranks the label
*Proof:* `event_type` is caller-supplied, so it never upgrades trust; a filename and a doc line are labels too — rule 10. [lessons/hal-eval.md]
**Apply:** classify on the hardest-to-forge artifact present — contract, attestation, proof, economic impact — never on the label.

## 4. Match the real names, not the tidy ones you imagine
*Proof:* `INTEGRITY_TYPES` held bare `'DECEPTION'` but the engine writes `DEFENDED_DECEPTION_FABRICATED_CITATION`, so a fabricator passed a gate; a `status` CHECK rejected `CANCELLED`. [lessons/schema.md]
**Apply:** read the values the system emits; query the real schema/constraints. Prefer prefix/substring match — an exact-match list **fails open** for every value added later.

## 5. An instrument that cannot return the other answer has measured nothing
**An ABSENCE — NULL, 0 rows, no match, "not set" — is not evidence until the instrument is shown capable of a PRESENCE.** Tests, greps, queries, views, controls: one defect.
*Proof:* a suite reported "11 passed" in both its on and off runs; a non-vacuity check grepped a symbol jest never emits, so 3 induced failures read as success; `v_fleet_truth_realwork` NULLs a 7-day LEFT JOIN over a 2-row table — read as "12 agents never worked". They had. [lessons/dispatch.md]
**Apply:** break the property, watch it go red, revert; a skip reports as skipped. Read the view (`pg_get_viewdef`) and the query window before believing a NULL. Encode checks so time breaks them. **A fence is an instrument** — probe it with what it should refuse: `grok --allow 'Bash(node:*)'` was asked to `rm`, and did.

## 6. A red check is a status, not a verdict
*Proof:* `Cannot find module 'pg'` was a worktree with no `npm install`; ~150 "failures" were a Windows-only ESM path + a dummy Supabase URL satisfying a presence check, all green on CI. [lessons/schema.md]
**Apply:** separate **ENV/CONFIG** from **REAL** on a checkout without your change. An undiagnosed red never lands; a real failure is never called ENV.

## 7. A measurement without its ruler is not a result
*Proof:* HAL F1 quoted at 0.34 / 0.74 / 0.886 / 0.890 — four rulers, no answer; on 2026-08-09 F1 "fell" only because providers ran out of credit mid-run. [lessons/hal-eval.md]
**Apply:** state "F1 = x on corpus v1 @ `hash` at N families", with per-provider failures beside it. Never compare across rulers.

## 8. A new input channel inherits the trust of the channel it arrives on
*Proof:* a memory tool injects recalled text into a user-role turn, which the provenance auditor counts as sourced evidence — installing it would have disabled the auditor built to catch that.
**Apply:** adding a channel (memory, MCP browser, fetch), ask what already trusts it. Mark recalled/fetched content `[R]` at the boundary — the line is recency-of-derivation, not source.

## 9. When a machine-checked invariant rejects your design, the design is wrong
*Proof:* lane globs are tested pairwise; a first draft collided on all 21 pairs, and loosening the matcher to fit would have made every lease untrustworthy. [lessons/zkp.md]
**Apply:** fix the input, not the checker. A checker you edit to pass is no longer a checker.

## 10. Fix the thing AND whatever says the wrong thing about it
*Proof:* CLAUDE.md called `plonky3-stub.ts` "always-on" — zero callers, while the live path had written 22,373 attested proofs since June. A later session read that back as fact: a wrong line outlives the bug.
**Apply:** correct the describing file in the SAME change — comment, CLAUDE.md, AGENTS.md, README — saying what was wrong, not only what is right. TRUE NORTH is the entry point of the repo you are in — read it first; never a checked-in list of the others.

## 11. A blocked gate is no reason to stop
*Proof:* 2026-09-23 — a session said "nothing left I can move without you" while four repos, HAL and zkRepID were unblocked.
**Apply:** blocked → move DOWN the list: this surface → the next → tomorrow's → the week's. Send the one-word decision needed; keep working. Only an **irreversible outward** act waits: publish, mint, spend, permanent write.

---

*Add a lesson only when it has cost something twice. Delete one when code enforces it.*
