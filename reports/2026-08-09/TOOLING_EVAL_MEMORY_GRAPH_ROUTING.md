# Tooling evaluation — memory, graph recall, routing, swarm autonomy
**Date:** 2026-08-09 · **Requested by:** Sean · **Scope:** 12 candidate repos + own recommendations
**Prior art:** `reports/2026-08-06/IDEA_INTAKE_AND_TRIAGE.md` (§6 "DNA expression", §7 empowerment).
Sean's standing constraint from that triage: **only verified tools, no mass install.**

All repo stats below are `[V]` — fetched from the GitHub API on 2026-08-09, not from memory.
All capability claims from README prose are `[R]` — vendor self-description, unmeasured by us.

---

## 0. The reframe (read this before the matrix)

Sean's stated pain is *"we keep verifying things and rediscovering them between versions of
Claude, Grok, XA, Gemini, GA, T12."*

That is **two different problems**, and eleven of the twelve repos solve only the second one:

**Problem 1 — durable VERIFIED knowledge across agents and model versions.**
The thing that rots is not context, it is *provenance*. A fact re-verified is cheap; a fact
recalled without its provenance is a `CLAUDE_RULES r1` violation waiting to happen. Session-memory
tools (claude-mem, ruflo's AgentDB, headroom's cross-agent memory) persist **observations**, which
are `[reported]`. Injecting those back as context makes the *next* agent confidently assert an
unverified claim — the exact failure mode of `feedback_no_silent_degradation`. Installing memory
without a provenance type system would make our worst failure mode cheaper to reach, not rarer.

**Problem 2 — per-agent context efficiency** (fewer tokens, fewer tool calls, less rediscovery of
*structure*: where a function lives, what calls what, what the schema is).
This is a real, solved problem, and the code-graph + compression tools solve it well.

**What we already own** (checked on disk 2026-08-09):
- `src/services/graph-rag/` — `graph-rag-store.ts`, `retrieval-service.ts`, `embedding-service.ts`,
  `hal-memory-hook.ts`, `graph-rag-edge-inference.ts`, pgvector-backed, typed nodes/edges.
- `src/memory/` — `proof-carrying-memory.ts`, `memory-root-anchor.ts`, `memory-publication.ts`.
- `src/services/anfis-router.ts`, `escalation-router.ts` — routing surface (shadow-only per
  `project_anfis_shadow_truth`).
- `trinity-litellm` on Railway — an existing multi-provider gateway.
- `.claude/settings.json` hooks: `lane-write-guard.js`, `publication-guard.js`.

**Live state [V sql 2026-08-09, project qnnpjhlxljtqyigedwkb]:**

| table | rows | last write |
|---|---|---|
| `agent_memory_nodes` | 241 | 2026-08-08 04:10 |
| `agent_memory_edges` | 154 | 2026-08-08 04:10 |

**Conclusion: we do not have a graph-store gap. We have a FEEDER gap and a PROVENANCE gap.**
241 nodes across a 45-repo, 567-table, 8-month program is a rounding error. Buying a second graph
store to sit next to an empty one is the "reuse before creating" anti-pattern
(`feedback_reuse_before_creating`). The correct move is to *fill* the one we own from a
deterministic extractor — which is precisely what codegraph/graphify are good at.

---

## 1. Verified repo facts `[V — gh api, 2026-08-09]`

