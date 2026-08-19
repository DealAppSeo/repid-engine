# Agent-harness patterns — adoption plan

**Status: PHASE 1 LANDED 2026-08-19 (this document, plus one register entry and its test).
Phases 2+ are PLAN ONLY and none is applied without a further GO (CLAUDE-RULE-2).**

Phase 1 adds one new doc and one new pure-data module (`src/orchestration/harness-adoption-register.ts`,
plus its test). It changes no schema, no config, no scoring path, no route, and no existing
file's logic. Nothing in it runs at request time — see section 8.

---

## 0. Source and scope

A synthesis brought to this session named five other agent-harness projects — Omnigent,
DeepSeek Harness / Cordis, OpenHands, Composio / Claude Skills, and LangGraph — as sources for a
set of security and modularity recommendations, and asked that they be folded into this trust
harness. Read the same way `docs/RSI-ADOPTION-PLAN.md` read Goertzel's paper: **an outside survey
of production agent-harness design to borrow ideas from, not an architecture to copy.** Section 6
declines the brand names for the same reason that plan declined "OmegaHive."

**Scope:** all four repos in this session — `repid-engine`, `hyperdag-protocol`,
`trinity-ecosystem`, `trinity-symphony-shared` — were read. Only `repid-engine` receives code from
this plan; section 7 states why plainly.

**Method:** every grade below is HAVE / PARTIAL / MISSING, cited to a file, a file:line, or a
dated report. Numbers are only stated where this session read the citing document directly;
where a finding came from a dispatched research pass over a document this session did not open
itself, it is described without a precise figure attached, and the source document is named so a
reader can get the number from the ruler that produced it. That distinction is the same one
LESSONS 2 and 8 exist to enforce, and it applies here as much as to any measurement.

---

## 1. Two things that govern every grade below

### 1.1 "The trust harness" is two parallel systems, not one

`repid-engine/src/engine/repid-update.ts` and `trinity-ecosystem/lib/trustshell/repid-scoring.ts`
are two **independent** TypeScript implementations of RepID scoring, sharing one Postgres project
but not a line of code, not an HTTP call, and not even the same tier vocabulary — this repo's
canonical ladder is named in its own `CLAUDE.md`; trinity-ecosystem's `repid-scoring.ts` uses a
differently-named, differently-thresholded ladder. `trinity-ecosystem/lib/trustshell/KYAValidator.ts`
writes a *third* score lineage directly to a different table (`agent_kya_registry`), by direct
Supabase write, not through either scoring engine.

This is not a new finding. `trinity-ecosystem/docs/ROADMAP-HYBRID-REPID.md` already states the
fragmentation as fact — "no declared canonical source" — measures real drift between lineages, and
proposes (not yet applied) a unification plan. A 2026-08-17 decision already fixed the sharpest
edge of it: `KYAValidator.updateRepID()` now writes only the score, never the tier or a ceiling,
because the tier ladder is a derivation aid and the row is authoritative ("trust the row").

**What this means for every grade below:** where a HAVE/PARTIAL cites a mechanism, it names which
side of the fragmentation the mechanism lives on. This plan does not attempt unification — that is
already scoped, elsewhere, as its own piece of work.

### 1.2 The plugin-model question was already litigated here

`trinity-ecosystem/docs/DSH-ECOSYSTEM-POSITION-2026-08-15.md` ran a structurally similar exercise
four days before this one, against a different external system, and reached a recorded, reasoned
position directly relevant to the largest item on the recommendation list (DeepSeek/Cordis-style
"everything is a plugin"):

- It names the other system's seam/plugin composition (swap model, tools, or sandbox without
  touching core) as something that system does better than this one.
- It then declines to import the pattern as stated: **anything that can influence a verdict or
  memory must be a principal with an identity, not ambient host code.** A dynamically-loaded
  plugin with no identity is exactly the shape of thing that principle rules out.
- It separately declines adding new abstract seams (a session-log interface, a tool-policy
  interface, a memory interface, a payment interface) faster than they can be filled with a real
  implementation and a real caller — the same failure LESSONS 3 names for a safeguard wired at one
  end only, applied here to interfaces instead of guards.

