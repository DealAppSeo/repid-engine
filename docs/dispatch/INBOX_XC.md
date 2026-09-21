# INBOX_XC — red-team the deliverer BEFORE its cron is switched on

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is findings returned as
text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC.md \
  --requires reasoning,repo_read
```

---

### Why this task exists

A bridge was just built between two queues that had never touched. `claude-cloud` writes
rows into the `ai_dispatch` table; the working dispatcher (`run-agent.mjs`) reads
`docs/dispatch/INBOX_XC.md`, a git file. `docs/dispatch/MAILBOX_DELIVERY.md` states it
outright: *"a deliverer has never existed."* `scripts/dispatch/deliver-inbox.mjs` is now
that deliverer, and `.github/workflows/deliver-inbox-cloud.yml` is the scheduler.

**Its cron is commented out and has never run on a schedule.** You are being asked in the
window between "it exists" and "it runs unattended every fifteen minutes", because that is
the only cheap moment. Once it is on, it takes a row written by something else, turns that
row's `content` into an LLM prompt, and runs it on a GitHub runner that is holding a
Supabase service-role key and a GitHub PAT — with no human watching any individual run.

**You are red-teaming work that was authored in the same session that is briefing you.**
Say so plainly where you find something. The brief below states what was already found and
fixed; do not stop at re-finding those.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell` or `hyperdag-protocol`, and you cannot
check out a branch. Do not claim to have read a file outside this repo, and do not invent
its contents.

**The trust vocabulary — four states, and the distinctions ARE the product:**

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning, **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED.

**The trust boundary, stated exactly, because everything below turns on it:**

- A row's `content` field becomes the agent's prompt **verbatim**. It is written to a temp
  file and passed as `--inbox <path>`, so it never reaches a shell command line. That
  closes command injection. It does **not** close prompt injection, and nothing claims it
  does.
- The agent that receives it holds `reasoning, repo_read` — **no shell, no write scope.**
  Whether that is *enforced* by `run-agent.mjs` or merely *requested* is the first thing
  worth establishing, and it is the hinge of most of what follows.
- The runner executing all of this holds, simultaneously: a Supabase **service-role** key
  (`rolbypassrls = true` — it ignores every RLS policy on the project), `LOOP_GH_PAT` with
  `contents: write` and `pull-requests: write`, and a credential file at the path named by
  `TRUSTKEYS_ENV_MASTER` containing `XAI_API_KEY`. That file lives in the runner temp
  directory, **outside the repository checkout**.

**Two findings are already closed. Do not re-report them as new; do check whether the fix
is complete.**

1. **CWE-94, GitHub Actions script injection.** The workflow inputs were interpolated as
   `${{ inputs.to }}` directly into a `run:` block, so a crafted `to` executed on the
   runner with the keyring in scope. Found by Strix, **reproduced before fixing**. Fixed
   two ways: inputs now arrive as environment variables and are expanded inside a quoted
   bash array, and `to` / `limit` are `type: choice`, validated by GitHub against a literal
   list before the job starts.
2. **Module-scope `process.exit`** made the script untestable; the preconditions moved into
   `checkPreconditions()` behind an `isMain` guard.

**Read these files — they are the subject:**
- `scripts/dispatch/deliver-inbox.mjs` — the deliverer. Read the header comments; they
  state the design intent you are testing against.
- `scripts/dispatch/deliver-lib.js` — `AGENT_FOR` and `buildReply`, the decision logic.
- `scripts/dispatch/inbox-lib.js` — `claimPatch`, `replyPatch`, `releasePatch`. The claim is
  a compare-and-swap. **Establish whether it expires.**
- `.github/workflows/deliver-inbox-cloud.yml` — the scheduler, permissions, credential
  handling and the commented-out cron.
- `scripts/dispatch/run-agent.mjs` — the dispatcher being reused unchanged. Its capability
  refusal, evidence fencing, claim audit and secret pruning are the guarantees this bridge
  is relying on without re-implementing. **Relying on a guarantee is not the same as that
  guarantee holding.**
- `scripts/dispatch/read-inbox.mjs` — the prior art, and a worked example of the failure
  this repo keeps making: it selects on `read_at IS NULL`, `dispatch-triage` stamps
  `read_at` within about seven minutes, so it matches zero rows on any coarser schedule —
  and its zero-row branch printed VERIFIED. **An empty result reported as success.**