| Repo | Stars | Forks | Lang | License | Last push | Flag |
|---|---:|---:|---|---|---|---|
| diegosouzapw/OmniRoute | 44,245 | 5,949 | TypeScript | MIT | 2026-08-09 | — |
| ruvnet/ruflo | 67,496 | 8,077 | TypeScript | MIT | 2026-08-09 | — |
| lm-sys/RouteLLM | 5,317 | 415 | Python | Apache-2.0 | **2024-08-10** | 🔴 **2 years dead** |
| colbymchenry/codegraph | 65,578 | 4,129 | C/Rust | MIT | 2026-08-08 | — |
| Graphify-Labs/graphify | 104,601 | 10,173 | Python | Apache-2.0 | 2026-08-09 | — |
| pab1it0/awesome-a2a | 182 | 50 | (list) | MIT | 2026-08-05 | — |
| abhigyanpatwari/GitNexus | 45,215 | 5,009 | TypeScript | **NOASSERTION** | 2026-08-09 | 🟡 **no clear license** |
| thedotmack/claude-mem | 90,205 | 7,855 | JavaScript | Apache-2.0 | 2026-08-09 | — |
| microsoft/playwright | 94,254 | 6,249 | TypeScript | Apache-2.0 | 2026-08-09 | — |
| headroomlabs-ai/headroom | 65,647 | 5,011 | Python/Rust | Apache-2.0 | 2026-08-09 | — |
| odysseus-dev/odysseus | 85,056 | **388** | Python | **AGPL-3.0** | 2026-08-08 | 🔴 219:1 star/fork ratio; copyleft |
| DietrichGebert/ponytail | 99,296 | 5,457 | JavaScript | MIT | 2026-08-07 | — |

Two facts worth pausing on:

- **RouteLLM is abandoned.** Apache-2.0, 5.3k stars, last commit August 2024. Its *idea*
  (cost-threshold cascade, weak↔strong routing) is citable; its code is not installable in 2026.
  Note also that a strong/weak binary was already rejected for us in
  `feedback_free_fleet_routing` ("never free→frontier binary").
- **odysseus has an anomalous 219:1 star-to-fork ratio** (healthy OSS runs ~10:1). Combined with
  AGPL-3.0 — which is a genuine hazard if any of it ever touched proprietary `repid-engine` code —
  this one does not clear the "only verified tools" bar.

---

## 2. Capability overlap matrix

● = primary purpose · ◐ = secondary/partial · — = not in scope

| | Route / gateway | Code-graph recall | Session memory | Token compression | Swarm orchestration | Evidence / E2E proof | Interop reference |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **OmniRoute** | ● | — | — | ● | — | — | ◐ (MCP/A2A) |
| **RouteLLM** *(dead)* | ● | — | — | — | — | — | — |
| **codegraph** | — | ● | — | ◐ | — | — | — |
| **graphify** | — | ● | — | ◐ | — | ◐ (edge provenance) | — |
| **GitNexus** | — | ● | ◐ | — | — | — | — |
| **claude-mem** | — | — | ● | ◐ | — | — | — |
| **headroom** | — | — | ◐ | ● | — | — | — |
| **ruflo** | ◐ | — | ◐ | — | ● | — | — |
| **playwright** | — | — | — | — | — | ● | — |
| **ponytail** | — | — | — | ◐ (by not writing code) | — | — | — |
| **odysseus** | — | — | — | — | ◐ | — | — |
| **awesome-a2a** | — | — | — | — | — | — | ● |
| *(ours) graph-rag + memory* | — | ◐ | ● | — | — | ◐ | — |
| *(ours) trinity-litellm* | ● | — | — | — | — | — | — |
| *(ours) anfis-router* | ◐ shadow | — | — | — | — | — | — |

**Three genuine collision clusters:**

1. **Code-graph: codegraph ↔ graphify ↔ GitNexus.** ~80% functional overlap (tree-sitter AST →
   graph → MCP tools for agents). **Install at most two, and only if they occupy different roles.**
2. **Compression: OmniRoute ↔ headroom.** OmniRoute bundles a 12-engine compressor
   (RTK/Caveman/LLMLingua-2) `[R]`; headroom is a dedicated content-type-routed compressor. Running
   both means double-compressing and no attributable ruler for either.
3. **Orchestration + memory: ruflo ↔ claude-mem ↔ our own swarm.** ruflo is a *meta-harness* — it
   wants to own the layer we have already built (T12, Workflow, lanes, AGENTS.md contracts).

---

## 3. Per-repo verdict — real value to *our* build

### Install now

**OmniRoute** — *the single best fit for the literal question asked.*
Sean's goal is "run in parallel autonomously until the free tokens run out." Quota-aware
auto-fallback across 90+ free providers with per-key cooldown and model lockout **is exactly that
mechanism**, and it is the piece our stack does not have: `trinity-litellm` routes, but it does not
manage free-tier exhaustion as a first-class state.

