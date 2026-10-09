# HARNESS.md — the operating contract (Loops & Graphs + Harness Engineering)

**What this is.** The rails every agent (CC, XC, GA, the swarm) and the operator run work on, so we ship more, faster, with fewer mistakes. The model is raw compute; the harness is the OS around it — and the harness, not the prompt wording, is the lever. Read `LESSONS.md` first (true north, injected verbatim into every XC/GA dispatch); this file is the contract that shapes how work is **cut, checked, and gated**.

Mental model: **model = CPU · context window = RAM · harness = OS + durable storage.** Don't flood RAM with an encyclopedia — load the one snippet the step needs. Durable memory lives in files (`LESSONS.md`, per-repo `CLAUDE.md`, the FOR-SEAN board), never in chat history.

## 1. Every unit of work is a bounded contract
State these before generation, and never let the model silently redefine success:
- **Deliverable** — the exact file(s)/PR and format.
- **Constraints** — allowed deps/scope, style, testnet/paper only, no secrets.
- **Non-Goals** — what NOT to touch (the usual silent scope-creep killer).
- **GREEN** — the acceptance check, written so a *program* can evaluate it (never "looks good").
- **Lane** — the blast-radius lane (§2).
The GREEN condition decides when the unit is done — not the model.

## 2. Gate on blast radius, not confidence
Sort work by how expensive a mistake is to undo. Confidence is the weakest input — it's the only one the model controls.
- **Lane 1 — reversible / contained** (docs, tests, flag-off code): self-check + draft PR → operator glances, merges.
- **Lane 2 — reversible / wide** (shared code, a schema add): deterministic checks + Strix + golden vector → operator merges.
- **Lane 3 — irreversible** (prod DDL/migrations, money, on-chain writes, mint, x402 spend, merges, publishes, re-enabling legacy keys, Marco's files): **the lane does not open for an agent.** Human only. Not a high threshold — a closed lane.

## 3. Dual-encoding — the house law
Every rule is written **twice**: once in plain text (so the model understands the goal), once as a **mechanical gate** that fails the build/op when the rule breaks. A rule with no gate is skipped under load.
Our gates by example: the `social_content_queue` DB CHECK (verified-before-publish, in the DB not app code) · `lessons-injectable.test.ts` (the 6000-char cap) · the golden-vector tests (the cross-repo signing contract) · `provider-egress-guard` · `check:named-env-vars` · the publication-guard hook · the three-outcomes exit codes. **When you add a rule, add its gate.**

## 4. Sensors before autonomy — three outcomes, never two
An agent can't repair what it can't observe; autonomy is earned by sensors: `tsc --noEmit`, lint, the repo's tests, CI, Strix, golden vectors, live read-backs. Every outcome is **VERIFIED / NOT_CHECKED / FAILED** — a miss, an unrun check, an absent credential is NOT_CHECKED, never a pass. Absence of an error is not evidence of correctness (exit codes: 0 VERIFIED, 2 NOT_CHECKED, anything else FAILED).

## 5. The loop (inside a node)
produce → **check** (a sensor that can fail) → correct → repeat. Cap **3 attempts**; on the same failure twice, **stop, print the exact error, propose the fix, wait.** A loop whose check is "ask the model if it's sure" is two optimists agreeing — not a loop.

## 6. The graph (between nodes)
- **Splitter** cuts the work — by **blast radius**, not by folder — into independent units; it decides the most, so it carries the learning edge.
- **Workers** do one unit each, one lens, in their **own context** (a shared window makes four auditors echo one opinion).
- **Code-nodes** (merge, dedupe, rank, byte-diff, ecrecover) are **deterministic code, never a model** — one right answer, no variance/cost/latency.
- **Gate** = the lane (§2).
- **Return the UNIT, not the batch.** A failed unit comes back alone: `{unit, verdict, reason, evidence, scope: fix-this-only}`. Returning the whole batch rewrites correct work and never converges.
- **Two return paths:** the **correction edge** (short — fixes this run) and the **learning edge** (long — an accepted result becomes a *constraint in the splitter's brief*, fixing every future run). Almost everyone skips the second; it's why a system stays fast but never gets smarter.

## 7. The map, not the encyclopedia
- **True north / operating log:** `repid-engine/LESSONS.md` (injected into every XC/GA dispatch).
- **Per-surface rules:** that repo's `CLAUDE.md`.
- **The contract:** this file.
- **FOR-SEAN board / coordination:** `trustshell/docs/living/BUS.md`.
- **Published contract for outside builders:** `hyperdag-protocol/BUILDERS.md`.
Load the one relevant file; don't dump them all into RAM.

## 8. The human sits on one node
The operator sits on the highest-consequence, lowest-reversibility step — **merges, prod config, Lane-3** — and nothing upstream. A human in the middle of the graph is the slowest node; on the last gate, the graph runs at agent speed and only the irreversible waits on a person.

**Three lines hold it:** measure the path, not just the answer it landed on · a verdict that doesn't change what runs next is a report · any failure you don't turn into a permanent constraint, you will meet again.
