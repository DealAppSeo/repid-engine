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

## Results [V, 2026-07-28 — re-derived from the committed script by an independent beat; see "Reproduction"]
**1. Base case (leak=0) PASSES:** final-RepID order = `altruist(10000) ≫ honest_selfish(3330) ≫ soph_gamer(2286) ≫ gamer(651) ≫ free_rider(478) ≫ deceiver(205)`; gaming unprofitable (best gaming 2286 vs worst honest 3330); asymmetry intact. Altruists saturate the cap — the prosocial incentive is strong.

**2. The anti-gaming threshold (key finding):** sweeping `leak` against a **competent** gamer (`soph_gamer`). Every row is the `SWEEP` line printed by `node scripts/sim/repid-bound-coupling-sim.mjs --leak=<L>` at the committed defaults (N=10000, T=600, 5 seeds):

| leak | soph_gamer | honest_selfish | margin | ground-truthing |
|---|---|---|---|---|
| 0.00 | 2286 | 3330 | +1044 | **HOLDS ✅** |
| 0.10 | 2575 | 3355 | +780 | HOLDS ✅ |
| 0.20 | 2928 | 3380 | +452 | HOLDS ✅ |
| 0.30 | 3356 | 3406 | +50 | HOLDS ✅ (thin) |
| **0.31** | **3404** | **3408** | **+4** | **HOLDS — crossover** |
| **0.32** | **3452** | **3411** | **−41** | **fails ❌ — first failing leak** |
| 0.35 | 3604 | 3419 | −185 | fails ❌ |
| 0.40 | 3879 | 3432 | −447 | fails ❌ |
| 0.60 | 5326 | 3485 | −1841 | fails |
| 1.00 | 9514 | 3595 | −5919 | fails badly |

→ **The other-orientation signal must be ≥ ~69% third-party-verified (leak ≤ 0.31) for prosocial behavior to remain dominant — and the crossover is razor-thin there (+4 RepID on ~3400, i.e. 0.1%).** The *design* target should therefore carry headroom: **leak ≤ 0.25 (≥75% verified)** keeps the honest margin above ~350 points. Either way the constraint stands and sharpens: `O` cannot be self-attested.

### Reproduction — and a correction to this document's first version [V]
The table above **replaces** one whose figures could not be reproduced from the committed script (drift of 0.4–1.4% on every row: leak=0.4 recorded 3855, actual 3879; leak=0.6 recorded 5261, actual 5326). The RNG is seeded and deterministic, so the only explanation is that the recorded numbers came from a script state edited before commit — the artifact did not recompute its own claims. Every row is now re-run from the committed file with the producing command printed.

**One claim was materially wrong, not merely imprecise:** the original "leak ≲ 0.35 / ≥65% verified" is **REFUTED** — at leak=0.35 the competent gamer *wins* (3604 vs 3419). That value was never sampled; the sweep jumped 0.30 → 0.40, saw pass-then-fail, and interpolated a boundary. The true boundary is 0.31/0.32. Patent-relevant claim 3 is corrected below; **do not cite the 65% figure.**

## Patent-relevant claims (draft — for Grok cross-val + attorney)
1. **Asymmetric bidirectional reputation coupling** between a cryptographically-bound principal (human) and delegate (agent), with principal→delegate influence deliberately exceeding delegate→principal, to align accountability and defeat rep-farming.
2. **A single verified other-orientation signal that simultaneously reduces reputation decay and raises the reward multiplier**, making sustained prosociality the compounding-dominant strategy.
3. **A quantified ground-truthing requirement** — **≥~69% third-party verification (leak ≤ 0.31)** of the prosociality signal as the condition, established by simulation, under which the reputation-maximizing strategy is the prosocial one and a *competent* gamer cannot out-earn an honest agent. (Corrected from ≥65%, which the re-run refutes. "Necessary-and-sufficient" also over-claims what a Monte Carlo at one knob-set shows: it is the measured boundary for these parameters, and the sensitivity sweep in "Next" is what would establish how the boundary moves.)

## Mistakes / learnings (scientific-doc discipline)
- First sweep showed "order holds at all leak" — a FALSE win: the `gamer` was too weak (mediocre work carried the result, not the O-ground-truthing). Fixed by adding `soph_gamer` (competent + fakes O); the real threshold then emerged. *Lesson: the anti-gaming test must use a competent adversary, or it flatters the design.*
- **The threshold was then stated from a sweep that skipped the interval containing it.** 0.30 passed, 0.40 failed, and the safe bound was reported as "≲0.35" — a value never run, and one that in fact FAILS. A boundary read off the endpoints of an un-sampled interval is an interpolation presented as a measurement. Fixed by sampling 0.31/0.32/0.35 and quoting the crossover. *Lesson: when the deliverable IS a threshold, the sweep must bracket it at the resolution being claimed.*
- **The published numbers did not recompute from the published script.** Deterministic seeds plus a drifting table can only mean the artifact was edited after its results were recorded (Beat 46's class, re-learned). *Lesson: re-run every figure from the committed file before the report is committed, and print the command that produces it.*
- **Process, not modelling: this correction had to be made against `main` instead of before the merge.** A second `hyperdag-build-loop` cron instance sharing this working tree opened its own PR (#251) from the same commit and it landed while the re-run was in flight, so the refuted 65% figure reached `main` and needed a follow-up (#252) to remove. Two instances, one checkout — the hazard flagged in Beats 48/49/50, now with a concrete cost.

## Next (iterate to convergence)
- **Mixed-pair asymmetry sim:** good-owner/bad-agent vs bad-owner/good-agent — verify the intended accountability flow (`α_ua>α_au`) produces the right drag/lift.
- **Sensitivity sweeps** of κ, λ, d0, penalty, α ratio → map the stable region; anti-saturation so top ranks stay legible.
- **Sybil/collusion** strategy (mutual-boosting rings) under ZKP-scoped binding.
- Wire the validated constants into `src/layers/` (decay, ecosystem-need, redemption) shadow-first; feed the O-verification requirement into HAL/peer-verify; let ANFIS route proof-tier/verification-depth by stakes.
- Re-run high-volume in **cloud** (GitHub Actions sim workflow) once the box is offloaded.
