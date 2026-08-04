# Agent frameworks vs. our lane system — what they do that we do not

**Author:** REPORT lane · **Date:** 2026-08-04
**Method:** every repository fact below re-verified today against the GitHub GraphQL and code-search
APIs; every claim about our own system read from source at `main` = `778504d`, not from a summary.
`[V]` = command cited · `[R]` = reported, not re-run · `unknown` = evidence does not decide.

---

## 0. What I read before comparing

`src/orchestration/lane-registry.ts`, `src/orchestration/handoff-gate.ts`,
`src/orchestration/write-lease.ts`, `scripts/hooks/lane-write-guard.js`,
`scripts/hooks/publication-guard.js`, `.claude/settings.json`, and `src/routes/v1/openai-compat.ts`
(read-only — another lane owns that path). Nothing here is compared against something unread.

---

## 1. The landscape, re-verified

```
gh api graphql -f query='{ repository(owner:…,name:…){ stargazerCount licenseInfo{spdxId} pushedAt } … }'
gh api "search/issues?q=repo:openclaw/openclaw+is:issue+is:open&per_page=1" --jq .total_count
```

| repo | stars `[V]` | licence `[V]` | last push `[V]` | class |
|---|---|---|---|---|
| kyegomez/swarms | 7,024 | Apache-2.0 | 2026-08-03 | library |
| openclaw/openclaw | 385,050 | **NOASSERTION** | 2026-08-04 | coding agent |
| openai/swarm | 21,873 | MIT | **2026-04-15** | library (educational) |
| openai/openai-agents-python | 28,369 | MIT | 2026-08-04 | library |
| huggingface/smolagents | 28,659 | Apache-2.0 | 2026-07-21 | library (code-executing) |
| ag2ai/ag2 | 4,832 | Apache-2.0 | 2026-08-03 | library (code-executing) |
| VRSEN/agency-swarm | 4,514 | MIT | 2026-08-03 | library |
| swarmclawai/swarmclaw | 631 | MIT | 2026-06-30 | coding-agent orchestrator |
| desplega-ai/agent-swarm | 672 | MIT | 2026-08-04 | coding-agent orchestrator |
| WorldFlowAI/everything-claude-code | 926 | **none at all** | 2026-01-23 | config collection |
| garrytan/gstack | 126,146 | MIT | 2026-07-15 | skill pack (single session) |

**Three corrections to the briefed figures**, all minor but worth recording because a number without
its method is not a measurement:

1. **openclaw "5,463 open issues" is issues + PRs.** Open *issues* = **3,392**; open *pull requests*
   = **2,073** `[V search/issues]`. Sum 5,465. The distinction matters: 2,073 open PRs is a merge-rate
   signal, not a defect signal.
2. **openai/swarm is not archived** (`isArchived: false` `[V]`). "Superseded" is a correct reading of
   its own documentation and of the four-month push gap, but it is an interpretation, not a repo
   state. `openai-agents-python` is the successor and is actively pushed.
3. **Star counts drift.** everything-claude-code 926 (briefed 919), gstack 126,146 (briefed 126,092).
   Cite with a date or not at all.

**One legal fact that decides adoption before merit does:**
`WorldFlowAI/everything-claude-code` has `licenseInfo: null` `[V]` — no LICENSE file. Default
copyright applies: all rights reserved. It cannot be copied, vendored, or adapted, whatever is in it.
`openclaw/openclaw` reports `NOASSERTION`, meaning GitHub could not map its LICENSE to a recognised
SPDX identifier — the terms are **unresolved**, not permissive-by-default, and would need reading
before any code moved.

---

## 2. What our lane system actually is

Four mechanisms. The split that matters is **who enforces them**.

### Harness-enforced (registered as `PreToolUse` in `.claude/settings.json` `[V]`)