This was a recorded disagreement between two prior reviewers, not a formally closed decision — a
new plan proposing a generic plugin loader would need to engage with it directly rather than
silently re-propose the thing it already argued against. This plan does that in section 4: it
declines the ambient-plugin framing and takes the narrower, identity-preserving pattern this
codebase had already, independently, converged on for the same reason — `module-space.ts`'s
`incumbent` / `shadow` / `retired`, where a shadow is still real, reviewed, named code, never a
dynamically loaded artifact.

---

## 2. Concept map

`HAVE` = built and live at its boundary. `PARTIAL` = built, but narrower than the recommendation,
unwired, or shadow-only. `MISSING` = no code found. Every PARTIAL says exactly what is missing,
not just that something is.

### 2.1 Security

| # | Recommendation | Grade | Evidence |
|---|---|---|---|
| S1 | Stateful, contextual policies evaluated against session history — escalate rigor or require approval on risk signals, tool sequences, spend thresholds, prior actions | **PARTIAL** | HAVE for payments specifically: `src/services/x402-gate.ts`'s `decideAuthority()` reads live tier, current RepID, *today's* already-authorized spend, open disputes, and available stake, then applies tier-based ceilings — a real dynamic, history-driven authorization decision. Not generalized: `src/middleware/auth.ts`'s general request auth is a static API-key allowlist plus identity-binding, not score- or history-driven. |
| S2 | OS-level sandbox + network egress proxy; the agent never sees real credentials, tokens injected only on approved requests | **PARTIAL / MISSING**, split | A real, tested, wired *content*-egress interception exists for self-host privacy — `src/selfhost/egress-guard.ts`, default off — classifying outbound content (prompt/embedding/datastore) versus commitment-only data (attestation/chain) and throwing before content-bearing calls leave the box. That is not process isolation and not per-call credential injection for a tool-executing agent. True OS-level sandboxing is explicitly out of scope for application code: `trinity-ecosystem/docs/AGENT-HOSTING.md` states the sandbox is inherited from the container, "not something we designed," and already has an unbuilt placement design for a credential-holding broker (evaluated against several hosting platforms) explicitly marked as work that does not exist yet. |
| S3 | Authority separation — model proposes, an assessment layer flags risk, the system (current trust score + policy) authorizes; the model is never the final authority on a side-effecting action | **HAVE** | The trust harness's dual-auth gate (`src/services/dual-auth-gate.ts`, `evaluateGate()`) is a fail-closed pure function combining agent authority, human authority, and a HAL veto into ALLOW/REFUSE — demonstrated live via `npm run demo:harness` refusing an action on HAL veto with both authorities otherwise satisfied. trinity-ecosystem's payment path is stated to have exactly one approve predicate, also fail-closed on any missing input. |
| S4 | Multi-level policy scopes (session / agent / global) and cost or budget controls that can pause or degrade privileges | **PARTIAL** | Real but piecemeal, not a unified hierarchy: a `Budget` type (unit/limit/spent) exists as a pure, unwired type in `src/orchestration/context-frame.ts`; trinity-ecosystem's agent loop carries session-scoped counters; `x402-gate.ts`'s tier-based per-transaction and per-day ceilings are live budget controls, scoped to payments only. No session/agent/global hierarchy was found as a single concept. |

### 2.2 Modularity and functionality