---

### Deliverables — four sets of findings

### 1. The selector, and who can reach it

The deliverer selects on `status = 'triaged'` **and** `reply_from = 'dispatch-triage'` and
an age floor of `DISPATCH_MIN_AGE_MIN`.

Reason about what it takes to get a row selected, and therefore to get arbitrary text in
front of an LLM running on that runner. Who or what can write a row; who or what can set
those two fields; whether the age floor is a control or only a settling delay; and what a
row crafted specifically to be selected would look like.

**Then the question that matters:** given the agent holds no shell and no write scope, what
is the *worst reachable outcome* of a hostile `content`? Argue it concretely rather than
asserting that prompt injection is bad. Consider at minimum: the credential file sitting
outside the checkout, what `repo_read` actually permits, and the fact that the agent's
output is written back into a database row that a human will later read to decide whether
this system is behaving.

**Name the single highest-severity path you find, and say plainly if you find none.**

### 2. Attack the honesty of the reply

`buildReply` exists because this system has twice caught fabricated self-reports — a commit
hash that did not exist, and a claimed HTTP 200 against an endpoint that 404'd. So the
reply is built from things checked after the run: the exit code, git state, and whether a
transcript appeared. Agent output is fenced under a CLAIM heading.

**Attack that separation.** The VERIFIED section is supposed to be untouchable by the agent
and the CLAIM section is supposed to be visibly quarantined. Examine whether each actually
is. Specific things worth your attention, not as a checklist to tick but as starting points:

- The agent's output is interpolated into a fenced block. What does agent-authored text
  containing a fence delimiter do to the rendered reply a human reads?
- `transcripts` is decided by whether a changed path *contains* the substring `reports/`.
- New-file detection subtracts the before-state by line containment. What happens to a file
  that was already dirty before the run?
- `ok` is `exit code 0 and no spawn error`. Enumerate the ways a run can exit 0 having
  accomplished nothing, and say whether the reply would read as `done`.

For each: does it let an agent, or a hostile row, cause a reply that a human would read as
stronger evidence than it is? That is the severity question here — not whether the field is
wrong, but whether being wrong is *visible*.

### 3. The unattended failure modes

The cron is off. Assume it is switched on at fifteen-minute intervals against a backlog,
with nobody reading individual runs for a week.

Reason about what accumulates. At minimum: what happens to a claimed row when the runner is
killed mid-dispatch (the job cap and the inner dispatch timeout are close together — work
out which fires first and what state that leaves); whether two concurrent runs can collide
given the concurrency group and the runner identifier construction; and whether a
permanently misconfigured deployment can sit at exit 2 indefinitely.

**That last one is deliberate and you should attack the decision, not just describe it.**
Exit 2 is `NOT_CHECKED` and is surfaced as a warning, not a failure, on the stated reasoning
that a workflow which goes red for environmental reasons trains readers to ignore its red.
Both directions have a cost. Say which is worse *here*, and what would make the yellow state
impossible to ignore forever without making it noise.

### 4. What must be true before the cron goes on

A short list of preconditions, each with the reason it is on the list and how it would be
checked. This is the list the operator reads before uncommenting two lines, so a short list
that is actually checkable beats a long one.

State explicitly which preconditions are MEASURED today, which are NOT_CHECKED, and which
cannot be established without running the thing.

---

### Acceptance criteria

- Every finding names the file and the mechanism, not just the symptom.
- Every status distinguishes all four vocabulary states. No two-state booleans.
- Each finding carries **what it does NOT establish**. A boundary stated is worth more than
  a claim overreached.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.
- Severity is ranked by **which way the control fails**, not by how alarming the component
  sounds. A gate that fails closed and a gate that fails open are not comparable.
- If you conclude the design is sound on some axis, say so and say what would change your
  mind. A red-team that finds nothing and reports that honestly is a result.

### What will be rejected

- Any claim you read a file outside this workspace, or read a branch other than the one
  checked out.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. **If you did not run it, you did not run it.**
- Re-reporting the two closed findings above as new discoveries.
- A recommendation to loosen an authorization path without stating its failure direction.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not include
credentials, project identifiers, row counts or service names in your output.