**`lane-write-guard.js`** on `Edit|Write|NotebookEdit`. Leases live at
`git rev-parse --git-common-dir`, so every worktree of one repo sees one registry that cannot be
committed, staged by `git add -A`, or merge-conflict. The hook is plain CommonJS with **no imports
from `src/` and no dependencies**, and the module header says why: it must run in a fresh worktree
with no `npm install` and no build step, because `dist/` is stale exactly when someone is mid-refactor
— *"anything it needs to require is a way for it to fail, and a fence that fails is a fence that
fails OPEN"* `[lane-write-guard.js:10-19]`. The ~40 lines of duplicated lease logic are pinned to the
TypeScript module by an equivalence test.

**`publication-guard.js`** on `Bash`. Scans any `gh pr/issue/release/gist` publishing command — the
command text and any `--body-file` it names — for secret shapes, and **fails closed**, unlike its
sibling, because a published key cannot be withdrawn.

### Convention-enforced (importable libraries; nothing called them during the sprint)

**`lane-registry.ts`** types lanes by *access*, not skill: `http`, `db_read`, `db_write`,
`repo_write`, `merge`, `chain_read`, `chain_send`, `infra`, `reasoning`. `canAssign()` **refuses the
dispatch** when a lane lacks a required capability, and the refusal is the product:
*"T12 lacks http — routing this here yields a fabricated answer, not a failed one"*
`[lane-registry.ts:200-207]`. `cheapestCapableLane()` sorts by cost tier so free is tried first but
only *reached* for work it can finish. `eligibleVerifiers()` excludes the producer **and** requires
the verifier to hold the capabilities needed to reach the evidence — *"a confident review of evidence
the reviewer never saw is worse than no review, because it carries a signature"* `[:232-246]`.

**`handoff-gate.ts`** grades a report's **contents**. A `measurement` typed as a bare `number` is
refused; it must arrive as `{value, corpus, config}`. A curated list of observed placeholder strings
(`"no issues found"`, `"LGTM"`, `"verified"`, …) is refused as prose. `resolveVerification()` returns
`CONFIRMED` only when an external voice actually spoke — silence never becomes assent — and any
single dissent outranks a majority. `classifyDecision()` adds a third D-054 rung, `USER_CHALLENGE`,
never auto-decidable.

---

## 3. What they do that we do not

Seven capabilities, each with evidence.

**1. Handoff as an executable runtime primitive.** `openai/swarm` and `openai-agents-python` make
"transfer control to another agent, carrying context" a typed operation the runtime performs. Our
`Lane.handsTo` is a static array that **nothing reads** — `handoff-gate.ts` decides *whether* work
advances, never *moves* it. We named the concept and did not build the mechanism.

**2. Guardrails that run in-band, on the request and response.** `openai-agents-python` ships
`src/agents/guardrail.py` with a dedicated docs page in five languages `[V search/code: 147 hits]`.
That is a tripwire on the call itself. Our gate is post-hoc report grading: it can hold a finished
report, it cannot stop a bad call mid-flight. HAL is closer in spirit but is a scoring service, not a
framework hook.

**3. Durable cross-session memory.** `agent-swarm` advertises workers that *"write their learnings
back to a shared memory so the whole swarm gets smarter every session"* `[V README]`; `swarmclaw`
ships *"durable agent memory"* and *"reviewed conversation-to-skill learning"* `[V README]`; gstack
uses a machine-readable `learnings.jsonl` deduped by key with top-3 auto-surfaced at session start
`[R #319]`. Ours is prose files a human must read. `#319` explicitly flagged this as a follow-up and
it was not done in this window.

**4. Tracing.** `openai-agents-python` has first-class run tracing. Our observability for a two-day,
21-merge sprint is pull-request bodies — excellent prose, not queryable, and the reason this report
had to be reconstructed by hand.

