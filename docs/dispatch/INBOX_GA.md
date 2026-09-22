# INBOX_GA — the evidence contract: what makes a claim mechanically checkable

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is a specification
returned as text. Do not claim to have created, edited or committed a file. You hold
`reasoning` and `repo_read`, scoped to THIS workspace only. You cannot open
`trinity-ecosystem`, `trustshell` or `hyperdag-protocol`, you cannot reach the database,
and no evidence commands were run for you.

**Three outcomes, never two: VERIFIED / NOT_CHECKED / FAILED.** If you cannot determine
something from this workspace, write NOT_CHECKED and say what would settle it. That is a
SUCCESS, not a gap in your answer.

---

### Why this task exists

Across 363,121 task rows in this system, **143,219 are marked `done` and 139 were ever
`verified`.** Agents close their own work. Every trust mechanism the schema declares —
`verification_triad`, `rep_id_stake`, `final_verdict` — has zero or near-zero rows using
it. The harness is declared, not running.

The fix being designed is a gate in two halves: **deterministic facts checked in code
with no LLM**, and only then a judgment about whether those facts support the claim. Your
half is the first one. Until an artifact carries something a machine can check, no
verifier — human, agent or model — is doing anything but reading prose and believing it.

The claims that need checking look like this today, verbatim from production:

    "The task is complete. The 'save_artifact' tool has been called to finalize the
     Agent Health Sweep report."
    "The WSCE Calibration Check task has been completed, and the results have been
     saved as a report artifact."
    "The EVERGREEN spawn 142168 task has been completed, and the report has been saved
     as an artifact."

Note what they have in common: each asserts completion and names an action, and **none
carries anything that can be checked without asking the agent again.**

---

### What to return

**1. The evidence envelope.** Specify the minimum structure a completing agent must
return alongside its claim so that a verifier holding no LLM can reach a verdict. For
each field: its name, its type, what it proves, and — critically — **what it does NOT
prove.** Keep it small. A schema nobody fills is the same failure as no schema.

**2. Map it to task types that actually exist here.** Read this repo to find the real
shapes of work (the routes, the workers, the scripts under `scripts/`, the services under
`src/services/`). For at least four distinct kinds of task, state the specific evidence
that kind can produce. A task type whose work leaves no checkable trace is an important
finding — name it rather than inventing evidence for it.

**3. Predicates, written as decisions not prose.** For each evidence field, give the
check a verifier runs and the three outcomes it can return. Be explicit about which
observations yield NOT_CHECKED rather than FAILED — for example, an endpoint that could
not be reached is not an endpoint that answered wrong.

**4. The vacuous-pass list.** For each predicate, name the cheapest way to satisfy it
without doing the work: the empty file that exists, the test that passes because it
asserts nothing, the 200 from a handler that ignored its input, the git commit that
touches only whitespace. Say which predicates you could not break — that is the useful
half.

**5. Where this repo already does it right.** There is at least one place here that
already builds a verdict from artifacts observed AFTER a run rather than from what the
agent said about itself, and treats the agent's own words as a fenced claim. Find it,
name the file, and say what its pattern gets right and where it is still weak. If you
cannot find it, say NOT_CHECKED rather than guessing a filename.

**6. What you could not determine from this workspace**, and the single observation that
would settle each one.

---

Worked example of the mistake most likely here, from this repo's own history: an end-to-end
suite once minted a credential, never sent it, and reported the resulting failure as
"public endpoint not deployed" — a confident claim about the server that was simply not
true. The instrument was never shown capable of the other answer. Before you assert that
something is checkable, say what a failing check would look like.