| # | Recommendation | Grade | Evidence |
|---|---|---|---|
| M1 | Durable, resumable trust state: checkpoints of decisions, pending proofs, history; crash recovery, session fork/replay, rollback on veto or anomaly | **PARTIAL** | trinity-ecosystem exports a signed `Handoff`/`Checkpoint`/`FailureRecord` type and a `DurableLedger` with hydrate/persist and an explicit ordering guard (an unloaded ledger cannot be saved). `ContextFrame` (this repo, RSI-ADOPTION-PLAN Phase 1) defines the addressable frame shape — goals, hypotheses, commitments, budgets, provenance, completion criteria — as a pure type; nothing writes one yet. |
| M2 | Append-only, reconstructible event/trajectory logs of every inference, injected context, action, and perception signal feeding scoring | **HAVE**, scope noted | `hal_audit_chain` is generalized (any `source_table`/`source_id` can chain in), tamper-evident, and publicly verifiable with no auth at `GET /api/v1/audit/verify` (`docs/AUDIT-CHAIN.md`). It is opt-in per write site — a caller must call `appendToAuditChain` after its own insert. This plan did not audit which of the score/event-mutating write paths do that versus which do not; section 5 proposes a coverage check as future, not-yet-built work. |
| M3 | Defense-in-depth: a trust/control plane separate from the compute sandbox; least-privilege tool permissions attenuated by trust score; capability-style tokens with limits | **PARTIAL, shadow** | Sandbox half: see S2. Capability half: real, tested code — `capability.ts` (`permits`/`isAttenuationOf`/`intersect`/`excess`), `control-proof.ts`, `delegation.ts`, `auditor-grant.ts` (makes "read-only" a checkable graph-reachability property, not an asserted label) — wired into the live payment path in shadow-only mode. Registered by this plan's Phase 1; see section 8. |
| M4 | "Everything is a plugin": a lifecycle (pending → active → disposed), dependency injection, reversible effects; HAL verifiers, zkRepID scorers, policy engines, and storage backends as hot-swappable plugins | **DECLINED as stated; HAVE a stricter, narrower analogue** | See section 1.2. What exists instead: `src/orchestration/module-space.ts` (`incumbent` / `shadow` / `retired` — a shadow structurally cannot influence the boundary's output) and `src/orchestration/promotion-ledger.ts` (`shadow` / `promoted` / `parked` / `rejected` — promotion requires a ruled measurement, never an env-var flip). Landed as pure types on 2026-08-17, deliberately not yet applied to any live call site; RSI-ADOPTION-PLAN's own Phase 2 proposes exactly one first boundary (the two disagreeing HAL signal extractors — see H2) and explicitly forbids this becoming a router refactor. A narrower, already-live precedent for a config-selected backend exists too: the rate limiter's Redis-versus-memory backend and the decoupled ZK-prover wrapper (`DECISIONS.md` #6, #7). |
| M5 | Config-driven (YAML or equivalent) composition of trust capabilities, so operators customize without code changes | **HAVE** | `docs/policy/authority-policy.v0.5.yaml` plus `loadAuthorityPolicy()`/`effectiveAuthority()` in trinity-ecosystem. No constant in the loader carries a hardcoded default — a default would be a second, silently-drifting copy of the policy — which is a stricter bar than the recommendation asked for. |
| M6 | Adaptive modes (minimal / standard / strict) that change quorum size, thresholds, or required proof strength by context or trust score | **PARTIAL** | HAL's own strictness scale is real and live — five levels, L1 (extractor only) through L5 (adds a tampering signal), default L4 (`docs/HAL_LIBRARY_API.md`). Not confirmed in this pass: whether level selection is driven dynamically by a caller's live trust score, or fixed per deployment. trinity-ecosystem's `HarnessProfile.ts` (a six-dimension settings resolver with a layered vendor→org→user→agent authority order) and a five-tier autonomy ladder are designed for exactly this outcome but are currently unpopulated and keyed to a scale that does not match RepID's own scale elsewhere — a mismatch that repo's own design doc already flags. |
| M7 | Progressive disclosure: load only the needed slice of history, proofs, or signals on demand, keep the core loop lean | **HAVE** | trinity-ecosystem's `MemoryRecall.ts` — tiered, budgeted recall planning (`chooseRecallTier`, `RecallBudget`, `applyRecallBudget`, `compileRecallPlan`) — is close to exactly this, already built. |
| M8 | Structured, portable skill/workflow packages for common trust operations (verify, score, present a proof, a trust handshake) | **PARTIAL** | No formal skill-package format was found for trust operations specifically. Closest existing thing: `@hyperdag/trustshell` is a real, published npm package explicitly positioned as "install this instead" of an unpublished kernel — a portable package for consuming trust primitives exists; it is not packaged as discrete operation "skills." The `presentProof`/badge surface itself is still queued work per this repo's own `SPRINT_BOARD.md`, which section 5 notes is stale. |
| M9 | Trinity as a meta-layer that can wrap, or be wrapped by, other harnesses (Claude Code, OpenHands, Codex, custom agents), with one policy applying uniformly across them | **MISSING — the highest-ambiguity item on this list** | trinity-ecosystem's `runAgentLoop` (`lib/trustshell/harness/loop.ts`) is a real, working, pluggable agent-execution kernel — typed `ModelClient`, `ToolDispatcher`, an `Authorizer` port returning a typed `AuthorizationVerdict`, session counters, signed handoffs — but built for, and used by, Trinity's own agents. No evidence in any of the four repos of it wrapping, or being wrapped by, an external coding harness. This is a genuine architectural question (which side holds authority when two harnesses disagree about a proposed action; how a foreign harness's tool calls get attenuated by this policy without that harness's cooperation), not an implementation gap — see section 5. |
| M10 | Event-stream or structured observability so external systems can observe, challenge, or consume RepID/HAL updates in real time | **PARTIAL** | A webhook registration table (`repid_webhooks`, per this repo's own `CLAUDE.md`) plus the public, no-auth `GET /api/v1/audit/verify` read surface cover "observe." "Challenge" exists as a live adversarial mechanism (`POST /challenge`) but for HAL calibration and testing, not for a third party to dispute one already-issued verdict. No real-time push path was confirmed wired end-to-end in this pass. |
| M11 | MCP-native exposure of trust primitives (query RepID, invoke HAL, request proofs) so other agents and tools can interact cleanly | **PARTIAL, split across repos** | A real Model Context Protocol server *and* client already exist and are tested in trinity-ecosystem (`lib/mcp/server.ts`, `fleet.ts`, `client.ts`, `app/api/mcp/fleet/route.ts`) — but they expose fleet discovery, not RepID/HAL primitives, and the backing registry is currently empty. Separately, `@hyperdag/trustshell-mcp` is a real, published npm package (confirmed live against the npm registry) already exposing HAL verification, ERC-8004 RepID, and x402 payments as MCP tools — but its source is not in any of the four repos this plan covers. Inside `repid-engine` specifically there is **no** MCP-protocol server: `src/engine/mcp.ts` is an unrelated, mostly-stubbed, proprietary Supabase-backed tool-call gateway that happens to share the letters "MCP" — a naming collision worth resolving before any real MCP code lands here. |

### 2.3 HAL + zkRepID specific

| # | Recommendation | Grade | Evidence |
|---|---|---|---|
| H1 | Pluggable multi-verifier / multi-model quorum | **HAVE**, ahead of the source material | Cross-LLM HAL quorum with family-disjointness enforcement (`src/decisioning/disjointness.ts`), auto-backfill of the next cheapest live family on provider errors, and a checkpoint registry curating host+model to weight identity, so an unmapped model can only ever *reduce* claimed independence, never fake it. RSI-ADOPTION-PLAN.md independently flags this exact mechanism as ahead of its own source paper. |
| H2 | Intermediate deterministic checks | **HAVE, with a known internal disagreement** | The 5-signal HAL extractor is deterministic and formula-based. Two independent extractor implementations exist in production and disagree on two of five signals (documented in `docs/HAL_CANONICAL_v1.md`) — exactly the boundary RSI-ADOPTION-PLAN's Module Space work is proposed for, and has not yet been applied to. |
| H3 | Adaptive rigor based on context or a live trust score | **PARTIAL — proven where it has been tried** | The HAL provider-evidence guard now downgrades an unearned veto or reward when zero providers actually responded — a real, live, measured escalation rule (veto precision **0.9578** with a provider present versus **0.4634** — chance — with none; ruler and both figures in `reports/2026-08-17/CTO_NIGHT_BRIEF.md` section 4). That is adaptive rigor, shipped. The broader claim — strictness level chosen dynamically by a caller's live RepID — was not confirmed as wired in this pass; see M6. |
| H4 | Emit ZK-friendly numeric risk scores rather than opaque flags | **HAVE** | HAL emits a numeric dissonance score and a calibrated probability, not a boolean, with one calibrated run captured against its own ruler (`VISION_VS_VERIFIED.md`). zkRepID already proves RepID-range statements without revealing the score (`src/zkrepid/`, `docs/ZKREPID.md`). |
| H5 | Append-only event log as the source of truth for Proof-of-Action | **HAVE, with a separately-tracked open defect** | Same mechanism as M2. Not this plan's to fix, named only so it is not assumed sound by omission: `trinity-ecosystem/NORTH-STAR.md` records the live ZK-proof linkage as currently unresolvable to a proof row for the proof rows it checked, as of 2026-08-17 — a measured, owned, in-flight defect, not a stub. |
| H6 | Progressive loading of history | **HAVE** | Same mechanism as M7. |
| H7 | Multi-source perception-of-value plugins (human feedback, downstream outcomes, peer agents, oracles) | **PARTIAL** | Downstream economic outcome: HAVE — `src/services/x402-outcome-link.ts` gates a positive delta on a real, verified payment proof. Peer agents: built, currently not running (the peer-verification mesh and the fleet stopped in the same week, for a separately-measured, distinct reason — `NORTH-STAR.md`). No formal plugin abstraction for perception sources as a class exists; this would be a real, well-scoped application of Module Space once that work reaches its own later phase. |
| H8 | Versioned or hash-chained state for portability and audit | **HAVE** | `hal_audit_chain`; Merkle roots in `src/memory/memory-root-anchor.ts`; Poseidon2/BabyBear fold-root commits verified in-circuit — the demo harness explicitly refuses to substitute a JS hash for the real circuit call, specifically so the check proves the circuit works rather than that the demo can hash. |
| H9 | Adaptive weighting schemes as hot-swappable plugins | **OFF LIMITS RIGHT NOW — not graded** | `docs/SPRINT-DECISIONS-2026-08-17.md` decision 1, verbatim posture: no reweight lands against the current ladder before P5 of the active sprint. Separately: routing/panel weight-tuning was already measured close to its theoretical ceiling (`reports/2026-08-17/CTO_NIGHT_BRIEF.md` section 5) — the same "two sprints optimizing a component already near its bound" mistake `trinity-ecosystem/CLAUDE.md` opens by warning about. Any weighting proposal has to engage with both facts before it is worth writing, and neither is this plan's to relitigate. |

---

## 3. Take / decline

### Take

1. **The concept-map discipline itself, applied here.** Grading each recommendation against real
   code rather than reacting to the pitch is the entire value of this document, and it is the same
   method `RSI-ADOPTION-PLAN.md` and `DSH-ECOSYSTEM-POSITION-2026-08-15.md` already used.
2. **A durable, append-only trajectory log**, with a torn-frame-recovery reference design — not
   proposed fresh by this plan; `DSH-ECOSYSTEM-POSITION-2026-08-15.md` already names it as agreed,
   unbuilt, next work (section 5, item ranked first).
3. **Registering genuinely dormant, well-evidenced mechanisms in the existing promotion ledger
   machinery**, rather than describing them in prose that a reader has to re-verify — this plan's
   own Phase 1 does exactly this once (section 8), and the pattern is worth reusing again the next
   time a real shadow mechanism turns up.
4. **HAL provider-evidence-gated adaptive rigor as the model for what "adaptive" should mean
   here** — a rule earns its escalation with a measured number attached, not a hand-picked
   threshold.

### Decline

- **A generic, ambient plugin-loader / microkernel.** Declined once already, on principle, in
  `DSH-ECOSYSTEM-POSITION-2026-08-15.md` — see section 1.2. Module Space is the identity-preserving
  alternative this codebase already chose.
- **New abstract seams (interfaces) ahead of a real second implementation behind them.** Same
  source: "five more seams with no implementations behind them" was already rejected for the same
  reason `module-space.ts`'s own `SINGLE_IMPLEMENTATION` flag exists — a boundary with nothing to
  compare against buys indirection, not measurement.
- **The vendor brand names** (Omnigent, DeepSeek Harness / Cordis, OpenHands, Composio, LangGraph).
  Adopt the concepts under generic or this codebase's own names; attaching another product's brand
  to this architecture would misrepresent a relationship that does not exist — the same reasoning
  `RSI-ADOPTION-PLAN.md` §2 gives for declining "OmegaHive."
- **Touching `DEFAULT_WEIGHTS`, HAL thresholds, ANFIS parameters, or the RepID formula.** Not this
  plan's lane under any reading; see H9 and the active sprint this plan defers to throughout.
- **Building OS-level sandboxing from scratch.** Already correctly scoped as infrastructure, not
  application code, with an unbuilt placement design already on file — see S2. Duplicating that
  design here would be exactly the "more docs" failure `RSI-ADOPTION-PLAN.md` §6 warns against.
- **Scaffolding a real MCP server speculatively.** Real MCP server and client code already exists
  (M11); the gap is wiring and population, a judgment call about which primitives to expose and
  under what auth model, not a green-field build. That decision belongs to whoever owns
  `trinity-ecosystem/lib/mcp/`, with explicit GO, not to a Phase 1 landed unprompted in a sibling
  repo.

---

## 4. What's actually open, ranked

Three items, in the order they are worth picking up. None is built by this plan — each needs its
own scoped session, and the first two already have a design or a stated agreement to build from.

1. **Trinity as a meta-layer over external coding harnesses (M9).** The one item that is both
   genuinely high-value and genuinely unbuilt with no existing design to extend. Needs a design
   pass before any code: who holds authority on disagreement, how a foreign harness's tool calls
   get attenuated without that harness's cooperation, and whether `runAgentLoop`'s existing
   `Authorizer` port is the right seam to extend or the wrong one to force this into. Recommend
   this be the subject of its own `AskUserQuestion`-scale decision with Sean before a line of code
   is written, given how architecturally load-bearing a wrong answer would be.
2. **The durable append-only trajectory log**, per `DSH-ECOSYSTEM-POSITION-2026-08-15.md` section 6
   — already agreed by two prior reviewers as next work, with a named reference design (torn-frame
   recovery) to build from rather than invent. Distinct from `hal_audit_chain` (a reputation-delta
   log) and from `TranscriptParser` (parses transcripts after the fact, deliberately emits no
   liveness verdict) — this would be the thing neither of those is.
3. **An audit-chain coverage check** (M2): a small, read-only script that enumerates known
   score/event-mutating write sites and reports which do and do not call `appendToAuditChain`,
   following the existing `check:*` convention (`npm run check` auto-discovers any
   `"check:name"` script — no hand-maintained chain to edit, per this repo's own `CLAUDE.md`
   note about that exact anti-pattern). Cheap, safe, produces a measurement instead of an
   assumption. Not built in this pass because it requires enumerating write sites across the
   codebase more exhaustively than this session's research pass did, and a shallow or wrong
   enumeration would be worse than none (LESSONS 2).

Two items **not** included above on purpose: wiring the existing MCP server to expose RepID/HAL
primitives (declined in section 3 — needs an owning decision, not a drive-by), and unifying the
two RepID lineages (section 1.1 — already scoped elsewhere, in `docs/ROADMAP-HYBRID-REPID.md`).

---

## 5. Terminology

| Source term | This codebase's decision | Note |
|---|---|---|
| Omnigent, DeepSeek Harness / Cordis, OpenHands, Composio, LangGraph (as brand names) | **Decline** | Cited for provenance; not adopted as vocabulary. Same reasoning as declining "OmegaHive." |
| "Everything is a plugin" | **Decline as stated; take the goal** | See section 1.2, 3. The goal (hot-swappable, measured mechanisms) is already served by Module Space and the Promotion Ledger. |
| Stateful contextual policy | **Already partly ours, under a narrower name** | `x402-gate.ts`'s `decideAuthority()` is the one live example; no umbrella term exists yet for the pattern generalized beyond payments. |
| Capability-style tokens | **Already ours** | `capability.ts` / `control-proof.ts` / `delegation.ts` in trinity-ecosystem; registered by this plan's Phase 1 (section 8). |
| Progressive disclosure | **Already ours, as "recall tiers"** | `MemoryRecall.ts`'s `RecallTier` / `RecallBudget`. |
| Meta-layer | **Open — no decision yet** | Section 4, item 1. Deliberately not named or typed by this plan; naming it before the design question is answered would be exactly the "vocabulary without the loop" failure `RSI-ADOPTION-PLAN.md` §6 names. |

---

## 6. Why Phase 1 lands only in `repid-engine`

All four repos share branch `claude/trust-harness-roadmap-ukdfyo` for this task. Before writing
anything, this plan checked what was already on that branch:

- `hyperdag-protocol`: identical to `main`, no divergent work.
- `trinity-symphony-shared`: one commit ahead of `main`.
- `repid-engine`: **9** commits ahead of `main` — the RSI-adoption-plan and zkRepID-canonicalization
  work this document builds on.
- `trinity-ecosystem`: **~40** commits ahead of `main` — the entire live, owner-issued P0–P5
  sprint (`docs/SPRINT-DECISIONS-2026-08-17.md`), still in flight
  (`docs/TRUST-HARNESS-STATUS-2026-08-17.md`: "spine in place; activation incomplete").

Landing new commits on `trinity-ecosystem`'s copy of this branch right now would mean committing
next to, and risking collision with, that active sprint's own history, for a plan that does not
need to touch anything on that side — every trinity-ecosystem finding above is cited by path, not
imported or modified. `repid-engine` is also where the reusable governance machinery
(`promotion-ledger.ts`) and the direct precedent (`RSI-ADOPTION-PLAN.md`) already live. So this
plan's code lands there, and only there; no pull request is opened against the other three repos
for this task.

---

## 7. What Phase 1 shipped

- This document.
- `src/orchestration/harness-adoption-register.ts` — one new `LedgerEntry`, using the existing,
  unmodified `promotion-ledger.ts` machinery, registering the capability/delegation shadow system
  (M3 / S4 above) as `shadow`, `NOT_CHECKED` (there is no delegation traffic yet to measure
  against). It does not extend `promotion-register.ts` — that file's own header scopes it to a
  different, already-landed plan's three mechanisms; see the new file's header for why a second,
  equally small register is the more honest choice than blurring the two.
- `tests/harness-adoption-register.test.ts` — pins the register's validity the same way
  `tests/promotion-ledger.test.ts` pins `promotion-register.ts`: importing the register runs its
  `record()` validation, and the test additionally asserts nothing is promoted, every entry has a
  concrete reason it cannot be promoted today, and the two registers never share a mechanism id.

Nothing here is imported by any request-time code path. `module-space.ts`'s own documentation is
explicit that the ledger "does not GRANT authority" — this Phase 1 is exactly as inert as the one
it follows.

---

## 8. Incidental findings, not acted on

Found while researching, out of this plan's scope, listed rather than fixed per CLAUDE-RULE-3 (fix
only the named error) and CLAUDE-RULE-6 (no busywork beyond the task):

- `hyperdag-protocol/SECURITY.md`'s disclosure email has a typo that breaks the address. Small,
  safe, one-line fix if wanted — not made here since it required its own branch/PR in a repo this
  plan otherwise does not touch.
- `hyperdag-protocol`'s top-level README markets a Plonky3 STARK prover throughout, while
  `packages/circuits/` contains a Circom/snarkjs circuit — a different proving system. Worth a doc
  pass by whoever owns that repo's proving-system story.
- `CLAIM_LEDGER.md` and `SPRINT_BOARD.md` in this repo are genuinely stale — added by one commit on
  2026-08-09 and untouched since, roughly 49–50 commits behind current `HEAD`.
  `VISION_VS_VERIFIED.md` (last touched 2026-08-17) is the current source of truth in the meantime.
  Refreshing the other two is a real, separate piece of work this plan does not attempt.

---

## 9. Risks

- **Terminology adopted, discipline skipped.** The likeliest failure mode of a document like this
  one, named in `RSI-ADOPTION-PLAN.md` §6: renaming things is cheap and produces zero measurement.
  Mitigation here is structural — section 3 declines new vocabulary everywhere a real mechanism
  already exists under a different name, and Phase 1 adds exactly one register entry, not one per
  concept-map row.
- **Staleness.** Every citation above is dated; several of the richest sources
  (`CTO_NIGHT_BRIEF.md`, `NORTH-STAR.md`, `DSH-ECOSYSTEM-POSITION-2026-08-15.md`,
  `docs/TRUST-HARNESS-STATUS-2026-08-17.md`) are two to four days old at the time of writing.
  Re-verify before citing this document as current in turn.
- **Two independent scoring systems (section 1.1).** Any future phase that assumes "the trust
  harness" is one system, or that proposes calling one repo's API from the other, is proposing new
  integration work that does not exist today — flag it explicitly if it comes up.
- **Public repo.** This document was written for `repid-engine`, which is public. It states
  findings and file paths, not counts, ids, or the contents of the two hard-stopped facts (the
  RepID formula, ANFIS parameters). It quotes no verbatim passage from a sibling repo whose
  public/private status this session did not itself confirm — described in this plan's own words
  instead, with a path citation.

---

## 10. Open questions for Sean

1. **Section 4, item 1 (meta-layer over external harnesses)** — is this the right next thing to
   design, and if so, does `runAgentLoop`'s existing `Authorizer` port belong at the center of it,
   or is that the wrong seam to force it into?
2. **Section 4, item 3 (audit-chain coverage check)** — worth a dedicated pass to enumerate write
   sites properly, or low enough value to skip?
3. **Do we say publicly that this synthesizes ideas from named third-party agent-harness
   projects?** Section 5 already declines their brand names as vocabulary; this is the narrower
   question of whether to credit them by name in anything public-facing. `RSI-ADOPTION-PLAN.md` §8
   asked the analogous question about its own source and left it open — restating it here rather
   than deciding unilaterally.

---

## Sources consulted

Within `repid-engine`: `LESSONS.md`, `DECISIONS.md`, `VISION_VS_VERIFIED.md`, `CLAIM_LEDGER.md`,
`SPRINT_BOARD.md`, `docs/RSI-ADOPTION-PLAN.md`, `docs/ARCHITECTURE.md`, `docs/AUDIT-CHAIN.md`,
`docs/HAL_CANONICAL_v1.md`, `docs/HAL_LIBRARY_API.md`, `docs/ZKREPID.md`,
`reports/2026-08-17/CTO_NIGHT_BRIEF.md`, `src/orchestration/{module-space,context-frame,
promotion-ledger,promotion-register}.ts`.

Within `trinity-ecosystem`: `NORTH-STAR.md`, `docs/SPRINT-DECISIONS-2026-08-17.md`,
`docs/TRUST-HARNESS-STATUS-2026-08-17.md`, `docs/SPRINT-TRUST-HARNESS.md`,
`docs/PRIOR-WORK-INDEX.md`, `docs/DSH-ECOSYSTEM-POSITION-2026-08-15.md`,
`docs/AGENT-HOSTING.md`, `docs/HARNESS-SPEC.md`, `docs/MCP-FLEET.md`,
`docs/ROADMAP-HYBRID-REPID.md`, `lib/trustshell/portable.ts` (the full exported surface) and the
identity/, harness/, and mcp/ modules it re-exports.

Within `hyperdag-protocol`: `README.md` (post-correction), the local HAL and ERC-8004 default
packages, `.github/workflows/ci.yml`.

Within `trinity-symphony-shared`: `README.md` (post-correction), `package.json`,
`lib/resolve-supabase-service-key.js`, `lib/service-contract-client.js`,
`lib/substance-gate-client.js`.
