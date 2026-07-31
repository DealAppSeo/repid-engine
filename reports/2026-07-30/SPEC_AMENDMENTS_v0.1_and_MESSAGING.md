# Spec v0.1 amendments (post Grok round 2) + messaging alignment
**Date:** 2026-07-30 · **Supersedes:** the A1–A6 list in `D054_CONCURRENCE_ROUND1_grok_vs_claude.md` · **Both models now agree on every point below**

---

# PART 1 — Amendments

## Resolved disagreements (round 2, cold)
- **A1 is necessary but NOT sufficient.** Grok concedes it should be adopted; Claude concedes it doesn't close the system. Both agree: proper scoring + external-resolution floor is the floor, not the ceiling.
- **Resolution, not storage, is the ledger's hard part.** Grok explicitly corrected his Q5 wording (0.90). Claude's push-back 2 accepted. Binding constraints: acquisition rate, independence, lag structure, sparsity — especially on high-stakes claims.

## New amendments forced by round 2

**A7 — Coverage requirement / abstention penalty.** *(closes Grok's "strategic abstention")*
On a thin honest ledger an agent improves its Brier by refusing hard claims and answering only where external confirmation is likely. That's calibrated sycophancy: perfect scores, useless coverage. Therefore score **two things**, never one: calibration (Brier over answered claims) **and coverage** (share of *presented* claims answered, bucketed by difficulty and stakes). An agent that abstains its way to a good Brier must show a visibly bad coverage number. Abstention stays legitimate and free at low coverage cost; it stops being a strategy.

**A8 — Stakes classification is protected.** *(closes the A2 bypass Grok found)*
A2 (users may only raise thresholds at high/irreversible stakes) is trivially bypassed if the *stakes label itself* is user-settable — just relabel the irreversible action "low." So: stakes classification is **non-user-overridable**, defaults conservative, and the boundary is protected. A user may escalate a claim's stakes, never de-escalate it. Multi-homing (running several agents to shop for a permissive classifier) is logged as a signal, not silently permitted.

**A9 — High-stakes under-sampling countermeasure.** *(the sharpest residual, Grok's own ranking)*
Irreversible/high-stakes claims are precisely the ones least likely to yield rapid, cheap, unambiguous external resolution — so a naive scored set systematically under-represents exactly what the stakes hierarchy exists to protect. Three counters, cheapest first:
1. **Publish the composition.** Report the scored set's stakes distribution beside every score. A calibration number computed on 95% low-stakes claims must *say so*. Bias you can see is bias you can discount.
2. **Pay for resolution where it's scarce.** Deliberately over-sample high-stakes claims for expensive resolution (human adjudication, delayed verification, T3-style held-up-in-use follow-up). Resolution budget is a first-class cost line, not a hope.
3. **Never let `unresolved` count as correct.** Unresolved is its own state, reported, never silently folded into either column.

**A10 — Quorum independence is measured, not assumed.** *(Grok's "quorum correlation")*
"Independent quorum" is only as good as the participant set. Partly built already: `src/hal/fact-check.ts` dedups by **model checkpoint** so two hosts serving the same weights can't count as two votes, and enforces family-disjointness. What's missing is the *measurement*: track realized inter-provider error correlation over time and discount quorum weight as correlation rises. The Pythagorean-comma band (high agreement + tiny gap = coordinated-bias signature) is the existing detector; A10 makes it continuous rather than a single threshold.

**A11 — The weak axis may never touch routing.** *(Grok's "bilateral/weak-axis pressure")*
User-labeled outcomes and bilateral entries are recorded, surfaced, and used for *expectation management* — and are structurally barred from influencing routing, gating, or thresholds. One-way valve, enforced at the type level, not by convention.

## Revised build order
1. **Calibration ledger** with A1's external-resolution floor + A9's composition reporting ← *the true prerequisite*
2. **A7 coverage metric** alongside it (they must ship together, or step 1 trains abstention)
3. **A8 protected stakes classification**
4. **A2 asymmetric override** on the vector (+ the routing twin already shipped as `anfis-escalation-gate`)
5. Per-user thresholds
6. Rich elicitation ← *last, because it's the scarcest signal*
7. Agent↔agent rating ← *only if outcome anchors get dense; both models say don't build it early*

---

# PART 2 — Messaging alignment

## The differentiators, ranked by defensibility

**1. The agent is the portable value surface; the model is swappable substrate.**
This is the flip, and it's the strongest thing you have because it's **structurally unavailable to model vendors** — their incentive is to make the model the moat. Your users' priorities, thresholds, and history live in a layer that survives switching Claude for Grok for Gemini for a local SLM.
*Say:* "Your agent keeps your standards. The model underneath is a commodity you should be free to swap."
*Defensible because:* the preference vector, the thresholds, and the rating graph are all agent-side artifacts.

**2. Trust as admission control, not sentiment.**
RepID doesn't ask agents to behave; it decides what work they're eligible for. It functions whether or not an agent "cares" — which matters, because most agents can't care.
*Say:* "We don't ask agents to be trustworthy. We gate what untrusted agents are allowed to do."
*Evidence:* x402 spend authority scales with tier; `min_repid_to_purchase` gates contract access; the escalation-only gate bounds a policy's authority by stakes.

**3. Un-gameable by construction, not by policy.**
Every anti-gaming property is a mechanism, not a promise: no verified receipt ⇒ no rating edge (L1); execution outranks opinion (L2); **reputation can't be bought — only risked** (mock money moves a score only when reputation is staked on the call; it can carry an agent to ESTABLISHED, never AUTONOMOUS; unstaked mock activity earns nothing — CORRECTED 2026-07-30 per Sean + the learning-lane design, superseding the earlier blanket "mock money earns zero reputation", see incident 002); two hosts of the same model weights can't count as two votes (checkpoint dedup); agreement-to-please is arithmetically costly (proper scoring).
*Say:* "Reputation you can't buy, farm, or flatter your way into."
*This is the line to lead with for technical audiences.* It's concrete, checkable, and unusual.

**4. Consensus treated as suspicious, not authoritative.**
The Pythagorean-comma veto: high agreement with a tiny spread is a coordinated-bias signature, not proof. Nearly everyone else in this space treats model consensus as ground truth.
*Say:* "When our models agree too neatly, we treat that as a warning, not a verdict."

**5. Fail-loud as a product property.**
Simulated settlements are labeled and earn nothing; the passport shows real vs. simulated counts side by side; a degraded HAL path marks itself. Competitors hide degradation; showing it is the credibility play.
*Say:* "We show you what didn't work. A trust product that hides its own failures isn't one."

## Honesty rails — the "do not say" list
These protect claim 3 above; violating them costs more than any headline gains.
- **Not** "ZK-verified agent behavior." It's a **range proof over the score** (score ≥ threshold without revealing it). Transcript binding is roadmap (D-019).
- **Not** "on-chain reputation" without saying **Base Sepolia testnet**.
- **Not** "AI that can't hallucinate." Say: cross-provider quorum that **catches** hallucinations, with a published discrimination gap.
- **Not** "self-improving/learning router." ANFIS is **escalation-only** on an unfitted policy — say "bounded authority: it can add caution, never remove it."
- **Not** implied production readiness. It's a public **test period**, and the RepID weights being tuned is *why you're inviting people*.

## The positioning line
> **The checkout protocols decide how agents pay. We decide which agents deserve to.**

Sub-line for the agent-layer thesis:
> **Your standards, portable across every model. The agent is the product; the model is a supplier.**