> ⚠️ **Hard constraint: HAL panel calls must NEVER go through it.** HAL's F1 depends on *disjoint
> model families* (BFT/SBFA independence) and on a frozen ruler (`rigorous-v1@596f10de18d0`). A
> router that silently substitutes a model breaks the independence assumption *and* invalidates the
> measurement, which is `CLAUDE_RULES 24` verbatim. Gateway for **build/agent traffic only**;
> HAL/eval traffic stays pinned and direct.

**codegraph** — the daily-driver structural index. Rust/C kernel, SQLite+FTS5, 100% local, MCP
server, auto-sync on file change. Directly attacks Problem 2 across our 45 repos. 100%-local matters
here: a public-repo codebase indexed by a third-party service is an exfiltration surface.

**claude-mem** — *conditionally*, and only with the provenance guardrail below. It is the closest
thing on the list to Sean's stated pain, and Apache-2.0 / actively maintained.

> ⚠️ **Guardrail (non-negotiable):** everything claude-mem injects is `[R]`, never `[V]`. It must
> be prohibited as a source for any live-state claim (Supabase row counts, chain state, service
> health). Enforce mechanically — extend the Stop/provenance hook — not by writing another rule.
> Per our own 08-06 post-mortem: *"more rules would not have helped; a mechanism would."*

### Install this week

**playwright** — the underrated one on this list *for us specifically*. Its value is not testing;
it is **evidence generation**. Our recurring defect is claims that are `[reported]` because no
artifact exists (`project_swarm_agents_no_http_client`: 18/18 nightly smoke reports contained zero
real measurements). Playwright traces + screenshots turn a Trust*-surface claim into a `[V]`
artifact that a second agent can co-sign (THE_ONE §10, A6). Point it at trustshell.dev,
trusttrader.dev, the public receipt URL, `/leaderboard/models`, `/stats`.

**awesome-a2a** — zero install cost; it is a reading list, not a dependency. Strategic value:
182 stars means it is small enough to read end-to-end, and it enumerates the A2A server ecosystem
that RepID/TrustShell is trying to be the **trust layer for**. We already have `a2a-negotiation.ts`
and `mcp-a2a-gateway`. This is market-surface reconnaissance, and it is cheap.

**graphify** — *second* code-graph, in a role codegraph does not cover: it ingests **docs, SQL
schemas, configs and PDFs**, not just code. That maps onto our actual mess — `E:\dev\living-docs`,
`SCHEMA_TRUTH_MAP`, 567 tables. Its killer property for us: **every edge is tagged `EXTRACTED`
(explicit in source) vs `INFERRED` (resolved by the tool)**. That is our `[V]`/`[R]` discipline
expressed natively in a graph — the only tool on this list that is provenance-aware by design.
Use it as a **periodic one-shot cross-repo map**, not an always-on daemon.

### After the frontier-panel HAL experiment

**headroom** — high value, but it sits *in the request path*, and "same answers" is a `[R]` claim
until we measure it. Rule 24 applies: we need a ruler before we can accept a compressor. Once the
frontier-panel experiment gives us a stable baseline, A/B it on build traffic.
**Never in the HAL or eval path** — a compressor mutating corpus payloads is a measurement
contaminant.

**ponytail** — cheap (MIT, rule files + hooks) and it targets a real defect: our agents overbuild.
But it is *rule injection*, the mechanism our own post-mortem found insufficient, and its "54% less
code" figure is vendor-self-reported `[R]`. Also check it does not collide with `CLAUDE-RULE-3`
("fix ONLY the named error"). **Trial on one lane, measure, then decide** — do not global-install.

### Study, do not adopt

