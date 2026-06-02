# S-HARMONIA-1 Self-Improvement Protocol

**Project:** Harmonia  
**Date:** 2026-06-01  
**Core Rule:** No change is ever made to production systems (router, HAL, consensus, etc.) until a chord has been **confirmed with 3 independent reproductions** and passed the appropriate governance gate.

## The Feedback Loop (High Level)

```
Confirmed Chord (3× reproduction)
        │
        ▼
Classify improvement type
        │
   ┌────┼────┬────────────┬──────────────┐
   ▼    ▼    ▼            ▼              ▼
ROUTING HAL  CONSENSUS  EMERGENT     NO CLEAR
        │    │          │            │
        ▼    ▼          ▼            ▼
   Feature-flag  BFT meta-  Patent   Archive as
   A/B test      governance review   "interesting
        │    │          │            but inert"
        ▼    ▼          ▼
   If A/B wins: apply
        │
        ▼
   New data → ANFIS learns which chords to propose next
```

## Detailed Paths

### 1. Routing Improvement (most common expected path)

**Trigger:** A chord produces statistically better task routing decisions (higher final HAL score, lower cost, better load distribution, fewer escalations) than baselines and random control, reproduced 3×.

**Steps:**
1. Extract the successful combination logic into a small, versioned module (e.g. `chord_meta_router_v1.py` or a new ANFIS rule set).
2. CC (or implementer) places the logic behind a feature flag: `HARMONIA_ROUTING_CHORD_<chord_name>`.
3. Run controlled A/B:
   - 100 tasks routed with current production router (control)
   - 100 tasks routed with chord-enhanced router (treatment)
   - Same distribution of task domains, same time window.
4. Success criteria (pre-defined):
   - Mean HAL score of treatment ≥ control + δ (δ proposed per domain, initially 0.03–0.05)
   - No increase in p95 latency or error rate > 5%
   - Cost per successful task does not increase
5. If A/B passes → flip flag to 100% (or gradual rollout).
6. Update the ANFIS router weights or rule base with the new chord-derived features.
7. Every applied improvement immediately generates new labeled routing data that feeds the **next** Harmonia experiment selection (meta-learning).

### 2. HAL Scoring Improvement

**Trigger:** A chord produces a better 5-signal HAL evaluation (higher accuracy on hallucination detection, better veto_class, stronger Pythagorean Comma BFT consensus, etc.) than the current production HAL pipeline.

**Process:** Identical to routing, except:
- The A/B is performed on the HAL scoring service itself (shadow mode first).
- The "ground truth" for the A/B can be human-labeled corpus + the existing HAL measurement harness (from prior sprints).
- Success also requires that the new chord-enhanced scorer does not increase false-positive veto rate on known-good content.

### 3. Consensus / BFT Improvement (highest governance bar)

**Trigger:** A chord improves BFT-style consensus outcomes (faster finality, higher agreement rate, better resistance to certain attack patterns, or more stable reputation-weighted voting).

**Special meta-governance rule:**
- Because this is changing *how the system decides*, adoption requires an explicit BFT vote among the current set of high-RepID agents + SHOFET.
- The proposal must include:
  - The exact chord and reproduction data
  - A formal diff to the consensus rules or weights
  - A simulation or historical replay showing the delta on past disputes
- Only after a supermajority (or defined quorum) of the BFT participants + human review approves does the change go live.
- This is the "system votes on whether to change how it votes" safeguard.

### 4. Emergent Capability Path (highest strategic value)

**Trigger:** During chord execution, an unexpected new behavior appears that is not a simple improvement in the target metric (e.g. the combination spontaneously invents a new intermediate representation, discovers a shortcut that generalizes to other domains, exhibits a novel form of self-correction, etc.).

**Process:**
1. Researcher (or Grok-assisted) writes a thorough "Emergent Finding Report" with:
   - Concrete examples
   - Reproduction steps
   - Why it is surprising given the three input algorithms
   - Potential applications
2. The finding is queued for **patent review** (potential P-030 and follow-on filings).
3. Sean (or designated strategist) makes the go/no-go decision on whether to invest further engineering time or file.
4. If pursued, the emergent capability is treated as a first-class research asset and may spawn its own dedicated sub-project (outside the daily 5-experiment cap).

## The Meta-Learning Loop (ANFIS + Harmonia)

- Every time a chord is applied to production (or rejected), the outcome (including A/B results, HAL scores, cost deltas) becomes new training data.
- This data is used to improve the **chord proposal model** itself:
  - Which positions on the Circle tend to work well together for routing tasks?
  - Which dissonant chords are surprisingly fertile?
  - Which task domains benefit most from major vs minor triads?
- Over time the system should become better at *choosing which chords to test*, reducing wasted quota on low-value experiments.
- This is the true "harmonia" — the research apparatus improves the production systems, which improves the research apparatus.

## Governance & Safety Rails

- **3× reproduction** is absolute. No exception for "very promising" single runs.
- **Feature flags everywhere.** No direct edits to production router/HAL/consensus code.
- **Rollback is trivial.** Any chord-derived change must be behind a flag that can be turned off in <5 minutes.
- **Audit trail.** Every adoption decision (or rejection) is logged back into `harmonia_experiments` with a `production_adopted_at` timestamp and reference to the A/B or BFT vote.
- **Falsification respected.** If the overall Circle framework is falsified for a domain, that fact is recorded and no further routing/HAL changes from Harmonia chords are proposed for that domain until a revised theory is developed.

## Metrics of Success (for the research program itself)

- Number of chords that reach 3× confirmation
- Number of chords that pass A/B and are adopted
- Delta in production metrics (routing quality, HAL F1, consensus latency) attributable to Harmonia-derived changes
- Reduction in "wasted" experiments over time (evidence that the meta-learner is working)
- At least one emergent capability that reaches patent or strategic decision stage

---

**End of S-HARMONIA-1_self_improve_spec.md**

This protocol ensures that Project Harmonia can only improve the live system through rigorous, reproducible, governed channels — exactly the same discipline that protects the RepID economy and HAL integrity in production.