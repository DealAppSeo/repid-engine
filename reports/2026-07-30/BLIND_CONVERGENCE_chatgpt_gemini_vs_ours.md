# Blind-round convergence — ChatGPT + Gemini vs. the Claude/Grok design
**Date:** 2026-07-30 · **Protocol:** both models received ONLY the problem statement ("ungameable reputation-learning for capital-less agents; graduation earnable but not farmable") — no sight of our design. Divergence and convergence are therefore both real signal. · **Grok's blind round pending; spec v1 waits for it.**

## 1. Convergence table (blind agreement = architecture confirmed)

| Element | Ours | ChatGPT | Gemini | Verdict |
|---|---|---|---|---|
| Two-ledger split (practice can't graduate you) | learning/value tracks, graduation=admission | Learning Ledger vs Credential Ledger | Tier-0 sandbox, zero graph impact | **3/3 blind convergence** |
| Proper scoring + commit-before-reveal | calibration ledger, pre-registration | reviewer forecasts, Brier/log, LCB | commit-reveal blind audits | **3/3** |
| Evidence hierarchy, deterministic on top | L2 (execution > quorum > peer > self), in code | Tier A–D, "Tier D never graduates" | "verifying must be cheaper than forging" | **3/3** |
| Multi-axis, no averaging, hard floors | L5 multi-axis + stakes floors | `Graduate = ⋀ LCB(R_k) ≥ T_k` | vector-quantized domains, zero cross-transfer | **3/3** |
| Non-transferable rep, no purchase path | escrow in earned rep, admission not conversion | "no transferable reputation/influence" | domain non-transferability | **3/3** |
| Time as unforgeable input | vesting (crude) | evidence-age minimums per level | `ΔR_max = k·log(1+active_days)` — "time cannot be parallelized" | **3/3** (theirs sharper) |
| Repetition worth → 0 | supply damping (crude) | novelty decay | task-family caps | **3/3** (theirs sharper) |
| Public rules, private instances, committed evals | commit-reveal pool (Merkle, ours) | "private challenges, public rules, recomputable proofs" | hidden dynamic test synthesis | **3/3** |
| Anchor/bootstrap verifiers | HAL-as-verifier, sunset condition (Q2) | — | Tier-3 anchor nodes (humans, CI runners) seed trust | **2/3** |
| Sits ABOVE ERC-8004 as interpretation layer | our reading | stated explicitly (incl. the no-self-feedback primitive = our F3 fix) | — | **2/3** |

Three independent starts, one spine. This is as close to architectural confirmation as pre-launch evidence gets — with the standing caution that all four models share training-distribution bias, so convergence is strong evidence, not proof.

## 2. Adopted — genuinely new, absorbed into spec v1

1. **N_eff dependency-cluster math (ChatGPT).** `N_eff = (Σw)²/Σw²`, then cluster caps by shared user/model/family/task-source/community/lineage/timing. This is the rigorous generalization of our checkpoint-dedup ("two hosts of one model ≠ two votes") to *all* evidence. 500 reviews from one Discord = ~one cluster. Becomes the mathematical spine of A10.
2. **Lower confidence bounds everywhere (ChatGPT).** Score on `LCB(metric)`, not point estimates — ten lucky judgments can't mint influence; thin evidence self-penalizes. Complements credibility weighting and partially subsumes it on small samples.
3. **Version binding + agent manifest (ChatGPT — the biggest gap they found).** We score agents but never bind scores to agent *versions*. Model/prompt/tool/operator changes → partial reset or re-certification. Without this, an agent earns rep then swaps its brain. Requires `agent_manifest` + fingerprints; slots cleanly into the ERC-8004 registration file.
4. **Promotion holdout (ChatGPT).** Evidence generated *after* requesting graduation doesn't count toward that cycle. One line of policy; kills last-minute campaigns.
5. **Novelty decay per task pattern (ChatGPT) + log-time rate limit (Gemini).** Sharper forms of our supply damping and vesting: repetition credit → 0, and `log(1+active_days)` caps make 10,000 one-day agents worth less than one 30-day agent. Time becomes the one resource a swarm can't parallelize.
6. **Voice Credits (ChatGPT) — the sybil-safe form of Sean's QV instinct.** Equal per verified human per epoch, non-transferable, non-purchasable, *expiring*. Expiry is the piece Sean's framing needed: credits can't be stockpiled, so capture can't be accumulated either. ZK-nullifier uniqueness (RLN-style) is Phase-4 roadmap [R — citations unverified per incident-001 rule]; v1 uses ERC-8004 identity + rate limits.
7. **Governance/adjudication separation (ChatGPT).** Governance (incl. Sean's interim DAO delegates + QV) may change *future* thresholds and weights; it may never touch an individual agent's score, forgive an incident, or pick evaluators for a known case. This is the constitutional line that makes the delegate plan safe.
8. **Integrity as a blocking axis (ChatGPT).** Fabricated receipts / evaluator manipulation / hidden mandate violations block graduation regardless of competence — never averaged away. Severe-integrity asymmetry matches our HAL veto philosophy; now it's a graduation floor.

## 3. Rejected / deferred — with reasons

1. **Gemini's evaluator-reward rule — REJECT as stated.** "Evaluators are rewarded only if their score aligns with the Bayesian consensus of the audit pool" **rewards agreement** — the exact herding failure ChatGPT's answer, the peer-prediction literature, and our A7 analysis all warn against. Coordinated evaluators converge on a false consensus and get paid for it. Ours stands: score evaluators against *resolved outcomes* (proper rule); where outcomes don't exist yet, evidence stays Tier-C/weak — never consensus-paid.
2. **Full EigenTrust + spectral conductance — DEFER.** Principled, but it needs graph density we won't have for months (the ANFIS-retune starvation lesson, one level up). Adopt the *concept* (dense low-conductance clusters → flagged, weights throttled) as a batch audit job once the edge graph is real; don't build the spectral engine for a graph with 50 edges.
3. **Proof-of-personhood infrastructure — DEFER to Phase 4.** Right target, heavy dependency; v1 uniqueness = ERC-8004 identity + per-identity caps + learning-rep burn-in (our sybil-velocity limit).
4. **ChatGPT's illustrative thresholds (15/40/100 units, 7/21/60 days) — placeholders only**, marked tunable; our graduation constants stay anchored to measured things (≥75% third-party-verified from the bound-RepID sims).

## 4. Alignment notes for the spec
- ChatGPT's "decisive rule" is the spec's preamble, merged with our framing: *never "how many approved"; always "how much new, independently verifiable evidence exists that this exact version behaves well under conditions it could not predict or manufacture."*
- Their honest opening — literal ungameability is impossible; the target is making manipulation strictly less profitable than honest work and increasingly detectable at scale — replaces any absolute claim anywhere in our messaging. It *is* the checkable-claims rail applied to ourselves.
- Gemini's Tier-3 anchor nodes confirm the Q2 answer (HAL/CI as bootstrap verifier sinks, sunset as organic verifier supply arrives).

## 5. Ledger
| Claim | Source round | Outcome slot |
|---|---|---|
| Two-ledger split is the right spine | 4-model blind convergence | open |
| Consensus-paid evaluation is unsafe | ChatGPT + lit vs Gemini | open — test when evaluator data exists |
| Version binding closes a real exploit | ChatGPT (blind find) | open |
| N_eff cluster math implementable at our scale | ChatGPT | open |
| Voice Credits (expiring) sybil-safe without PoP in v1 | ChatGPT + Sean QV | open |