**ruflo** — 67k stars, genuinely interesting patterns (federation across machines, self-learning
loop that mines successful task patterns into vector memory). But adopting it wholesale means
handing our orchestration layer to an external harness we did not build and cannot audit line by
line. Worse, there is an **architectural conflict**: our BFT design requires agents to be
*independent* failure domains; a shared meta-harness with a shared memory correlates them, which is
the coordinated-dissonance failure the Pythagorean Comma veto (CANON P-003) exists to catch.
**Mine it for the federation and self-learning-loop designs. Do not let it own the loop.**

### Skip

- **RouteLLM** — abandoned 2024. Read the paper's cost-cascade idea; do not install.
- **GitNexus** — `NOASSERTION` license (no usable grant) + ~80% overlap with codegraph and
  graphify. The license alone disqualifies it from anything near proprietary code.
- **odysseus** — a self-hosted AI *workspace*. We are not short of surfaces; we are short of
  verified claims. AGPL-3.0 near proprietary code is a real hazard, and the 219:1 star/fork ratio
  does not clear "only verified tools."

---

## 4. Three additions not on the list

### A. A "rediscovery tax" counter — **build, ~1 file, this week**
Sean's premise is that we re-verify too much. **We have never measured it.** Every re-verification
is already an observable event (a Supabase query, a chain read, a probe). Log each one with the
fact-key it resolved, and you get: *how many times per week does the swarm re-establish a fact it
already established, and which facts are the worst offenders?*

That list is the actual build order for memory. Without it, every memory tool we install is
optimising a distribution we have not looked at — the same "measure before you tune" failure the
08-06 triage flagged in §6. It is also the honest way to prove any of the installs above worked.

### B. Langfuse (self-hosted, OSS) — **cross-agent trace + eval store, next**
The real gap behind "between versions of Claude, Grok, Gemini, GA, T12" is that we have **no unified
trace across agents**. Each lane reports into a different markdown file. Langfuse self-hosts free,
stores traces + evals + prompt versions, and would give one place where "HAL F1 = 0.91 on
rigorous-v1@596f10de18d0 at 5 families" lives *attached to the run that produced it* — which is
`CLAUDE_RULES 24` implemented rather than exhorted. It also makes the disjoint-family MoE legible:
you can finally see which family is carrying which verdict.

### C. Mechanize the autonomy boundary in CI — **build, next**
`CLAUDE_RULES 23` (convergent/original × can-it-change-live-state) is currently enforced by *me
reading it*. That is the same class of control that failed in the `export $(...)` incident. Make it
a CI gate: a diff that touches a live-state surface (migrations, on-chain writers, public routes,
`FIXED_DELTAS`, default-ON flags) fails unless it carries a `SHADOW-ONLY` or `SEAN-GO:<ref>` marker.
This is what actually lets overnight autonomy widen safely — a machine-checked boundary, not a
remembered one. It is also the prerequisite for trusting *any* of the tools above to run unattended.

---

## 5. Install sequence

| When | What | Gate / condition |
|---|---|---|
| **Today** | codegraph | none — local, MIT, read-only index |
| **Today** | OmniRoute (free-fleet + build traffic only) | HAL/eval traffic stays pinned & direct |
| **Today** | claude-mem | ships **with** the `[R]`-only provenance hook, or not at all |
| **This week** | playwright | first job = evidence run on the public Trust* surfaces |
| **This week** | awesome-a2a (read) | zero-cost |
| **This week** | graphify (one-shot map) | living-docs + schema, not always-on |
| **This week** | rediscovery-tax counter (build) | — |
| **After frontier-panel HAL run** | headroom | A/B against a stable baseline; never in eval path |
| **After frontier-panel HAL run** | ponytail | one lane, measured, then decide |
| **Next** | Langfuse (self-host), CI autonomy gate (build) | — |
| **Study only** | ruflo | mine the patterns, do not adopt the harness |
| **Skip** | RouteLLM · GitNexus · odysseus | dead / unlicensed / AGPL+off-need |

---

## 6. When the free tokens run out

Ranked by what we can verify about *our own* environment (`reference_master_env_keys`,
`project_provider_keys_inventory`), not by vendor marketing. Free-tier limits churn monthly —
**re-probe before relying on any of this.**

