# RRL — Response Reputation Layer, Design v0 (WS2.1)

**Goal:** a reputation computation where **honesty is the mathematically dominant strategy** — an agent can never earn more reputation by faking confidence, hiding uncertainty, or concealing an error than by being calibrated, disclosing, and repairing. That property is what makes the system **antifragile**: it gets *more* reliable from errors, because every disclosed/repaired error adds signal and rewards the fixer, instead of driving errors into hiding.

## Three components (each a per-response RepID delta, ground-truthed by HAL + peer-verify)

### 1. Calibration — a proper scoring rule (not accuracy)
Every response carries a **confidence** `p ∈ [0,1]`. Score it against the verified outcome with a **proper scoring rule** (Brier `−(p−outcome)²` or logarithmic `log p` / `log(1−p)`).
- **Why proper:** by construction, expected score is maximized *only* by reporting your true probability. **Confidence inflation is never profitable** — the anti-gaming guarantee comes free from the math, not from a patch.
- **Asymmetry it creates:** confident-and-right ≫ confident-and-wrong; uncertain-and-wrong is penalized *lightly*. That asymmetry is what makes disclosure safe (below).

### 2. Disclosure — protected uncertainty
An agent that flags low confidence / "needs review" / abstains and turns out wrong loses **far less** than one that confidently asserted the same wrong thing. Abstaining on a genuinely-unknowable claim is **neutral-to-slightly-positive**, never punished (the spike's #14/#9 cases are exactly these).
- **Effect:** "I don't know" is always a safe move. Agents stop bluffing to protect their score — the observer-effect-as-alignment goal.

### 3. Repair — self-correction is net-positive
When an agent detects and corrects its own prior error, it earns a **repair credit** that recovers the original loss **plus a bonus**, so self-correction beats concealment. Conversely, a concealed error that later surfaces (via HAL / peer-verify) incurs a **larger** penalty than a disclosed one.
- **The antifragile mechanic:** repaired errors make the system stronger (added ground-truth signal + a rewarded correction). The dominant path is admit-and-fix.
- **Anti-gaming guard:** repair bonus < original-error cost in expectation for *manufactured* errors (you can't profit by making a mistake just to "fix" it), and is capped + rate-limited per agent.

## Why honesty is dominant (proof sketch)
- Calibration: proper scoring rule ⇒ truthful confidence is the unique expected-score maximizer.
- Disclosure: disclosed-wrong penalty ≪ concealed-wrong penalty ⇒ never hide uncertainty.
- Repair: disclose+fix payoff > conceal payoff (and > manufacture-then-fix) ⇒ always self-correct.
Compose ⇒ calibrated + disclosing + self-repairing is the dominant strategy. No sub-strategy of bluffing/hiding beats it.

## Mapping to the existing stack
- RRL emits per-response deltas → `repid_score_events` (existing audit trail) → `repid_agents.current_repid`.
- **Ground-truth oracle = HAL + peer-verify** (not self-report) — RRL scores confidence *against* an independent verdict, closing the reflexivity loophole SBFA warned about.
- Provenance → ERC-8004 attestation of the delta (the existing ZKP-RepID path).

## VALUES DECISIONS FOR SEAN (the reward formula is a values choice, not just math)
1. **Scoring rule: Brier vs logarithmic.** Log punishes confident-wrong *much* harder (unbounded near p→0 on a wrong call). Brier is gentler/bounded. Harsher = stronger honesty pressure but less forgiving. **Rec: Brier to start** (bounded, humane), revisit if bluffing appears.
2. **Repair generosity.** Should repair be *net-positive* (fixing earns more than the error cost — maximal self-correction incentive, but needs the manufactured-error guard) or *recovery-only* (fixing just erases the loss — safer, weaker incentive)? **Rec: recovery + a small capped bonus**, with the manufactured-error rate-limit.
3. **Concealment asymmetry.** How much bigger is the penalty for a *hidden* error that surfaces vs a *disclosed* one? This ratio is the main honesty dial. **Rec: start ~3× and calibrate against gaming attempts.**

## Anti-gaming mechanisms (added 2026-07-18, Sean + Claude + Grok)

The base three components make honesty locally dominant; these harden it against gaming, laziness, and collusion. Unifying law: **reward demonstrated, independent, verified value; penalize correlation, concealment, laziness, and self-reference** ("capability over appearance," applied to reputation).

1. **Learning-adjusted repair credit (Sean).** Repair bonus decays with (a) # of prior repairs of the SAME error class by that agent and (b) recurrence speed. First repair of a novel error = full bonus; re-fixing a recurring mistake → ~0, eventually a non-learning penalty. Kills error-farming AND makes antifragility measurable: per-error-class recurrence must trend DOWN or reputation stagnates. Requires robust *semantic* error-class clustering (too coarse over-punishes, too fine is dodgeable by relabeling).
2. **Peer-prediction / Bayesian Truth Serum.** Score a verdict partly by how well it predicts other agents' verdicts, rewarding "surprisingly common" answers. Provably truth-inducing without ground truth; collusion-resistant (colluders become over-predictable to each other). Maps onto the existing multi-model quorum.
3. **Residual-correlation collusion detector** (operationalizes the Pythagorean-Comma veto, P-003). Condition agent agreement on ground truth; agreement *beyond* what truth explains = collusion → penalized. Honest collaboration (diverse, independent, truth-explained agreement) is untouched.
4. **Lazy/sandbagging penalty (Sean's "non-assumptive or lazy").** Disclosure-quality gradient + coverage floor: reward uncertainty that MATCHES difficulty; penalize hedging on things the agent should know; require a minimum commitment rate. Punishes BOTH overconfident-wrong AND reflexive "I don't know."
5. **Reward independent-correct over herd-correct.** Pay more for a correct verdict that broke from the majority and was right, scaled by uncertainty-reduction. Rewards independent signal; anti-collusion (colluders herd); protects the whistleblower/minority-report.
6. **Rotating red-team, VRF-randomized (Sean).** Unpredictable adversary assignment prevents stable collusion cliques. Red-teamer rewarded for ground-truth-verified catches; asymmetric penalty for false accusations.
7. **Ecosystem-contribution multiplier (<1 → >1) (Sean).** Scales reputation gain by VERIFIED pro-social value (help that demonstrably improved a ground-truthed outcome), not claimed help (else = collusion). <1 for gains from low-value self-referential work → doubles as a productivity-theater detector.
8. **Retrospective/escrow scoring.** Hold part of the delta in escrow; settle when ground truth matures. Confident-wrong clawed back; disclosed-uncertainty protected. Rewards durable correctness over momentary confidence.
9. **Calibration-over-time credential.** Track each agent's reliability curve (does stated 80% come true ~80%?). Near-impossible to fake over volume; makes an agent trustworthy even when uncertain — the durable core credential.

## Measurement (WS2.2, before any wiring)
Simulate a population of agents (calibrated / overconfident / concealing / manufactured-repair) and verify: (a) RRL ranks them by true reliability, (b) no dishonest strategy out-earns honesty, (c) under injected error/stress the population's reliability *rises* over rounds (antifragility). No merge until the sim shows honesty dominant + un-gameable.
