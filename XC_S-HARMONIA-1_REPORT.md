# XC SPRINT: S-HARMONIA-1 — Bootstrap Project Harmonia

**Date:** 2026-06-01  
**Branch:** feat/xc-s-harmonia1-2026-06-01 (isolated XC worktree)  
**Priority:** LOW — Background research project. Runs only on free LLM/SLM daily quotas. Never blocks production work.  
**Status:** Design-only complete. Five artifacts delivered in `scratch/`. No DB changes, no production code, no quota consumption.

---

## Executive Summary

Project Harmonia is a long-horizon, low-resource research program that uses the **Circle of Fifths** as a systematic pattern-matching framework for discovering synergistic combinations of algorithms. The T12 agent swarm (and future Grok-assisted runs) will execute small numbers of experiments exclusively on free daily quotas (Groq, Cerebras, Gemini AI Studio, Ollama local, Together free credits).

This sprint bootstrapped the complete data foundation and experimental protocol:

- Schema for experiments + budget tracking with S-AUD1-style hash chaining
- Full 12-position Circle configuration with algorithm families, all major/minor triads, and explicit dissonant controls
- End-to-end harness specification with strict quality gates (baselines + random control + 3× reproduction + BFT escalation)
- Self-improvement feedback protocol (feature flags → A/B → production adoption → meta-learning back into chord selection)
- Theoretical validation brief specifically for Grok

**Core invariants maintained:**
- Every experiment includes fresh individual baselines + a random control on the identical task.
- No production impact until 3× reproduction + appropriate governance (A/B for routing/HAL, BFT meta-vote for consensus, Sean review for emergent).
- The Circle hypothesis is explicitly falsifiable.
- All data is hash-chained; anchoring is testnet-only.

**Target for the research program:** Generate a small number of high-confidence, reproducible "chords" that can be turned into feature-flagged improvements to routing, HAL, or consensus — while treating the entire effort as a pure side project.

---

## Isolation Confirmation

All work performed exclusively inside the dedicated XC worktree on branch `feat/xc-s-harmonia1-2026-06-01`.

- `git worktree list` confirms `C:/Users/Cash4/repos/repid-engine-xc` points to the correct worktree gitdir.
- Shared `repid-engine` repo was accessed read-only only (via `git -C`) for context from prior sprints (S-AUD1 hash-chain patterns, RepID economy, HAL, ANFIS references). No checkouts, no edits, no commits on the shared tree.
- All five deliverables written only to `scratch/` inside the XC tree.
- Final commit (see end of report) touches only XC files.

---

## TASK 1: Schema Design

**Artifact:** [scratch/S-HARMONIA-1_schema.sql](C:\Users\Cash4\repos\repid-engine-xc\scratch\S-HARMONIA-1_schema.sql)

Two tables created as pure design:

### harmonia_experiments
Full column set matching the sprint spec exactly, plus:
- `previous_entry_hash TEXT` for S-AUD1-style hash chain
- Proper `CHECK` on `consonance_class`
- Indexes on `(hypothesis_confirmed, reproduction_count)`, chord, and `created_at`
- Comments noting design-only nature and the expected append pattern for the hash chain

### harmonia_budget
- Tracks `daily_quota_tokens`, `used_today`, `quota_reset_hour` (UTC)
- Seeded with the five free providers requested:
  - groq: llama-3.1-8b-instant (~6000 req/day)
  - cerebras: llama3.1-8b
  - google: gemini-2.0-flash (AI Studio)
  - ollama: local models (unlimited, compute-bound)
  - together: free credits for new accounts
- Plus two extra local Ollama entries for flexibility

**Notes to Sean (in the file):** Budget check + experiment INSERT + budget UPDATE should be in one transaction. Hash-chain logic mirrors `append_hal_audit_chain`. Testnet anchoring only.

---

## TASK 2: Circle of Fifths Configuration

