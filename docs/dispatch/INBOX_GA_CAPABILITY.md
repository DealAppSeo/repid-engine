# INBOX_GA_CAPABILITY — looping sprint: the role → capability → binding contract

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is text. Never claim to have
created, edited, committed or run anything.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA_CAPABILITY.md \
  --requires reasoning,repo_read
```

---

### How this loop works — read before anything else

Multi-phase sprint, not a one-shot. You will be re-dispatched with this brief plus your
previous handoff.

- **No handoff in your input → you are starting at Phase 1.**
- **Handoff present → read its `NEXT_PHASE_READY` and do THAT phase only.**
- **Exactly one phase per dispatch.**
- **Always end with the handoff block.** It is the only thing carrying state.

```
=== HANDOFF GA S<n> ===
PHASE_COMPLETED: <n>
STATUS: COMPLETE | PARTIAL | BLOCKED
DELIVERED:
  - <artifact>: <one line>
FINDINGS:
  - [MEASURED|UNVERIFIED] <finding>
REQUIREMENTS_ON_XC:
  - <property you need XC to attack or price, and why>
OPEN_QUESTIONS_FOR_SEAN:
  - <question only a human can answer>
NEXT_PHASE_READY: <n+1>   (or)   BLOCKED_ON: <what is missing>
=== END HANDOFF ===
```

---

### First: two corrections from your last sprint

Both are yours to carry forward. Neither is a reprimand; both are load-bearing.

**1. Your regime discriminator is wrong.** You wrote that a reader "checks if `policy_version`
starts with `pol1-`" to detect posterior rows. **`pol1-37620edf769590dd` is the current
ADDITIVE baseline.** Every existing additive row already starts with `pol1-`. That
discriminator classifies all of history as posterior. A regime marker must be disjoint from
the regime it distinguishes — design one that cannot collide, and say how you would verify
disjointness rather than assert it.

**2. You marked `[MEASURED]` on a claim you have no instrument for.** "Replaying the ledger
without synthetic baselines results in score deflation" — you have no write scope, no shell and
no database. That is **plausible and probably true, and it is not measured.** LESSONS lesson 1:
an agent asked for what it has no instrument to obtain returns a plausible answer, not a
failure. **"I could not measure this" scores better than a guess.** Mark it `[UNVERIFIED]` and
name the instrument that would settle it.

**3. A cross-lane collision you and XC created together.** XC priced count-dilution: under
count-based updating, ~96 trivial favourable increments make one later unbounded fault move the
posterior mean by ~0.01. Your synthetic backfill derives α/β from an agent's current score —
which hands every existing agent a large fabricated favourable count **on day one**. Migration
as specified would ship the dilution attack pre-installed, with the buffer granted rather than
farmed. This is a real interaction between two correct-looking designs. It belongs in Phase 7.

---

### Why this sprint exists

The swarm already has a capability system, and you can read it:
`scripts/dispatch/run-agent.mjs` holds `KNOWN_CAPABILITIES`, declares capabilities **MEASURED,
NOT DECLARED — absent unless proven**, and **fails closed** on anything unlisted. Read that
file before Phase 1; it is the working primitive this sprint generalises.

Three things it does not do, and this sprint defines all three:

- It is **per-dispatch**, not **per-role**. There is no notion of a CMO agent that always has
  brand-voice and publishing reach and never has database write.
- It says what an agent **can do** but not **what satisfies it** — no binding from a capability
  to the CLI, MCP server, API key or model that provides it.
- It lives in one hardcoded JavaScript array, so it does not survive a change of runtime,
  model, or database. The Trust Harness has to be portable across all three.

The first concrete consumer is a **PAI acting as CMO** — an agent with content, brand and
publishing reach, and deliberately without spend authority, database write, or custody. Design
for that consumer, but define the contract so a CTO, CFO or auditor role drops in without
schema change.

---

### The fact that makes this a trust problem, not a config problem

Capability scoping is not an efficiency measure. It is **the mechanism that makes a claim
trustworthy.** An agent that cannot reach a thing must say so rather than confabulate — that is
LESSONS lesson 1, and it is why this system measures capabilities instead of declaring them.

So a role's capability set is not a preference list. It is closer to a **grant**: a scoped,
bounded, expiring, revocable authority — the same shape as the agent-delegation primitive this
ecosystem already uses for spend. Whether they should be the same mechanism is a Phase 5
question, not an assumption. Do not assume it; argue it.

---

### Facts you need, inlined

`repo_read` is scoped to **this workspace only**. You cannot open `trinity-ecosystem`,
`trustshell` or `hyperdag-protocol`. Do not claim to have read them.

**Trust vocabulary — four states.** `MEASURED` · `APPROXIMATE` · `NOT_CHECKED` · `FAILED`.
Every status field you design must express all four. **A boolean cannot, so do not design one.**

- Existing capabilities: `reasoning`, `repo_read`, `cross_repo_read`, `shell`, `http`, `db_read`.
  Note what is absent: every one is a **read or think** capability. There is no write, no spend,
  no publish, no custody. That asymmetry is deliberate and you must preserve it.
- Existing lanes: XC is L6 RED-TEAM, GA is L7 MEASUREMENT. Neither has write scope.
- The runner prunes the child process environment to that lane's own credential, and scrubs
  every other secret out of transcripts. Credential isolation already exists at the process
  boundary; your contract must not weaken it.
- Existing delegation shape elsewhere in this ecosystem: scope, budget ceiling per transaction,
  budget ceiling total, expiry, and revocation.
- Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 · `ESTABLISHED` 1000–4999 · `AUTONOMOUS`
  5000–7999 · `VETERAN` 8000–10000.

---

### The phases

#### Phase 1 — `capability.v0`: the vocabulary

The complete capability set a role can hold, each defined by **what claim it licenses**, not by
what tool provides it. Cover at minimum: read, reason, shell, network fetch, database read,
database write, spend, publish to a third party, and custody of a key.

For each: what an agent holding it may assert, and what an agent lacking it must say instead.
That second half is the deliverable — a capability whose absence has no defined utterance is
how confabulation gets in.

State explicitly which capabilities are **compound** and must decompose (is "publish" one
capability or three?), and which pairs are **dangerous in combination** rather than alone.

#### Phase 2 — Binding: what satisfies a capability

A capability is abstract; something concrete provides it. Define the binding record: what a
binding names, how it declares which capability it satisfies, and how the system verifies the
binding is real rather than configured.

**The verification half is the point.** This system's own rule is capabilities are MEASURED,
not declared. Define the probe: what question is asked, what answer counts, what happens when
the probe cannot run. An unreachable probe is `NOT_CHECKED`, never a pass.

Cover CLIs, MCP servers, HTTP APIs, local model runtimes and hosted models as binding kinds —
and say what differs between them.

#### Phase 3 — Portability: surviving a change of model, runtime and database

The Trust Harness must hold when the LLM changes, when the database changes, and when execution
moves between local and cloud.

Define what is **invariant** (the role, its capabilities, its bounds) and what is
**substrate-specific** (which model, which key, which endpoint). Then define where each lives so
swapping one never edits the other.

State the storage-neutral form: this contract must be expressible in Postgres, in a flat file,
and in whatever a device-local PAI uses. Say what that costs you.

#### Phase 4 — `role.v0`: roles as capability sets

Define the role record and give **three worked examples**: CMO, CTO, and auditor.

For each: capabilities held, capabilities explicitly denied, and — the part that matters —
**why the denial is safe**, i.e. what the role does when it needs something it does not have.
"It asks a human" is an answer only if you define the request path.

Then answer the composition questions plainly: can a role hold another role? What happens when
two roles conflict? Does a role's capability set intersect with the agent's own measured
capabilities, or override them? Only one of those is safe — say which and why.

#### Phase 5 — Grant or config? Argue it, do not assume it

A capability set could be static configuration, or a **grant**: scoped, bounded, expiring,
revocable, and issued by a principal.

Make the argument both ways and pick one. Cover: what revocation means for a capability already
in use mid-task; whether an expiry that lapses mid-task fails open or closed; who may issue;
whether a role can sub-delegate; and what is recorded so a third party can verify what authority
existed at the time an action was taken.

If you conclude grant, state precisely what it shares with the existing spend-delegation shape
and what must differ. If you conclude config, state what you lose.

#### Phase 6 — The audit record

What must be written when a capability is exercised, so that afterwards a reader can answer:
what did this agent do, under what authority, and could it have done otherwise.

Every field justified by naming the question that becomes unanswerable without it. Include what
is recorded on **refusal** — an agent that correctly declined for lack of capability is a
success and must be legible as one, not as silence.

#### Phase 7 — Migration, and the collision you and XC created

Two parts.

First: existing agents and lanes have no role. Define the transition — cold-start, backfill, or
hybrid — and what each does to a working swarm on day one.

Second, and do not skip it: **your synthetic α/β backfill grants every existing agent a
fabricated favourable count.** XC priced ~96 counts as enough to absorb one unbounded fault at
1pp of posterior mean. State what your backfill actually grants in those units, whether it
exceeds that threshold, and what changes to the backfill would keep migrated standing without
also granting the buffer. Mark it `[UNVERIFIED]` where you cannot compute it and name the input
you lack.

#### Phase 8 — Acceptance

The whole contract in one place: every record, every field, type, nullability, who writes it,
and one sentence of justification.

Then the **failure list**: for each field, the specific wrong conclusion a reader reaches if it
is missing or misread. That list is what a reviewer checks a migration against.

Close with the three things you are least confident about and what would settle each.

---

### Acceptance criteria

- Every field carries a justification naming what becomes unanswerable without it.
- Every status field expresses all four trust states. No booleans for status.
- **`[MEASURED]` means you ran an instrument.** Reasoning about code you read is
  `[UNVERIFIED]` — say so and name what would settle it.
- No file claimed as written, run, committed or edited.
- Requirements on XC appear under `REQUIREMENTS_ON_XC` **with the reason**.
- Human-only decisions go under `OPEN_QUESTIONS_FOR_SEAN` — do not decide them, do not stall on
  them.

### What will be rejected

- A capability list without the "what must an agent lacking this say instead" half.
- A binding design with no probe, or a probe with only two outcomes.
- Assuming capability grants are the same object as spend delegations. Argue it in Phase 5.
- Weakening the process-boundary credential isolation that already exists.
- Designing a role that holds write, spend and custody together without saying why that is safe.
- Advancing more than one phase per dispatch, or repeating a completed phase. **A handoff whose
  `NEXT_PHASE_READY` does not advance halts the sprint.**

### Fences

- **This repository is public.** Findings, not inventories. No credentials, project identifiers,
  production row counts, host names or service names.
- Scoring formula internals and ANFIS parameters never appear in public docs.
- Never assume a column name — read the schema or mark it `UNVERIFIED`.
- Do not propose removing or hardcoding a passing stub.