**Tier 0 — genuinely $0, unlimited, no quota to exhaust: local.**
`ollama` is already wired as a floor (`llm_ollama_floor_enabled`, `ollama_fallback_model`,
`OLLAMA_MODELS=E:\ollama\models`). A Qwen3 / Nemotron-Nano-class SLM on the local box is the only
option with no cliff. **This is the correct home for the always-on manager loop** — the thing that
must survive token exhaustion is coordination, not generation.

**Tier 1 — free API tiers we already hold keys for:** Groq (fastest, most generous), Cerebras
(gpt-oss-120b), Google AI Studio (Gemini Flash free tier), OpenRouter `:free` models. Per
`project_provider_keys_inventory` we hold **live-but-unwired** keys for OpenRouter, DeepInfra,
SambaNova and SiliconFlow — *wiring idle keys is cheaper than buying capacity*, and OmniRoute is
precisely the piece that makes that cascade automatic rather than hand-rolled.

**Tier 2 — ultra-low-cost paid floor:** DeepSeek (already funded), Gemini Flash-Lite,
GPT-OSS-120B on Groq/Cerebras paid. Cents-per-million territory; use for volume, never for HAL panel
seats.

**Tier 3 — frontier, reserved:** per `HANDOFF.md` 2026-08-09, HAL is at a **panel-limited ceiling
(~F1 0.91)** and the only identified ceiling-lifter is a frontier model in the standing quorum. That
is the one place where spend buys a measurable number. Everything else runs on Tiers 0–2.

---

*Verified against disk + live Supabase 2026-08-09. Vendor capability claims are `[R]` and unmeasured
by us. Nothing here is installed; this is a recommendation for Sean's GO.*

---

## 7. Addendum — reconciliation with Grok (D-054 run, 2026-08-09)

### 7.1 Convergence

Grok and I independently agree on: OmniRoute as highest-immediate-ROI gateway; claude-mem as the
direct attack on cross-session rediscovery; codegraph/graphify for structural recall (pick one to
start); headroom to extend free-token life; playwright for agents doing web work; ruflo as
selective/reference **not** wholesale adoption; awesome-a2a as reference only; ponytail as a cheap
skill-level win; and the free→cheap→local cascade for token exhaustion.

Notably, Grok's closing line — *"measure token lifetime and rediscovery rate on a real multi-agent
dogfood loop"* — is the **rediscovery-tax counter** from §4A, arrived at independently. Per D-054
that is genuine convergence, not a rubber-stamp. **Build it.**

### 7.2 Adopted from Grok (revisions to §3)

- **Playwright MCP server**, specifically — the official MCP with accessibility-tree snapshots (no
  vision model needed). More precise than my generic "playwright"; it is the correct install shape.
- **Letta (MemGPT)** as a named candidate for hierarchical agent-managed memory (core in-context
  blocks + archival/recall paging). Worth flagging: this is the off-the-shelf realisation of the
  **L0–L3 memory hierarchy our own 08-06 triage §2 already sketched**. Convergence with our prior
  design raises its priority — but it would be a *third* memory store beside claude-mem and our
  graph-rag. **Study the tiering; do not install a third store yet.**
