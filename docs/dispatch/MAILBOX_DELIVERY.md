# ai_dispatch — the mailbox has a reader and a triager, and no deliverer

**Measured 2026-09-08 against the live table.** Everything below with a number attached was
counted, not inferred. Re-run the queries before quoting any of it later.

## What the mailbox is

`ai_dispatch` is an agent-to-agent message table. Its columns are
`id, from_ai, to_ai, subject, content, priority, requires_response, thread_id, status,
read_at, reply, reply_at, reply_from, sprint, created_at` — a mailbox with read receipts.

## The path a message actually takes today

```
  agent inserts a row                        ← the WRITER. works.
        │
        ▼
  dispatch-triage stamps read_at + reply_at  ← the TRIAGER. works. external to this repo.
  and writes a fixed-form reply:
  "TRIAGE — automated. Content was read as
   DATA and NOT executed. […] needs a reply
   from a human/agent: YES"
        │
        ▼
       ✗ nothing                             ← the DELIVERER. DOES NOT EXIST.
```

The triager's own reply ends by asserting that a human or agent still has to answer. Nothing
consumes that assertion. A message is classified and stops there.

## The deliverer was never built. It did not break.

This distinction matters, because "it broke" sends the next agent looking for a regression to
revert, and there is none to find. Evidence:

1. **No file matching `deliver*` has ever existed in this repository's history.**
   `git log --all --diff-filter=A --name-only` over every commit returns nothing.
2. **The string `dispatch-triage` appears nowhere in the repo, working tree or history.**
   The triager is an external writer against the same Supabase table. Whatever schedules it
   is not in this codebase, so this repo cannot be the place its behaviour is changed.
3. **`scripts/dispatch/read-inbox.mjs` was never intended to be the deliverer.** It is a
   reader-*replier*: it answers `#tag` questions it can answer from the database, and one
   handler ships (`#fleet`, from `v_agent_state`). Anything else is reported UNHANDLED and
   deliberately left unread. Answering a question is not delivering an instruction.
4. **PR #486 is the only commit that has ever touched it**, and it shipped exactly three
   files — the script, `inbox-lib.js`, and `tests/inbox-reader.test.ts`. No caller, no
   scheduler, no delivery leg was ever part of it.
5. **The gap was named at the time and left open on purpose.**
   `reports/2026-07-25/AUTONOMOUS_LOOP_LEDGER.md` records: *"I have no verified path from
   'agent produces text' to 'repo artifact a verifier can check' … It needs a real
   dispatch→artifact→verify loop designed first."*

So the honest statement is: **a deliverer has never existed**, and the ledger shows that was a
considered decision rather than an oversight.

## The reader is currently blind, and used to say VERIFIED about it

`read-inbox.mjs` selects candidates with `read_at IS NULL`. That was correct when it was
written — every row had `read_at` NULL going back months, which is the whole reason the file
exists.

That has inverted:

| measured 2026-09-08 | value |
|---|---|
| rows in `ai_dispatch` | 48 |
| rows with `read_at` set | 48 |
| rows with `reply_at` set | 48 |
| distinct `reply_from` values | **1** (`dispatch-triage`) |
| rows with `status = 'triaged'` | 48 |
| triager first write | 2026-08-31, backfilling rows created from 2026-04-04 |
| typical stamp latency on new messages | ~7 minutes |

Because the triager stamps `read_at` within minutes, the reader's candidate query now matches
**zero rows for every inbox, permanently**. Its zero-candidate branch used to print
`VERIFIED. Inbox has no unread messages` — a false green over a mailbox that is being consumed
by something else.

That is the same defect the script's own header was written to prevent, arriving from the
other side, and it is LESSONS rule 6: a check that cannot fail is a liability. **Fixed**: the
empty case now distinguishes an inbox with no rows at all (a true VERIFIED 0) from an inbox
whose rows were all stamped read by somebody other than this reader (**NOT_CHECKED, exit 2** —
"I cannot observe this inbox" is not "nothing was sent").

Note the consequence for anyone running it today: against the live table it will exit 2, and
that is the correct answer, not a failure of the script.

## Running it

```bash
npm run dispatch:read-inbox -- --to cc [--limit 5] [--dry-run]
```

PowerShell (the operator's shell — `&&` and `export` do not work there):

```powershell
$env:SUPABASE_URL = "<project url>"
$env:SUPABASE_SECRET_KEY = "<service key>"
npm run dispatch:read-inbox -- --to cc --dry-run
```

Needs `SUPABASE_URL` and one of `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` /
`SUPABASE_SERVICE_KEY`. Without them it exits 2 = NOT CHECKED, never 0 — "no credential" is
not "inbox empty". `DISPATCH_RUNNER` optionally overrides the claim-provenance prefix written
to `reply_from`.

Exit codes: `0` VERIFIED · `2` NOT CHECKED · anything else FAILED.

**It is deliberately not a `check:*` script.** `npm run check` discovers and runs every
`check:*`, with no Supabase credential and no network guarantee; a mailbox drain is not a
build gate, and wiring it as one would make every `npm run check` exit NOT_CHECKED.

## What still has to invoke it — the open gap, stated rather than filled

**Nothing invokes this script.** No npm script chain, no GitHub workflow, no Railway cron, no
daemon. The npm script added here makes it *discoverable*; it does not make it *run*.

This document deliberately does **not** invent a scheduler. Choosing one is a real decision
with real consequences — a cron that drains a shared mailbox is a write path against a
database this repo does not own, and LESSONS rule 3 is explicit that a mechanism wired at one
end only is worse than an absent one, because it converts a known gap into false coverage.

For whoever does build it, these are the things that must be decided first, not the design:

1. **Who owns the trigger.** The triager already stamps every row within ~7 minutes and is not
   in this repo. A deliverer added here would be racing a scheduler nobody in this codebase
   controls. Find what runs `dispatch-triage` before adding a second writer.
2. **What "unread" means now.** `read_at IS NULL` no longer identifies unanswered messages,
   because the triager stamps it. A deliverer needs a different, agreed liveness signal — the
   obvious candidate is `reply_from = 'dispatch-triage'` marking a message as *triaged but not
   acted on* — and that signal has to be agreed with whoever owns the triager, not assumed.
3. **What "delivered" means.** The triager says a message "needs a reply from a human/agent".
   Until there is a verified path from that to an artifact a verifier can check, a deliverer
   would be moving a row between states and calling it work. This is the exact objection the
   2026-07-25 ledger raised, and it has not been answered since.

Until those three are settled, the honest state of this mailbox is: **written, triaged, not
delivered.** Say that, rather than reporting a drained inbox.
