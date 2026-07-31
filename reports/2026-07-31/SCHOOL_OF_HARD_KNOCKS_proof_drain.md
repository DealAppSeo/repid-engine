# School of Hard Knocks — the proof-drain hunt (2026-07-31)
**Cost:** ~6 weeks of a dead pipeline (40,546 jobs) + most of a working day to diagnose · **Logged at Sean's request** · Companion to `reports/2026-07-30/AGENT_FAILURE_LOG_AND_ANTIFRAGILE_DESIGN.md`

## What happened
`repid_proof_queue` stopped draining on 2026-06-16. The Railway worker reported **"Online"** the entire time. The prover was **healthy** the entire time. No alert fired, no error surfaced, nothing in any dashboard said a pipeline was dead. It was found only because someone went looking for an unrelated reason.

## The five lessons

### 1. The diagnostic was already in the code, and nobody read it
`src/scripts/start-proof-drain-service.ts` runs a `pgPing` at boot and prints either `[direct-pg] ping OK` or `[direct-pg] PING FAILED after Nms: <error> — fetchPendingBatch will fail until DATABASE_URL is set`. That line has been printing the answer on every restart for six weeks.

**Lesson: when a service is "Online" but producing nothing, read its first 20 log lines before touching anything else.** "Online" means the process is alive, not that it is working. We went to env-var archaeology (comparing masked values we could not read) before reading the logs — the most expensive possible ordering.

### 2. Silent failure is the disease — and our own infrastructure violated the product's core principle
Two *separate* silent-death paths existed in one function:
- a **missing** connection string threw at pool creation, was caught by the retry loop, and slept on an `unref()`'d timer — with no pool, no handles held the event loop, so **Node exited 0 mid-retry**;
- a **wrong** connection string didn't throw until query time and landed in the *same* unref'd sleep — schedule `[1s,4s,16s,64s,256s]`, a **~5.7-minute-wide** window in which the process could vanish with no error, no log, no stack, exit code 0.

HAL, RepID, the passport, x402 — the entire product thesis is *no silent degradation, fail loud, degrade narrow*. Our own DB layer did the exact opposite, and `resolveConnectionString`'s own comment ("must surface at boot or first call, not degrade invisibly") had been silently overridden by the retry loop wrapped around it.

**Lesson: apply the product's own invariants to the infrastructure that runs it.** A principle enforced only on the paths we're proud of isn't a principle. Fixed in #288 (fail-fast on config) and #289 (removed the unref).

### 3. Masked secrets make verification impossible — this is TrustKeys' founding use case
Hours went into a question that should take seconds: **"is the value deployed in Railway the same as the value I know works?"** Unanswerable. It's `*******` in the Railway UI, hashed in Supabase, and absent from `.env.master`. Both sides of the comparison are invisible **by design**, so the only paths available were (a) overwrite blindly and hope, or (b) reveal the secret and compare by eye — the second being exactly what a secrets manager exists to prevent.

**This is the product-shaped hole.** A key manager that could answer *"does the secret deployed at destination X match the known-good secret Y?"* — a **proof of equality without disclosure** — would have collapsed this entire day into one query. That is a zero-knowledge problem, we already build ZK primitives, and today is the concrete, dated, costed motivating incident for [[project_trustkeys_side_project]]:
- **verify-without-reveal**: prove a deployed secret matches a reference, exposing neither;
- **drift detection**: alert when a destination's secret stops matching its reference (this drift began ~2026-06-16, plausibly the 07-16 rotation, and nothing noticed for six weeks);
- **rotation blast-radius map**: "rotating this password breaks these 4 destinations" — the question that was unanswerable today;
- **agentic key management with zero exposure**: the agent can *verify* and *route* without ever handling the value, which is precisely the constraint that made this debugging session so slow.

The founding use case isn't hypothetical any more. It cost a working day and six weeks of dead pipeline.

### 4. Unverified inference — again (incident 001's class, third occurrence)
CC verified `DATABASE_URL` was absent from `.env.master`, then asserted it was missing **in production** — a place CC cannot see (no Railway token). Sean checked and found it set on both services, falsifying half the published diagnosis *after* a PR had already merged on it.

**Lesson: name the scope of every verification.** "Absent locally; production unverified" was the true statement and it was one clause away. The provenance hook (shadow mode) catches unsourced *identifiers*; it cannot catch a correctly-sourced fact stretched beyond its scope. That's a canary-layer gap, still open.

### 5. Placeholders inside copy-paste commands get pasted literally
CC handed over `$env:DATABASE_URL='paste-what-railway-has'`. It was pasted verbatim and failed with `ENOTFOUND base`, costing another cycle. Earlier in the same session, `"$env:DB_PASSWORD='pw$with$dollars'"` was mangled because PowerShell expands `$` inside double quotes.

**Lesson: a command handed to a human must be either fully runnable or impossible to run by mistake.** If a value must be substituted, make the script read it from a prompt or a file rather than embedding a placeholder in a runnable line. Every placeholder is a trap with a 50% trigger rate.

## Process notes (smaller, still real)
- **Stranded commits, twice.** Auto-merge closed a PR while later commits were still being pushed to its branch, silently leaving fixes off `main` (#288's follow-ups needed rescuing into #289). Check `git log origin/main..HEAD` before assuming a push shipped.
- **What actually found the password:** printing `pwLen` in the checker. It exposed the PowerShell `$`-mangling that made a *correct* password look wrong. Cheap observability on a value you can't print beats guessing about it.

## Net
The pipeline is fixed and end-to-end verified (a proof drained today verified client-side via the published npm CLI). Two real bugs were removed from the DB layer, and both were the same disease the product exists to cure. The most valuable output is #3: a dated, costed, concrete argument for building TrustKeys as a verify-without-reveal key manager — because today, the thing we could not do was *check whether a secret was correct*, and everything else followed from that.