- **LangGraph's durable-checkpoint property** is a real ask for overnight resume. The *adoption*
  carries the same objection I raised against ruflo (don't let an external harness own the loop),
  and the Workflow tool already provides `resumeFromRunId`. Take the property, not the dependency.

### 7.3 Held against Grok — facts, not judgment

Per `CLAUDE_RULES 23`: *agreement gates judgment; it never gates facts.*

1. **RouteLLM is abandoned** — last push **2024-08-10** `[V gh api]`. Grok lanes it "later /
   experiment"; that is not available. The cost-cascade *idea* is citable; the code is not.
2. **GitNexus is `NOASSERTION`** `[V gh api]` — no license grant. Grok lanes it "later /
   exploratory"; without a grant it cannot go near proprietary code at any lane.
3. **vLLM / SGLang is not viable on this hardware** — both require CUDA. This machine has
   **Intel UHD 620 integrated graphics, no NVIDIA GPU** `[V]`. Grok's "Qwen3 27B-class on 16 GB+"
   is also out of reach: 27B-Q4 ≈ 16–17 GB against 15.9 GB total system RAM. This confirms rather
   than contradicts `project_local_hardware_backlog`: **a real local inference floor needs a
   separate GPU box.**

### 7.4 Two safety caveats Grok did not flag

1. **HAL panel calls must never route through OmniRoute** (or any router). HAL's F1 depends on
   *disjoint model families* for BFT/SBFA independence and on a frozen ruler
   (`rigorous-v1@596f10de18d0`). Silent model substitution breaks both — `CLAUDE_RULES 24`.
2. **claude-mem output is `[R]`, always.** It must be barred as a source for any live-state claim,
   enforced in the provenance hook rather than by another written rule.

### 7.5 Verified hardware constraint — this drives the layout `[V 2026-08-09]`

| | value |
|---|---|
| CPU | Intel i7-8565U — 2018, 4c/8t, **15 W** mobile |
| RAM | 15.9 GB |
| GPU | Intel UHD 620 integrated, 1 GB — **no CUDA** |
| C: | 256 GB NVMe SSD — **23.2 GB free** |
| E: | 3.7 TB Seagate Expansion over **USB (HDD)** — 3,674 GB free |

**"Maxed out" is literal on two axes: disk and CPU.** Consequences:

- Local inference is a *classification/gating* floor at best (7–8B Q4, short outputs), **not** a
  generation fallback. An Oracle Cloud Free ARM instance (4 cores / 24 GB, $0) is *strictly better
  than this laptop* for anything server-shaped.
- With 23 GB free, avoid Docker Desktop on the laptop (WSL2 + images cost several GB). Prefer the
  npm global install path for anything that must run locally.
- E: is a USB HDD — fine for model weights and cold artifacts (sequential reads), **poor for hot
  SQLite indexes** (random IO). Do not relocate live agent indexes there by default.

**Placement principle:** *hot + agent-coupled → laptop (small, measured). Bulk + cold → E:.
Always-on + key-holding → VPS.*

### 7.6 Revised top 3 for today

| # | Tool | Where | Why here |
|---|---|---|---|
| 0 | *(prereq)* free space on C: | laptop | 23 GB is not enough headroom for 3 installs + an overnight loop; `project_disk_cleanup_map` already has the safe/trap list |
| 1 | **OmniRoute** | laptop to configure → **VPS** to run | always-on + holds provider keys; the laptop closes at night, which defeats the purpose |
| 2 | **claude-mem** | laptop | must be co-located with Claude Code's hook lifecycle; ships **with** the `[R]` guardrail |
| 3 | **codegraph** | laptop, **one repo first** | read-only, zero risk to the overnight run; index `repid-engine` only and measure before indexing 45 repos |

### 7.7 EXECUTED 2026-08-09 — cleanup + two laptop installs `[V]`

**C: cleanup.** 23.2 → 32.7 GB free. Honest split: ~4.8 GB was freed by something other
than me (it read 28.0 GB when deletions began); **my deletions accounted for +4.7 GB** —
four regenerable Rust `target/` dirs, npm cache, Temp >7 days. No worktrees, no
`claudevm.bundle`, no Antigravity touched. Cost: next `cargo test` on the ZKP crates
recompiles from scratch.

**codegraph v1.5.0.** Telemetry disabled *before* indexing proprietary code. Indexed
repid-engine: **1,058 files → 11,043 nodes, 44,077 edges in 17.4 s, 52.5 MB**. Against our
own Graph-RAG store (241 nodes / 154 edges after eight months) that is 45× the nodes and
286× the edges in seventeen seconds — the feeder gap of §0, quantified. MCP wired globally
(stdio, local, no network). `.codegraph/` pinned in the repo `.gitignore` (public repo;
the tool ships its own ignore, but `git add -A` has burned us before). Its installer also
appended a fenced block to `~/.claude/CLAUDE.md`; all four `@E:/dev/living-docs/...`
imports verified intact.

**claude-mem v13.14.0.** Telemetry disabled. Provider switched to **openrouter**.
Worker running (PID 1856, 127.0.0.1:37777).

> **Defect found in the vendor default:** `CLAUDE_MEM_OPENROUTER_MODEL` defaults to
> `xiaomi/mimo-v2-flash:free`, which **does not exist in the OpenRouter catalog** (checked
> live against `/api/v1/models`, 400 models). Left alone, every compression call would have
> failed. Set to `google/gemma-4-26b-a4b-it:free` — 4B active params (fast enough for a
> per-tool-call hook), 26B total, 262k context. End-to-end verified: **HTTP 200, cost 0**.

**Provenance guard — extended the EXISTING hook, did not add a parallel one.**
`~/.claude/hooks/provenance-check.js` treated any user-role turn as admissible evidence.
claude-mem injects recalled memory at `SessionStart` and `UserPromptSubmit`, which land in
exactly that pool — so **installing memory would have silently disabled the auditor**: any
stale fact recalled from an old session would have satisfied the "some tool produced it"
test. That is the 2026-07-30 silent-degradation class the hook exists to catch.

Added `RECALLED_SOURCES` stripping `<claude-mem-context>`, `<observation>`, and the
"Memory Context from Past Sessions" block from the evidence pool before matching. Fresh
tool output stays admissible — the distinction is **recency-of-derivation, not source
type**. Tested both directions: identifier present only in recalled memory → **blocked**;
same identifier from a genuine tool result → **passes**. Each turn now logs
`stripped_recalled` byte counts to `provenance-audit.jsonl`, so the exclusion produces a
measurable rate rather than a claim.

**Open follow-up:** codegraph's injected source is currently still admissible evidence. It
is freshly derived from disk, so that is defensible — but a hardcoded identifier in source
could still be laundered into a live-state assertion. Deliberately not changed tonight
(CLAUDE-RULE-3); flagging it as a judgment call for review.

### 7.8 Material find — a free frontier-class family

Querying OpenRouter's live catalog surfaced **14 genuinely free models** (`$0` prompt *and*
completion), including:

