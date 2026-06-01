# S-HARMONIA-1 Experiment Harness Specification

**Project:** Harmonia (Circle of Fifths algorithm synergy research)  
**Status:** Design-only (2026-06-01)  
**Rule:** Runs exclusively on free daily quotas or local Ollama. Max 5 experiments/day. Never competes with production.

## Overview

The harness executes one complete, controlled experiment that tests whether a musically-structured "chord" (three algorithm positions on the Circle of Fifths) produces synergistic improvement over:
1. The three algorithms run individually (baselines)
2. A random triple of algorithms (control)

Every experiment is fully logged, hash-chained, HAL-evaluated, and (eventually) testnet-anchored.

## Experiment Input

```json
{
  "chord_name": "D#_Major",
  "algorithms": ["rep_id_economy", "log_transform", "attention"],
  "task_domain": "meta_routing",
  "task_description": "Route a complex multi-step agent task to the optimal provider+model given current load, cost, and historical HAL performance.",
  "provider": "groq"   // must be a free-tier entry from harmonia_budget
}
```

## End-to-End Steps (Atomic Experiment)

1. **Hypothesis Generation**  
   Using the chord + domain + task_description, generate a natural-language hypothesis, e.g.:  
   > "Combining rep_id_economy (position 9), log_transform (position 1), and attention (position 4) on the Circle of Fifths will produce emergent routing logic that outperforms any of the three alone on meta_routing tasks."

2. **Hash the Hypothesis**  
   `hypothesis_hash = SHA-256(hypothesis_text)` (deterministic, stored before any model calls).

3. **Budget Gate (Critical)**  
   - Query `harmonia_budget` for the chosen provider/model.  
   - If `used_today + estimated_tokens > daily_quota_tokens` → queue experiment for later (or next reset), exit with status `QUEUED_NO_BUDGET`.  
   - Record the exact tokens that will be reserved.

4. **Run Baselines (3× individual)**  
   For each of the three algorithms in the chord, run the task using only that algorithm (or the core technique it represents).  
   Record for each: accuracy/quality score, latency_ms, tokens_used, compute_cost_usd (0 for free tiers), provider actually used.

5. **Run the Chord (combined)**  
   Execute the task using the three algorithms together (the "chord" composition).  
   The harness must define a concrete composition method for the chord (e.g., sequential pipeline, parallel ensemble + merge, or meta-prompt that references all three).  
   Record the same metrics + free-text `emergent_capability` (researcher or HAL-assisted observation of surprising new behavior).

6. **Run Random Control**  
   Select a random triple from the 12 positions (different from the chord).  
   Run the identical task with that control triple.  
   Record identical metrics.

7. **HAL Evaluation**  
   All three final outputs (baselines aggregated, chord result, control result) are sent to HAL (via a free provider) for 5-signal scoring.  
   Store `hal_score` and `hal_signals` for the chord result (primary).

8. **Scoring & Confirmation Decision**  
   ```
   baseline_mean = mean of the three baseline quality scores
   chord_score   = quality score of the chord run
   control_score = quality score of the random control run

   hypothesis_confirmed = (chord_score > baseline_mean) AND (chord_score > control_score)
   ```
   If `hal_score < 0.5` on the chord result → force `INCONCLUSIVE` regardless of numeric scores.

9. **Persist with Hash Chain**  
   - Read the `current_entry_hash` (or `previous_entry_hash`) of the most recent row in `harmonia_experiments`.  
   - Compute new row's `previous_entry_hash`.  
   - INSERT the full experiment row (mirrors S-AUD1 `append_hal_audit_chain` discipline).  
   - Update `reproduction_count` if this is a re-run of a previously confirmed hypothesis.

10. **Budget Update (same transaction)**  
    `UPDATE harmonia_budget SET used_today = used_today + tokens_used WHERE provider = ? AND model = ?;`

11. **Queue On-Chain Anchor**  
    Append the `experiment_id` + `hypothesis_hash` + final scores to a daily batch file.  
    A separate low-priority W3C agent job (testnet only) submits Merkle roots or individual attestations once per day.

12. **Return Structured Result**  
    The harness returns a complete JSON record suitable for both the DB row and human review.

## Scheduling Logic (Strict)

- **Budget check is at execution time**, not scheduling time (quotas are shared with the world).
- Experiments only run during:
  - Off-peak hours (recommended 02:00–06:00 PDT / 09:00–13:00 UTC)
  - Or when the production `trinity_tasks` pending queue length < 100
- Hard cap: **maximum 5 experiments per calendar day** (capital + quota preservation).
- Rotation per batch of 5:
  - 3 consonant chords (major or minor triads)
  - 1 dissonant chord
  - 1 random_control (explicitly chosen or truly random)
- Priority: experiments that have already shown `hypothesis_confirmed = true` but `reproduction_count < 3` get first slot in the daily budget.

## Quality Gates (Non-Negotiable)

- Every experiment **must** include fresh baselines + a fresh random control on the exact same task instance.
- If HAL returns `hal_score < 0.5` on the chord output → mark `hypothesis_confirmed = false`, `notes = "INCONCLUSIVE: low HAL confidence"`.
- **Reproduction rule**: A chord is only considered "confirmed" for feedback into production after it has `reproduction_count >= 3` with consistent positive delta.
- **BFT disagreement gate**: If two or more independent agents (or repeated runs) disagree on whether `hypothesis_confirmed` should be true for the same (chord + task) pair, escalate to SHOFET (human + highest-RepID agents) for final judgment. Record the SHOFET decision in the row.
- The Circle hypothesis is **falsifiable**: if after 30+ well-powered experiments the random_control group has equal or higher mean chord_score, the framework is considered falsified for that domain and archived with a "REJECTED" note.

## Implementation Notes (for later engineering)

- The harness should be a standalone script / small service that can be triggered by cron or a low-priority queue.
- All model calls must go through the existing free-tier client wrappers (never paid keys).
- `emergent_capability` field is intentionally free-text for now; later versions may add structured tags.
- The composition method for "running a chord" must be versioned and stored alongside the result (different composition strategies are themselves experimental variables).

## Failure & Retry Policy

- Quota exhausted mid-experiment → record partial results + `status = "PARTIAL_BUDGET_EXHAUSTED"`, do not count against daily 5.
- Model returns garbage or times out → mark row with `hal_score = 0`, `hypothesis_confirmed = false`, `emergent_capability = "EXECUTION_FAILURE"`.
- Any row with `hypothesis_confirmed IS NULL` after 24h is considered abandoned.

---

**End of S-HARMONIA-1_harness_spec.md**

This spec is intentionally self-contained so a future implementer (or Grok) can build the runner without ambiguity while respecting the "free bandwidth only" and "3× reproduction" invariants.