**Artifact:** [scratch/S-HARMONIA-1_circle_config.json](C:\Users\Cash4\repos\repid-engine-xc\scratch/S-HARMONIA-1_circle_config.json)

Complete, self-describing configuration containing:

- 12-position circle with musical key names (C through F) and 2–3 algorithm/formula candidates per position, each tagged with domain(s).
- Explicit `triad_definitions` (major = [0,4,7], minor = [0,3,7], diminished, augmented, dissonant_control).
- All **12 major triads** enumerated with positions, notes, and class.
- All **12 minor triads** enumerated.
- 5 explicit **dissonant controls** (maximally non-harmonic selections) with descriptive rationales.
- `experiment_space` summary (29 distinct chords, rotation policy, falsifiability test).
- `rotation_policy` matching the sprint spec (3 consonant + 1 dissonant + 1 random per batch of 5, max 5/day).

**Key design choice:** Algorithms were placed so that adjacent positions share families (iterative numeric, information theory, probabilistic inference, graph, attention, population search, BFT, neuro-fuzzy, embeddings, economic/governance, trust/HAL, formal/zkp). Dissonant chords deliberately cross these families.

---

## TASK 3: Experiment Harness Specification

**Artifact:** [scratch/S-HARMONIA-1_harness_spec.md](C:\Users\Cash4\repos\repid-engine-xc\scratch\S-HARMONIA-1_harness_spec.md)

Full 12-step end-to-end protocol:

1. Hypothesis text generation from chord + domain
2. `hypothesis_hash = SHA-256(...)` computed before any calls
3. Hard budget gate against `harmonia_budget` at execution time
4. Three individual baseline runs (metrics recorded)
5. Chord run (combined execution + `emergent_capability` free-text capture)
6. Random control run (different triple, same task)
7. HAL 5-signal evaluation on results (free provider)
8. Scoring: `hypothesis_confirmed = (chord > baseline_mean) AND (chord > control)`
9. Insert with hash-chain `previous_entry_hash` + budget update in one transaction
10. Daily batch queue for testnet anchoring
11. Return full structured record

**Scheduling & Quality Gates (strict):**
- Max 5 experiments per day
- Off-peak or low production queue only
- Every experiment **must** have baselines + random control
- HAL < 0.5 → INCONCLUSIVE
- 3× reproduction required before any production consideration
- BFT disagreement → SHOFET escalation
- Explicit falsifiability test (if random beats structured after 30+ experiments → reject framework for that domain)

---

## TASK 4: Self-Improvement Protocol

**Artifact:** [scratch/S-HARMONIA-1_self_improve_spec.md](C:\Users\Cash4\repos\repid-engine-xc\scratch\S-HARMONIA-1_self_improve_spec.md)

Four distinct adoption paths with increasing governance strength:

1. **Routing** — feature flag → 100-task A/B (pre-defined success criteria on HAL delta, latency, cost) → rollout + ANFIS weight update.
2. **HAL scoring** — shadow mode A/B against labeled corpus + existing measurement harness.
3. **Consensus / BFT** — requires explicit BFT participant vote + SHOFET review (meta-governance: "the system votes on whether to change how it votes").
4. **Emergent capability** — full "Emergent Finding Report" → patent queue (P-030+) → Sean strategic decision.

**Critical feedback loop:** Every adopted (or rejected) chord outcome becomes new labeled data that improves the *next* chord proposal model (ANFIS learns which families and intervals are fertile). This is the true "harmonia."

All paths enforce 3× reproduction, feature flags with instant rollback, and full audit back into the experiments table.

---

## TASK 5: Grok Handoff Brief

**Artifact:** [scratch/S-HARMONIA-1_grok_brief.md](C:\Users\Cash4\repos\repid-engine-xc\scratch/S-HARMONIA-1_grok_brief.md)

Self-contained theoretical validation task list for Grok (or any future strong model):

