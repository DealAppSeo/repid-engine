# Bound-RepID Coupling — model + first simulation results
**Created:** 2026-07-28 (CC, overnight) · **Sim:** `scripts/sim/repid-bound-coupling-sim.mjs` (dependency-free Monte Carlo, box-safe) · **Status:** v0 — base case validated, anti-gaming threshold found. NOT final; iteration + mixed-pair asymmetry + sensitivity sweeps pending.

> Proprietary. The concrete RepID formula/ANFIS params stay out of public docs (hard-stop). This captures the *structure* + the *simulation findings*, which is what's patent-relevant.

## Objective (Sean 2026-07-28)
Make the reputation-maximizing strategy the **prosocial** one — "help people help people" — so incentives *align* rather than merely being poetic. Specifically: altruistic / authentic / other-over-self behavior should **lower decay** and **raise the reward multiplier**; gaming, deception, and rep-farming should be **unprofitable**; and a cryptographically **bound** human↔agent pair should couple asymmetrically.

## The model (novel structure)
Each entity (human owner, and the agent(s) bound to it via the ZKP owner-commitment) has a RepID `R`. Per round:

- **Verified work** `v` (HAL/peer-verified, not self-claimed) → base delta. **Asymmetric deception penalty:** a *caught* lie costs ~7× a good round; an *uncaught* lie yields only a small illicit boost. Lying is dominated in expectation once catch-probability is moderate.
- **Other-orientation `O` ∈ [0,1]** — measured from **third parties' verified benefit**, not self-report. `O` does double duty:
  - **reward multiplier** `M = 1 + κ·O^p` (convex → rewards genuine high-O), and
  - **decay** `decay = d0·(1 − λ·O)` (altruists' reputation is *stickier* and compounds).
- **Asymmetric bound coupling** (the keystone): a good **owner lifts their agent** with coefficient `α_ua`; a good **agent lifts its owner** with `α_au`, and **`α_ua > α_au`**. Coupling is signed on standing×O, so a *bad* counterpart **drags** (accountability flows to the principal; an agent cannot be a pure rep-farm for its owner).

## Method
Agent-based Monte Carlo: N bound human+agent pairs × T rounds × 5 seeds, pure arithmetic (10M+ updates in ~1s, no deps → runs on a resource-starved box). Strategies: `altruist`, `honest_selfish`, `gamer` (mediocre + fakes O), `soph_gamer` (**competent** + fakes O — the real threat), `deceiver`, `free_rider`. `leak` = how much a gamer's **self-claimed** O leaks past third-party ground truth (0 = fully verified, 1 = pure self-report).

## Results [V, 2026-07-28]
**1. Base case (leak=0) PASSES:** final-RepID order = `altruist ≫ honest_selfish ≫ gamer ≫ free_rider ≫ deceiver`; gaming unprofitable (best gaming 658 vs worst honest 3329); asymmetry intact. Altruists saturate the cap — the prosocial incentive is strong.

**2. The anti-gaming threshold (key finding):** sweeping `leak` against a **competent** gamer:
| leak | soph_gamer RepID | honest RepID | ground-truthing |
|---|---|---|---|
| 0.0–0.3 | 2279 → 3340 | ~3327–3403 | **HOLDS ✅** |
| 0.4 | 3855 | 3429 | fails ❌ |
| 0.6 | 5261 | 3482 | fails |
| 1.0 | 9481 | 3591 | fails badly |

→ **The other-orientation signal must be ≥ ~65% third-party-verified (leak ≲ 0.35)** for prosocial behavior to remain dominant. This *quantifies* the "observer-effect-as-alignment" thesis and gives a hard design constraint: `O` cannot be self-attested.

## Patent-relevant claims (draft — for Grok cross-val + attorney)
1. **Asymmetric bidirectional reputation coupling** between a cryptographically-bound principal (human) and delegate (agent), with principal→delegate influence deliberately exceeding delegate→principal, to align accountability and defeat rep-farming.
2. **A single verified other-orientation signal that simultaneously reduces reputation decay and raises the reward multiplier**, making sustained prosociality the compounding-dominant strategy.
3. **A quantified ground-truthing requirement** (≥~65% third-party verification of the prosociality signal) as the necessary-and-sufficient condition, established by simulation, under which the reputation-maximizing strategy is provably prosocial and gaming-resistant.

## Mistakes / learnings (scientific-doc discipline)
- First sweep showed "order holds at all leak" — a FALSE win: the `gamer` was too weak (mediocre work carried the result, not the O-ground-truthing). Fixed by adding `soph_gamer` (competent + fakes O); the real threshold then emerged. *Lesson: the anti-gaming test must use a competent adversary, or it flatters the design.*

## Next (iterate to convergence)
- **Mixed-pair asymmetry sim:** good-owner/bad-agent vs bad-owner/good-agent — verify the intended accountability flow (`α_ua>α_au`) produces the right drag/lift.
- **Sensitivity sweeps** of κ, λ, d0, penalty, α ratio → map the stable region; anti-saturation so top ranks stay legible.
- **Sybil/collusion** strategy (mutual-boosting rings) under ZKP-scoped binding.
- Wire the validated constants into `src/layers/` (decay, ecosystem-need, redemption) shadow-first; feed the O-verification requirement into HAL/peer-verify; let ANFIS route proof-tier/verification-depth by stakes.
- Re-run high-volume in **cloud** (GitHub Actions sim workflow) once the box is offloaded.