**5. Per-task environment isolation, more complete than ours.** This is the head-to-head comparison
and we do not win it. `agent-swarm` *"runs each worker in an isolated container"* `[V README]`.
`openclaw` ships **managed worktrees** `[V docs/concepts/managed-worktrees.md]`: a branch and checkout
per task outside the source tree, keyed by a repo fingerprint; a `.worktreeinclude` manifest for
provisioning ignored files; an optional repository setup script gated behind an admin scope because
it executes repo code; an **activity lock**; removal only when `git status --porcelain` is empty and
there are no unpushed commits; a synthetic snapshot commit pinned to a ref before any removal;
hourly cleanup of worktrees idle 7 days; 30-day restore.

Our answer to the same problem is a **shared checkout with path leases**. That is a different
trade-off, not a worse one — no per-task provisioning, no container, works when two lanes genuinely
need adjacent files — but on isolation specifically, openclaw has the more finished mechanism, and
`write-lease.ts` itself notes this repo already had eleven live worktrees, six holding branches
months old `[write-lease.ts:9-10]`.

**6. Review gates wired into the loop.** `agent-swarm` lists *"review gates"* among the things that
make delegated work compound `[V README]`. Ours is built, tested, and had zero callers for the entire
sprint (§4.4 of the two-day report; re-verified `[V grep]`).

**7. Scheduling and heartbeats.** `swarmclaw` ships schedules and heartbeats as runtime features
`[V README]`. We have cron endpoints and a self-scheduling digest, both default-off.

### What we have that none of them evidence

- **Capability *refusal* at dispatch, sourced from measurement.** Every framework here routes by role,
  description, or prompt. None refuses an assignment because the worker physically lacks the access
  the task requires. Ours exists because 18 of 18 reports from a tier with no HTTP client contained
  zero real measurements: *"an agent asked for a number it cannot obtain will produce a plausible
  number"* `[lane-registry.ts:7-10]`. That is a fabrication-prevention mechanism, and it is at
  dispatch rather than review.
- **A refusal on report contents, typed.** No framework in this list rejects a bare number for want of
  its ruler.
- **Enforcement one layer above the agent.** Frameworks enforce inside the orchestration library —
  the same process the agent's own code runs in, and therefore reachable by it. Our two working
  fences are harness hooks: the model does not call them and cannot skip them. This is the sharpest
  structural difference in the whole comparison.
- **Verification, reputation, and a payment rail.** None of the eleven has any of the three.

---

## 4. The thesis, tested

> *"These are LIBRARIES that orchestrate LLM API calls, whereas our agents are full coding agents
> with file, git and CI access enforced by harness-level hooks."*

**It holds for six of eleven, fails for three, and two are not frameworks at all.**

**Holds** — `kyegomez/swarms`, `openai/swarm`, `openai-agents-python`, `smolagents`, `ag2`,
`agency-swarm`. These are packages you import; the unit of work is an LLM call with tools.

One honest caveat inside this group: **smolagents and ag2 do execute code.** smolagents' central idea
is an agent that writes Python; ag2 ships local and Docker code executors. But that is a *sandbox
around one agent* — a jail whose job is to stop the agent harming the host. It is not coordination
between many agents sharing one repository, and neither ships anything resembling a write lease, a
merge policy, or CI awareness. The distinction survives, narrowed: they execute code, they do not
*collaborate on a codebase*.

**Fails** — `openclaw`, `desplega-ai/agent-swarm`, `swarmclawai/swarmclaw`. These orchestrate *full
coding agents*, explicitly and by name. agent-swarm: *"routes them to specialized workers such as
Claude Code or Codex, runs each worker in an isolated container"* `[V README]`. swarmclaw lists
Claude Code, Codex, Gemini CLI, Cursor Agent CLI, OpenCode, Copilot CLI and Droid as supported
harnesses `[V README]`. openclaw is itself a coding agent with 437 code hits for `worktree` `[V]`. For
these three, the thesis is simply false — they are in our category.

