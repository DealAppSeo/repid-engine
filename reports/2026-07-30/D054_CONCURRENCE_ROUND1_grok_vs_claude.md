# D-054 concurrence record — round 1 (cold), user-weighted trust policy
**Date:** 2026-07-30 · **Protocol:** pre-registration (Claude's positions sealed in `GROK_COLD_BRIEF_user_weighted_trust.md` §5, committed `5db7e60` before Grok saw anything) · **Round 1 = Grok answering cold, §5 withheld**

**Purpose:** the first entry in the D-054 outcome ledger. Concurrence is recorded *with an outcome slot* so agreement earns its weight later instead of being self-certifying. A concurrence that proves wrong is the most valuable row this table can hold.

## Verdict table

| Q | Topic | Claude (pre-reg) | Grok (cold) | Verdict | Outcome slot |
|---|---|---|---|---|---|
| 1 | Locus of the preference vector | agent-side, 0.90 | agent-side, 0.80 | **AGREE** | open |
| 2 | Do proper scoring rules resist sycophancy | only proper rules resist, 0.85 | relocates, doesn't kill, 0.72 | **CLAUDE MOVES** → 0.65 w/ amendment A1 | open |
| 3 | Are MRS elicitable | rates are the right unit, 0.80 | weakly elicitable; reversals, 0.70 | **PARTIAL — unresolved by argument** (empirical) | open |
| 4 | Build agent↔agent rating now | lower value, 0.60 (self-flagged weakest) | no; trains the wrong prior, 0.85 | **AGREE, Claude updates UP** → 0.80 | open |
| 5 | What breaks first at 10k | (implicit: thresholds are the near-term win, 0.70) | elicitation breaks first, 0.74 | **CLAUDE MOVES** → #5 down to 0.45 | open |
| 6 | Discipline to borrow | insurance deductibles (gesture) | actuarial: credibility theory, bonus-malus, premium/loading split | **GROK STRONGER — adopt** | open |
| 7 | Unnamed failure mode | — | vector becomes the Goodhart target + single point of failure; low-stakes→high-stakes transfer attack | **GROK FOUND IT — spec change required** | open |

## Where Claude moved, and the mechanism that forced it

**Q2 — the concrete scenario I had not accounted for.** Grok: proper scoring, when outcomes are *sparse or user-mediated*, rewards **calibrated abstention on hard claims plus high confidence on easy/consensus ones**. That is a stable, high-scoring strategy that is also useless — and it is sycophancy wearing calibration as a costume. My position assumed outcomes arrive externally and densely; most conversational claims never resolve, and where the *user* supplies the outcome label, selective engagement (b) and bilateral pressure (c) reinstate the agreement attractor.
→ Confidence 0.85 → **0.65**, plus amendment **A1** below. Note the fix is a *restriction on what may be scored*, not an abandonment of proper scoring — see push-back 1.

**Q5 — undercuts my own #5.** If reliable preference signal is the scarce resource, then per-user thresholds have nothing to tune from; they degrade to global constants with extra steps. Grok's Q3 and Q5 answers compose into an argument against my "thresholds are the near-term win."
→ #5 0.70 → **0.45**, and the build order reverses: **calibration ledger before elicitation**.

**Q7 — the attack I did not name.** My risk section had Goodhart on the *score*; Grok has Goodhart on the *vector*. Concrete: a user — or a prompt-injected adversary — elicits a permissive vector through frequent low-stakes trivia; sparse/lagged outcomes never correct it; the now-authoritative vector is then applied to an **irreversible** claim where global thresholds would have forced a high `ACT_BAR`. The agent faithfully executes an attacker's risk appetite. This is the advisory-failure pattern from incident 001 raised one level: an authoritative-but-wrong artifact is more dangerous than an ignored-but-right rule.
→ Requires amendments **A2, A3, A5**. This is the single most valuable output of round 1.

## Where Claude holds, and where Grok is inconsistent

**Push-back 1 — Q2 is overstated as "relocates."** Every mechanism Grok names (selective labeling, outcome withholding, bilateral pressure) shares one root: **user-mediated resolution**. Restrict scoring to claims resolved at or above a verification-strength floor — execution, chain state, test result, independent quorum — and all three attacks lose their channel. The remaining scored set is thin, but thin-and-honest is the point. The gain isn't relocated; it's *narrowed*. Proper scoring stays necessary, just no longer sufficient on its own.

**Push-back 2 — Q5 contradicts Q2.** Grok calls the calibration ledger "just storage plus scoring arithmetic." But his own Q2 argument is that **outcomes are sparse and user-mediated** — which makes *resolution*, not storage, the ledger's hard part. He cannot have outcomes be the scarce, corruptible input in Q2 and the trivial part in Q5. My read: elicitation and resolution are *both* scarce, and they fail for the same underlying reason — consequential ground truth is expensive. That strengthens rather than weakens his overall thesis, but it means "the ledger is easy" is wrong.

**Push-back 3 — Q3 conflates two claims.** Mine was about the *storage unit* (rates, not absolute budgets); his is about *elicitability*. Both hold simultaneously: rates remain the correct unit precisely because they're wealth-portable, even if they're hard to measure. His prospect-theory/preference-reversal point lands against the *elicitation method*, not the representation. His insurance disanalogy is sharp and correct though — insurance works because risks are repeated, standardized, and actuarially scored, while agent queries are one-shot and constructed.

## Contamination flag (per the update rule: say why we agree)

**Q4's agreement is partly contaminated.** My brief explicitly cited the Pythagorean Comma veto (P-003) in §2, and Grok's Q4 invokes it. His conclusion may still be independently reached, but his *citing that specific argument* is not independent evidence — I handed it to him. Weight the Q4 concurrence accordingly. Q1 and Q7 look like genuine independent convergence/contribution; Q7 especially, since it contradicts material I supplied.

**Shared-bias caution:** both models are reasoning from "control must live outside the model," a frame present in the brief. It is probably correct, and it is also the frame most likely to survive both of us being wrong the same way. It belongs on the ledger as a claim with an outcome slot, not as a settled premise.

## Amendments to `USER_WEIGHTED_TRUST_POLICY_SPEC_v0.md` (→ v0.1)

- **A1 — External-resolution floor.** A claim enters the calibration ledger only if its outcome is resolved at or above a verification-strength floor (execution / chain / test / independent quorum). User-labeled outcomes go to a **separate, weaker axis** and never feed routing. Kills Q2's three attack channels at the root. Reuses the L2 hierarchy already in `participant-rating.ts`.
- **A2 — Asymmetric override authority.** The preference vector may move thresholds only in the **conservative** direction at `high` and `irreversible` stakes. Global `ACT_BAR` / `MIN_CONFIDENCE_TO_ACT` become **floors user preference cannot pierce**. Users may make themselves more cautious, never less, where actions are irreversible. Directly defeats Q7's transfer attack.
- **A3 — Domain-conditioned evidence.** Preferences learned in one domain do not transfer to another. Trivia choices never license medical/financial/legal thresholds; those domains require their own evidence or stay at defaults. (Q3 + Q7.)
- **A4 — Actuarial machinery, replacing hand-rolled blending.** **Credibility theory** for how much individual history overrides the class prior (this *is* the cold-start solution, rigorously); **bonus-malus** for outcome-driven rate updating (the "wire in a consequence" mechanism, formalized); **risk premium vs. loading** separation so verification cost, latency, and cost-of-capital are distinct terms rather than one blended number. Add clinical shared decision-making for re-elicitation cadence and drift, which stationary-MRS economics assumes away.
- **A5 — Vector update provenance + rate limiting.** The vector is a slow-moving, auditable artifact: every update carries provenance, single conversations cannot swing it, and high-stakes-relevant changes require repeated consistent evidence. Treats the vector as an attack surface (prompt injection), which v0 did not.
- **A6 — Build order reversed.** Calibration ledger (with A1's floor) **before** elicitation. Elicitation is the scarce resource; the ledger is the anchor everything else needs. Per-user thresholds ship third, not first.

## Next
1. Reveal §5 to Grok → round 2: attack the pre-registered positions, starting with the three self-flagged weak links.
2. Ask round 2 to adjudicate push-backs 1 and 2 specifically (is the external-resolution floor sufficient; is resolution or storage the ledger's hard part).
3. Fold A1–A6 into spec v0.1 once round 2 lands.
4. Revisit this table's outcome column once anything ships — that is what makes D-054 a calibration system rather than a vote.
