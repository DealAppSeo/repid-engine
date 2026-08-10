# LESSONS — the operating rules every agent reads before it works

**INJECTED, not filed.** `run-agent.mjs` prepends it to every XC/GA dispatch; `CLAUDE.md`
points Claude surfaces at it. One file, many readers, never copied — a disagreement here
surfaces as a version-control conflict, not two silently diverging truths.

**Why:** 116 dated reports here, referenced by nothing. The 2026-07-31 hard-knocks report logs
"unverified inference — again, **third occurrence**"; it recurred twice more on 2026-08-05.
Filing a lesson does not prevent recurrence — only putting it in front of the worker does.

**HARD CAP 6000 chars** (`tests/lessons-injectable.test.ts`). The cap IS the mechanism: an
un-injectable file becomes the 117th report. New lessons must replace or generalise old ones.
Narratives stay in `reports/<date>/`; this holds the rule and its shortest proof.

---

## 1. A claim needs the capability that produces it

An agent asked for something it has no instrument to obtain returns a **plausible answer**, not
a failure. Never a discipline problem; always a capability mismatch.

*Proof:* T12 had one tool (`save_artifact`) → 18/18 reports with zero real measurements. GA had
no shell → a review with invented line numbers for a file it never opened. Given real tools the
same swarm read `real_proofs=22239` correctly and **declared an unreachable metric unmeasurable
rather than guess**.

**Apply:** refuse the dispatch (`canAssign`) or supply the evidence (`--evidence`), and say what
you could not check. **"I could not measure this" is a SUCCESS** — if it scores worse than a
guess, the guess wins.

## 2. Verify the call path, not the component — and the deployed one, not the local one

*Proof:* `gemini -p` worked in a shell, so "headless auth works" was recorded — but the
dispatcher used `spawnSync` without one → **ENOENT every run**, and each attempt left a
transcript that looked like a result. A key rename (`GROK_API_KEY`→`XAI_API_KEY`) silently
un-dispatched an agent. Four fixes sat unmerged while their bugs were live.

**Apply:** exercise what you will actually call, the way you will call it, then confirm the
**deployed** SHA. Committed ≠ landed ≠ deployed.

## 3. An unwired mechanism is worse than an absent one

It converts a known gap into false coverage, so you stop looking.

*Proof:* `canAssign()` — built, tested, **zero callers** — is why dispatch was believed guarded.
Same for `handoff-gate.ts`, `isBehavioral()`, the L0 halt (unmerged 9 days). Wiring it took
minutes and exposed three more defects immediately.

**Apply:** a safeguard is not done until something calls it. Name the caller, or say it is
inert and why.

## 4. Fail loud, and carry the instruction with the failure

*Proof:* a tool returning `''` reads as "nothing was there" and the model invents the content —
the failure the entire swarm toolbelt is built around.

**Apply:** every failure path returns a REASON, and the do-not-substitute instruction travels
*with* it — by the time it is read, the system prompt is thousands of tokens away.

## 5. Evidence outranks the label

*Proof:* `event_type` is caller-supplied, so it can never upgrade trust. Classifying the RepID
ledger on evidence instead showed 97.5% of all score gained is externally verifiable.

**Apply:** classify on the hardest-to-forge artifact present — contract, attestation, proof,
economic impact — never on the label.

## 6. Match the real names, not the tidy ones you imagine

*Proof:* `INTEGRITY_TYPES` held bare `'DECEPTION'`/`'SLASH'` under `Set.has()`; the engine writes
`DEFENDED_DECEPTION_FABRICATED_CITATION`. Nothing matched → the heaviest penalties classified
`unclassified`, so an agent caught **fabricating** would have passed a gate one that merely went
quiet would not. Exactly backwards.

**Apply:** read the values the system emits. Prefer prefix match where a taxonomy grows — an
exact-match list **fails open** for every type added after it was written.

## 7. A green test that cannot fail is a liability

*Proof:* a suite reported "11 passed" in BOTH its on and off runs — flag-guarded tests returned
early and still counted. Three security tests passed vacuously after a fixture edit
desensitised the needle but not the haystack.

**Apply:** break the property and watch it go red, then revert. A skip must report as skipped.

## 8. Prefer checks that expire by themselves

*Proof:* the L0 halt's coverage test scans the **filesystem** for tick loops, so it fails when
main grows one. It caught two ungated loops — one moves money — added during nine days of drift.

**Apply:** encode the check so the passage of time breaks it, rather than relying on someone
re-reading it.

## 9. A red check is a status, not a verdict

*Proof:* `Cannot find module 'pg'` looked like a broken rebase; it was a worktree with no
`npm install`. A golden-math tripwire once reported a dead provider key as a math regression.

**Apply:** separate **ENV/CONFIG** from **REAL** by running the same suite on a checkout
without your change. An undiagnosed red never lands; a real failure is never called ENV.

## 10. A measurement without its ruler is not a result

*Proof:* HAL F1 has been quoted at 0.34 / 0.74 / 0.886 / 0.890 — four different rulers, so "did
HAL improve?" has no answer.

**Apply:** state "F1 = x on corpus v1 @ `hash` at N families". Never compare across rulers.

## 11. A flag that reads like a fence may not be one

*Proof:* `grok --allow 'Bash(node:*)'` was asked to `rm` a file — a command nowhere in the rule
— and **deleted it**. `--allow` is auto-approve, not a fence. `--sandbox <invalid>` was accepted
silently and ran unsandboxed.

**Apply:** probe the fence with the thing it should refuse, before trusting it.

---

*Add a lesson only when it has cost something twice. Delete one when it is enforced by code.*