1. Validate / critique / reorder the 12-position algorithm mapping.
2. Select and justify the 3 most promising dissonant chords with one-paragraph synergy hypotheses for "meta_routing" or "hal_improvement".
3. Prior-art search: has musical interval theory (especially Circle of Fifths) been used as a combinatorial search heuristic for algorithms/agent systems before?
4. P-030 patent viability assessment ("Musical-Theory-Guided Combinatorial Algorithm Discovery with ZKP-Anchored Experimental Provenance") — go/conditional/no-go + strongest claims + 2–3 strengthening suggestions.
5. Propose concrete refinements to the consonance/dissonance model (data-driven, spectral, harmonic-series, empirical, etc.) with at least one worked counter-example triad.

The brief is written so it can be handed to a fresh Grok session with no other context.

---

## VERIFIED_TRUE / REAL_VS_ROADMAP

- All five requested artifacts were created with the exact names and contents described in the sprint.
- Schema matches the column list verbatim (including `previous_entry_hash`, budget seeding, CHECK constraint).
- Circle config contains the full enumerated major/minor/dissonant sets + experiment space math.
- Harness, self-improve, and Grok brief are detailed, self-contained, and respect every rule (free-only, 3× reproduction, falsifiability, hash-chain, testnet-only, side-project status).
- References to existing production concepts (S-AUD1 hash chain, ANFIS, HAL 5-signals, RepID, BFT, SHOFET) are accurate to prior ratified work in this repository.

---

## DOORS / INSPECTION_RISK

- **Door:** The concrete "how do we actually compose three algorithms in a chord at runtime?" is intentionally left as an implementation variable in the harness spec (different composition strategies can be tried). Low risk — the spec requires the composition method to be versioned and recorded with every result.
- **Door:** Quota realism. The seeded numbers are best-effort from public knowledge as of 2026-06-01; actual daily free allowances drift. The budget table + gate-at-execution-time design handles this.
- **Inspection risk:** None on the shared production codebase — pure design artifacts in isolated XC tree.

---

## HANDOFF

**To Sean:**
- Schema is ready for review and future application (when free capacity exists and desire to run the first batch).
- Budget table already contains the five free providers + two Ollama extras.
- No production tables or foreign keys are touched.

**To CC / GA (T12 swarm owners):**
- The harness and self-improvement specs are the contract for how any future automated or semi-automated Harmonia runner must behave.
- The 3× reproduction + governance gates are non-negotiable.

**To future Grok instances (or Claude doing theoretical work):**
- Start with `scratch/S-HARMONIA-1_grok_brief.md`. It is the complete, standalone theoretical validation task.

**To Cowork:**
This is a pure side-project. It will only ever run on free bandwidth and only ever influence production through the strict, flag-gated, multi-reproduction channels documented here. No resource contention with S-MERGE1, S-RLS, S-AUD1, or any active production sprint is intended or allowed.

---

## Summary Table of Deliverables

| File | Purpose |
|------|---------|
| `scratch/S-HARMONIA-1_schema.sql` | Two tables + seed data + hash-chain guidance |
| `scratch/S-HARMONIA-1_circle_config.json` | 12-position mapping + all 29 chords enumerated |
| `scratch/S-HARMONIA-1_harness_spec.md` | 12-step protocol + scheduling + quality gates |
| `scratch/S-HARMONIA-1_self_improve_spec.md` | Feedback loops, A/B, BFT meta-governance, patent path |
| `scratch/S-HARMONIA-1_grok_brief.md` | Theoretical validation tasks for Grok |

**Report:** This file (`XC_S-HARMONIA-1_REPORT.md`)

---

**End of XC_S-HARMONIA-1_REPORT.md**

Design-only sprint complete in isolated XC worktree on `feat/xc-s-harmonia1-2026-06-01`.

**COWORK CO-SIGN REQUESTED** before any schema is applied or any free-quota experiments are scheduled.  
This work remains strictly background and will never block or compete with production sprints.

All prior XC sprint invariants (D-050–D-058, isolation, read-only on shared, design-only posture, hash-chain discipline from S-AUD1) maintained.