**Not frameworks** — `everything-claude-code` is a configuration collection with no licence;
`gstack` is 23 markdown skills that structure a *single* session into sequential specialist roles,
already read and mined in `#319`.

### Consequence for the conclusion

"Learn patterns, adopt no framework" is right, but it needs two different reasons rather than one:

- **Against the library cluster:** adopt nothing, because they solve a different problem one layer
  down. Borrow the *vocabulary* — handoff, guardrail, session, trace — because having names for these
  makes the gaps in §3 legible. We have no runtime handoff, no in-band guardrail, no durable session,
  no trace, and until this comparison we had no word for three of the four.
- **Against the coding-agent cluster:** adopt nothing, but for a different reason and with less
  comfort. These are peers, one of them has a more finished isolation mechanism than ours, and the
  blockers are practical rather than architectural: openclaw's licence terms are unresolved
  (`NOASSERTION`), its issue and PR backlogs are large, and — decisively — **our differentiator is
  not orchestration.** Nothing in the eleven verifies an answer, scores a counterparty, or settles a
  payment. Rebuilding their orchestration is a lateral move; they cannot rebuild our verification
  layer as a side project.

The correct posture toward the coding-agent cluster is therefore **integration, not adoption** —
which is exactly what §5 is about.

---

## 5. The ecosystem question: what would it take for them to consume us?

Every framework in the list supports a custom OpenAI-compatible `base_url` `[V search/code]`:
`openai-agents-python` (59 hits, `docs/config.md`), `ag2` (50, including `OAI_CONFIG_LIST_sample`),
`agency-swarm` (44), `openclaw` (1,564 for `baseURL`), `kyegomez/swarms` (29, including an example
literally named `examples/single_agent/utils/custom_agent_base_url.py`), `smolagents` (3, in
`src/smolagents/models.py`). Pointing any of them at us is a one-line config change **if we speak
their dialect**.

`#317` built that surface: `POST /v1/chat/completions` and `GET /v1/models`, mounted at `/v1` because
that is the path an OpenAI client appends to a base URL, with an exactly-OpenAI response body and
everything extra in headers. That was the right shape and the hard part is not the shape.

### What is missing, precisely — read from `src/routes/v1/openai-compat.ts`

**Blocking for most frameworks, in order of severity.**

1. **Tool calling is silently dropped.** The handler reads `messages`, `stream`, `model`,
   `max_tokens`, `temperature` and `hyperdag.task_hint` from the body `[V :163-221]`. `tools`,
   `tool_choice`, `functions`, `response_format`, `n`, `stop`, `top_p` and `seed` are never read and
   never rejected. **Agent frameworks are built on tool calls.** An agent pointed here would appear
   to work and would never call a tool — the worst failure shape available, because it is silent. If
   only one thing is fixed, it is this: either pass tools through to the broker, or **reject a request
   carrying `tools` with a reason**, exactly as streaming is rejected.

2. **Streaming is refused with a 400** `[V :172-182]`. The reasoning is sound — HAL scores a complete
   answer, and a client expecting chunks that receives one blob will hang, so an explicit refusal
   beats a hang. But every framework here streams by default, so today the default configuration of
   most callers fails on the first request. The fix is not to drop the constraint: stream the
   completion and deliver the verdict in a terminal chunk or a follow-up receipt fetch, so the
   verdict still describes a complete answer.

3. **No agent identity on the request, so nothing can move RepID.** The route forwards
   `authorization`, `x-api-key` and `x-agent-gate-token` `[V :209-213]` and returns a verdict, but
   there is no inbound field naming *which agent* made the call and no score event on the way out.
   "RepID for free" is not currently reachable from this surface — a verdict is produced and
   attributed to nobody.

4. **`X-HyperDAG-Receipt` is documented and never set.** The module header lists it among the
   response headers `[:29]`; the handler sets Verdict, HAL-Score, Provider, Family, Cost-USD and
   `Access-Control-Expose-Headers` — and no Receipt `[V :259-264]`. Cold-module disease at the
   header level, and it is the header a caller would use to make the claim checkable.

