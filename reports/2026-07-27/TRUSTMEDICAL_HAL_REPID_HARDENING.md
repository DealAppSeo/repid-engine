# TrustMedical-driven HAL / RepID hardening — fleet backlog
**Created:** 2026-07-27 · **Origin:** TrustMedical positioning (E:\dev\living-docs\content\TRUSTMEDICAL_POSITIONING_BRIEF.md §10)
**Rule:** every item is **general-purpose** (helps all verticals), lands in the **existing `repid-engine`** (NO new repo, NO front end), ships **shadow-first / flag-inert**, and is **RTP evidence for Patents #1/#2** *and* a TrustMedical proof point. The medical use case *sharpens* these; it does not create medical-specific behavior. **No PHI, ever** (ZKP Invariant 4). Producer never self-validates (independent verify each).

## Dependency-ordered queue
| # | Task | Serves | Shadow/flag | Acceptance test | Depends on |
|---|---|---|---|---|---|
| 1 | **Medical-flavored HAL eval set + measurement.** Curate cases: retracted guideline, superseded drug-interaction, current-vs-stale fact, correct-current control. Run through HAL grounding/abstention. Report abstention rate + hallucination drop vs baseline. | HAL hardening · pitch numbers · Patent #1 RTP | measurement only (no flags, no PHI) | eval set committed under `tests/hal/medical-grounding/`; a run prints abstain/veto/pass counts + F1 vs baseline; NO synthetic — each case cites a public source (illustrative, non-actionable) | market research (safe, sourced example cases) |
| 2 | **Evidence-grade + recency on leaf provenance → HAL.** Extend leaf provenance with `evidence_grade` + `source_recency`; HAL abstains sooner on low-grade/stale grounding. | proof-carrying leaf · HAL · all verticals | `HAL_EVIDENCE_TIERING=off\|shadow\|enforce` default shadow | leaf carries the fields (additive, back-compat); shadow log shows would-abstain flips; existing proof-carrying tests still green | proof-carrying leaf (merged) |
| 3 | **Domain-scoped RepID (namespace).** Reputation per `domain`/namespace (ZKP Invariant 6). An agent's medical RepID ≠ its code RepID. | RepID · ZKP Inv6 · all verticals | additive column + shadow scoring; no live-tier change | `repid_score_events` carries `domain`; a per-domain read returns scoped RepID; global RepID unchanged when domain absent (back-compat) | schema read first (FK/trigger check) |
| 4 | **Stakes-scaled abstention threshold (V1.4).** HAL abstention threshold scales with stakes; high-stakes → abstain more readily. | HAL · roadmapped V1.4 · all verticals | `HAL_STAKES_WEIGHTED=off\|shadow\|enforce` default off | shadow shows threshold varying with a stakes input; default-off = byte-identical live behavior | #2 (evidence tiering in path) |

## Guardrails (non-negotiable)
- **Shadow-first:** no enable-flag flipped without measurement + Sean GO (lesson #2, 2026-07-25 sprint).
- **Schema-first:** read columns + FKs + triggers before any DDL/INSERT (lesson #3). `repid_agents.tier` is trigger-derived — do not fight `trg_sync_tier`.
- **No PHI, no medical data plane** — these are general engine features tested with *illustrative, public, non-actionable* cases only. The real clinical data plane is a funded-phase build with a design partner (brief §9).
- **RTP discipline:** document exact schema + measured numbers (abstention rate, RepID delta grounded-vs-ungrounded) — that documentation IS patent enabling-disclosure.

## Not in scope this week (explicit)
- ❌ TrustMedical.dev front end or repo (may be a Wed hackathon deliverable — hold).
- ❌ Any real patient record, PHI store, or clinical integration.
- ❌ ZK property-proof circuit for health data (P5) — LATER, health vertical, after a design partner.
