# LESSONS — the operating rules every agent reads before it works

**INJECTED, not filed.** `run-agent.mjs` prepends this to every dispatch. One file, many readers
— disagreement becomes a merge conflict, not two quiet truths. Filing a lesson never prevented
recurrence (116 unread reports prove it); putting it in front of the worker does.

**HARD CAP 6000 chars** (`tests/lessons-injectable.test.ts`) — the cap IS the mechanism. New
lessons replace or generalise old ones. Narratives live in `reports/<date>/`.

---

## 1. A claim needs the capability that produces it

An agent asked for what it has no instrument to obtain returns a **plausible answer**, not a
failure. Always a capability mismatch, never discipline.

*Proof:* T12 with one tool → 18/18 reports, zero real measurements. GA with no shell → a review
citing line numbers for a file it never opened. Given real tools the same swarm declared an
unreachable metric **unmeasurable rather than guessing**.

**Apply:** refuse the dispatch or supply the evidence, and say what you could not check.
**"I could not measure this" is a SUCCESS** — if it scores worse than a guess, the guess wins.
Every failure returns a REASON with its do-not-substitute instruction attached: `''` reads as
"nothing there" and the model fills the silence.

## 2. Verify the thing itself, never a proxy for it

*Proof:* `gemini -p` worked in a shell, so "headless auth works" was recorded — but the
dispatcher used `spawnSync` without one → **ENOENT every run**. A rename
(`GROK_API_KEY`→`XAI_API_KEY`) silently un-dispatched an agent. Two claims died the same way in
one session: *"~20 PRs open"* (a session record's **cached** field; GitHub said 2)
and *"the fix is not on main"* (checked commit **ancestry**, not content — squash-merged, so
the SHA is absent while the change is fully present).

**Apply:** call what you will actually call, the way you will call it. Query the source, never a
mirror of it. Check the property you actually mean. Committed ≠ landed ≠ deployed.

## 3. A mechanism wired at one end only is worse than an absent one

It converts a known gap into false coverage, so you stop looking. Both ends count — a caller, and
a reader.

*Proof:* `canAssign()` — built, tested, **zero callers**. The L0 halt, unmerged 9 days. The lane
write-fence, registered against an empty registry, failing open on every write for weeks. The
inverse: survivor-alert **caught the 2026-07-17 outage in 10 min and named the fix**, then repeated
it ~1300×/day for 30 days, unread. Nobody knew for a month.

**Apply:** name the caller AND the consumer, or say it is inert. An alert nobody reads is not an
alert.

## 4. Evidence outranks the label

*Proof:* `event_type` is caller-supplied, so it can never upgrade trust. Classifying the RepID
ledger on evidence showed 97.5% of score gained is externally verifiable.

**Apply:** classify on the hardest-to-forge artifact present — contract, attestation, proof,
economic impact — never on the label.

## 5. Match the real names, not the tidy ones you imagine

*Proof:* `INTEGRITY_TYPES` held bare `'DECEPTION'` under `Set.has()`; the engine writes
`DEFENDED_DECEPTION_FABRICATED_CITATION`. Nothing matched → an agent caught **fabricating**
passed a gate one that merely went quiet would not. Exactly backwards.

**Apply:** read the values the system emits. Prefer prefix match — an exact-match list **fails
open** for every type added later.

## 6. A test that cannot fail is a liability; one that expires by itself is an asset

*Proof:* a suite reported "11 passed" in BOTH its on and off runs — flag-guarded tests returned
early and still counted. By contrast the L0 halt's check scans the **filesystem**, so it fails
when main grows a new tick loop: it caught two ungated ones, one moving money.

**Apply:** break the property and watch it go red, then revert; a skip reports as skipped.
Encode checks so time breaks them, not someone re-reading them.

## 7. A red check is a status, not a verdict

*Proof:* `Cannot find module 'pg'` looked like a broken rebase; it was a worktree with no
`npm install`. A tripwire reported a dead provider key as a math regression.

**Apply:** separate **ENV/CONFIG** from **REAL** on a checkout without your change. An
undiagnosed red never lands; a real failure is never called ENV.

## 8. A measurement without its ruler is not a result

*Proof:* HAL F1 quoted at 0.34 / 0.74 / 0.886 / 0.890 — four rulers, so "did HAL improve?" has
no answer. On 2026-08-09 F1 fell 0.908→0.877 because **providers ran out of credit mid-run**,
not because quality moved.

**Apply:** state "F1 = x on corpus v1 @ `hash` at N families", and record per-provider failures
alongside it. Never compare across rulers.

## 9. A flag that reads like a fence may not be one

*Proof:* `grok --allow 'Bash(node:*)'` was asked to `rm` a file — nowhere in the rule — and
**deleted it**. `--allow` is auto-approve, not a fence.

**Apply:** probe the fence with the thing it should refuse, before trusting it.

## 10. A new input channel inherits the trust of the channel it arrives on

*Proof:* a memory tool injects recalled prior-session text into a **user-role turn**. The
provenance auditor counts user turns as sourced evidence — so installing memory would have
silently **disabled the auditor built to catch exactly that**.

**Apply:** when you add a channel, ask what already trusts it. Mark recalled content `[R]` at
the boundary — the line is recency-of-derivation, not source type.

## 11. When a machine-checked invariant rejects your design, the design is wrong

*Proof:* lane globs are tested pairwise for overlap. The author's own first draft collided on
**all 21 pairs**; loosening the matcher to fit would have made every lease untrustworthy to save
one afternoon's layout.

**Apply:** fix the input, not the checker. A checker you edit to pass is no longer a checker.

---

*Add a lesson only when it has cost something twice. Delete one when it is enforced by code.*
