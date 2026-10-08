# INBOX_XC: propose SAFE improvements to HAL and RepID — ranked, no scoring changes

## Task

**Lane:** REVIEW + PROPOSE. You have **no write scope**: the deliverable is text. Do not claim to
have created, edited, run, built or committed anything. You hold `reasoning` and `repo_read` on
`repid-engine` (branch `claude/bold-turing-icz50x`) and read-only `./trustshell`. **Three outcomes:
VERIFIED / NOT_CHECKED / FAILED** — "reads as if it works" is NOT_CHECKED. Dispatched by CC (Claude)
2026-10-08. Sean asked to "improve HAL and RepID functionality." He is asleep; this is analysis for
when he wakes, plus a menu CC can act on the SAFE items from.

## Hard constraints (these are fences, not suggestions)

Per `CLAUDE.md` and `LESSONS.md`:
- **Do NOT propose changing tuned scoring constants** (the RepID formula `T=floor(2000×log10…)`, ANFIS
  parameters, `src/config/scoring-params.ts`, `src/scoring/repid-constants.ts` values). Those are
  hard-stops; naming them in a proposal is fine, changing them is forbidden.
- **A change that moves every future score is a DECISION, not a cleanup** — flag it as "needs Sean",
  never as "safe to do". The ecosystem-need multiplier (computed in the pipeline but never applied to
  the delta — `src/engine/repid-update.ts`, `getEcosystemNeedWeight`) and `FIXED_DELTAS.STAKE` being
  forced to 0 are examples: say what they are, mark them DECISION.
- **Three outcomes everywhere.** HAL's whole job is that NOT_CHECKED never reads as a pass.

## What to produce — a ranked menu, each item tagged SAFE or DECISION

Read the real code (cite `file:line`), do not trust comments. Cover both layers:

**HAL (honesty / verification):** `src/layers/constitutional-audit.ts`, `src/services/pcp-validator.ts`,
`src/engine/repid-update.ts` (the audit gate), `src/routes/hal-evaluate.ts`, `src/services/cascade-settlement-worker.ts`,
the family-quorum / drain-gate logic, and `src/classify/free-votes.ts`. Look for: a place a miss can
still read as a pass; a NOT_CHECKED collapsed into a verdict; a one-family result treated as agreement;
a validator that scores 0 on a thrown call rather than dropping it; an honesty gap between what a
response claims and what it measured.

**RepID (reputation):** `src/engine/repid-update.ts`, `src/scoring/*`, the tier trigger / counterparty
gate (DB), `src/routes/repid.ts`, `repid_score_events`. Look for: an audit-trail field that records a
value that moved no score (the ledger lying by omission), a decay/redemption path that can't be read
back, a missing `repid_score_events` row on a path that writes `current_repid`, a tier that can lag its
inputs without being observable.

For EACH finding give: `file:line`, what it is, the failure direction (which way it is wrong), whether
fixing it is **SAFE** (adds observability, a test, a NOT_CHECKED guard, an honest label — changes no
score) or a **DECISION** (moves scores / changes behavior Sean must approve), and the smallest change
that fixes it. Rank SAFE-and-high-value first.

Also: name anything already CLOSED so CC does not rebuild it — grep `reports/` and `LESSONS.md`.

## Deliverable

A ranked list, SAFE items first, each with `file:line`, failure direction, SAFE/DECISION tag, and the
minimal fix. End with the ONE improvement you would make first and why. If a category is clean, say
NOT FOUND and list what you read. Remember: you cannot run anything, so every "it works" is NOT_CHECKED.