| model | context |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | **1,000,000** |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 |
| `google/gemma-4-31b-it:free` / `gemma-4-26b-a4b-it:free` | 262,144 |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 256,000 |
| `openai/gpt-oss-20b:free` | 131,072 |

This partially corrects §7.3: I said Nemotron 3 Ultra was API-only. That is true — and the
API is **free here, at 1M context**. Two consequences:

1. It supplies the *new BFT families* at $0 that the 3+1 / 3×3+3 node design needs, without
   the weak-8B quality floor of local quantized models.
2. `nemotron-3-ultra-550b` is a candidate for the **frontier-model-in-panel** experiment
   that `HANDOFF.md` names as the only identified HAL ceiling-lifter — potentially at zero
   marginal cost.

**Caveats before anyone acts on that:** free tiers are rate-limited (a 429 was hit during
this very verification, then succeeded on retry), and adding a family **changes the ruler**.
Per `CLAUDE_RULES 24` it must be measured as a new configuration width on
`rigorous-v1@596f10de18d0`, not compared to the 0.91 baseline as if nothing moved.

---

### 7.9 Nemotron Ultra frontier-panel experiment — 2026-08-09 `[V]`

**Question:** the paid frontier panel (gpt-4o + claude-sonnet-4) bought only +0.010 F1. Can a
frontier-class voter at **$0** match it? Ruler fixed: `rigorous-v1@596f10de18d0` [holdout],
strictness 2, concurrency 3, 99 cases, 100% coverage on every run.

**Wiring.** `HAL_S2_ENABLE_FRONTIER_FREE` (default OFF), independent of `HAL_S2_ENABLE_FRONTIER`
so the already-measured paid arm stays byte-identical. `family: 'nvidia'` declared explicitly.
`tsc` clean.

**Pre-flight (all `[V]`):** parseable JSON verdicts at HAL's 512-token budget despite being a
reasoning model; 4/4 probes correct including the Pythagorean comma; latency 2.7–7.2 s inside the
12 s per-call timeout; `cost = 0`.