5. **Payment-on-verify is not one adapter away.** Settlement is bound to a contract with an escrow
   authorization, a delivery and a buyer verdict. A chat completion has none of those. Getting
   "payment-on-verify for free" from this surface needs either a per-call metered rail (a completion
   becomes a priced, verifiable unit) or a way for a completion to *become* a contract. Neither
   exists. This is the largest gap between the ambition and the code, and it should be stated that way
   rather than implied by the endpoint's existence.

**Non-blocking but degrading.**

6. **The message flatten is lossy.** `flattenMessages` joins turns with injected `User:` / `Assistant:`
   labels and concatenates the system prompt onto the front `[V :63-80, :216]`. It is a deliberate
   choice — labelling beats blind concatenation, since a model that receives a system instruction as
   user speech behaves differently and HAL would then score an answer to a prompt that never existed
   — but multi-turn agent frameworks will get measurably different behaviour here than against the
   same model natively, and that difference is currently undocumented for callers.

7. **`usage` defaults to zero** when the broker omits token fields `[V :278-282]`. Frameworks that
   track cost will silently record free calls. The same failure family as the fabricated pricing in
   `#318`: a missing number rendered as a plausible one.

8. **`GET /v1/models` advertises intents (`hyperdag-auto`, `hyperdag-verified`), not model names**
   `[V :123-128]`. This is the right product decision — a client pinning an upstream model name loses
   the fallback that is the point — but several frameworks validate the model id against `/v1/models`
   or map model→provider from a config list (`ag2`'s `OAI_CONFIG_LIST` `[V]`). It needs a
   two-line integration note per framework, not a code change.

9. **Off by default** (`OPENAI_COMPAT_ENABLED`), and it delegates over loopback HTTP to itself via
   `INTERNAL_SELF_URL` `[V :199-223]`. The delegation is correct — one router, not two that disagree
   about provider health — but it makes the surface's availability depend on the engine reaching
   itself.

### The shortest path to a real integration

In order, and each is small:

1. Reject `tools` with an explanatory 400 (one hour), then pass them through (larger).
2. Set `X-HyperDAG-Receipt` — the header is already designed and documented.
3. Accept an agent identifier and emit a score event, so a verdict attaches to a counterparty.
4. Stream, with the verdict in a terminal chunk.
5. Write one integration note per framework naming the base URL, the model id, and the header set.

Steps 1–3 turn the endpoint from *"OpenAI-shaped"* into *"an agent framework can use it and get
something it cannot get elsewhere."* Step 5 is what makes it findable. Payment-on-verify is a
separate design problem and should not be advertised from this surface until it has one.

---

## 6. Answers, stated plainly

**What do these do that our lane system does not?** Runtime handoffs, in-band guardrails, durable
cross-session memory, tracing, per-task environment isolation with locks and snapshots, wired review
gates, and scheduling. Five of those seven we have not built; two (isolation, review gates) we have
built in a weaker or uncalled form.

**Does the library-vs-coding-agent thesis hold?** Partly. It holds for the six Python/JS
orchestration libraries and fails for the three projects that orchestrate coding agents by name —
one of which has already solved worktree isolation more completely than we have. Two entries are not
frameworks. State the split; do not state the blanket.

**What would it take for them to consume HyperDAG?** Not much for the transport — they all take a
custom base URL, and `#317` already speaks the dialect. The blockers are that tool calls are silently
dropped, streaming is refused, no agent identity rides the request so no RepID can move, the receipt
header is documented but unset, and payment-on-verify has no path from a chat completion at all.
Four of those five are small. The fifth is a design problem, and calling it "free" would be the kind
of claim this sprint spent two days learning not to make.

---

*Verify, then trust the concurrence. Cite the ruler or do not cite the number.*