**Experiment 1 — paired, baseline always first (n=4).** Δ = **+0.0193**, t(3)=3.57, p≈0.04.
Looked like double the paid panel's lift, free. **Rejected on inspection:** groq failed a mean of
25.5/99 in baseline runs vs 2.5/99 in nemotron runs.

**Experiment 2 — ABBA order-balanced + 90 s cooldown (n=4).**

| arm | pairs | mean |
|---|---|---|
| baseline | .8713 / .8980 / .8980 / .8400 | **0.8768** |
| + nemotron | .8687 / .9000 / .8842 / .8454 | **0.8746** |

Paired diffs −.0026, +.0020, −.0138, +.0054 → **Δ = −0.0022**, t(3) = −0.54, **p ≈ 0.63**,
95% CI **[−0.016, +0.011]** — includes zero. Restricting to the two pairs before the panel
collapsed (below): **Δ = −0.0003**.

**RESULT: no detectable effect. The +0.019 was an artifact.**

**My order-effect diagnosis was wrong, and the truth is more interesting.** The groq asymmetry
*persisted* with order balanced — groq failed 27/31/36 in three baseline runs and **0 in all four
nemotron runs**. So it is not position, it is a *treatment side-effect*: or-nemotron's 2.7–7.2 s
call stretches each case's wall time, which spaces out the groq calls and keeps them under the
per-minute limit. **Adding a slow voter incidentally protects the fast free voters from
rate-limiting.** That is a real, reusable finding about free-tier panel scheduling — and it means
the two arms differ in more than one variable, so even the null result is not a clean isolation.

**THE BIGGER FINDING — the panel collapsed mid-experiment, and it invalidates the ruler.**

Provider failures /99 across the 8 ABBA runs, in execution order:

| provider | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 |
|---|---|---|---|---|---|---|---|---|
| cerebras | 75 | 72 | 74 | 83 | 84 | 71 | 72 | 90 |
| gemini | 0 | 0 | 0 | 0 | 0 | **64** | **99** | **99** |
| openrouter | 66 | 36 | 14 | 11 | 3 | 42 | 77 | **99** |
| groq | 0 | 0 | 0 | 27 | 31 | 0 | 0 | 36 |

- **cerebras failed 71–90 of 99 cases in EVERY run of both experiments.** It has been effectively
  absent all evening.
- **gemini died at run 6** and was fully dead for the last two runs.
- **openrouter reached total failure (99/99) in the final run.**

This is a `CLAUDE_RULES 24` situation in its purest form: **tonight's F1 (0.876–0.886) is lower than
this morning's baseline (0.9078) because providers died, not because HAL got worse.** The two are
not comparable numbers, and quoting them on the same axis would be exactly the "four rulers" error
that `project_measurement_rulers` exists to stop.

It also puts a caveat on the standing conclusion. "HAL is at a panel-limited ceiling of ~0.91" was
measured on a panel whose *actual live width* is not what the config claims — with cerebras at ~80%
failure, the effective panel is materially narrower than the configured one. **The ceiling may be a
provider-availability artifact as much as a model-quality one.**

**What is established:** Nemotron Ultra 550B works as a HAL voter — correct, parseable, in-budget,
`cost = 0`, distinct family. **What is NOT established:** that it changes F1 either way. The honest
estimate is indistinguishable from zero, measured on a degraded panel.

**Recommended next step — and it is not another lever experiment.** Measure and fix panel
availability first, and record per-provider failure counts as a first-class covariate on every
eval run. Any lever measured against a panel that silently loses 1–3 of its families between runs
is measuring provider weather. `or-nemotron` itself failed 26–37 of 99 cases, so even the treatment
arm was a ~⅔-available voter.

---

I keep codegraph at #3 where Grok puts headroom. Reason: headroom sits *in the request path* with an
unmeasured "same answers" claim, immediately before an autonomous overnight run — Rule 24 says get
the ruler first. Better shape than either of us proposed: **run headroom as a proxy on the VPS
alongside OmniRoute**, where it costs the laptop nothing, after a measured A/B.
