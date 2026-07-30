# User-Weighted Trust Policy — spec v0
**Date:** 2026-07-30 · **Author:** CC · **Status:** DRAFT for Sean + Grok review (nothing built) · **Mode discipline:** shadow-first, flag-gated

## 0. One-paragraph thesis
The agent — not the model — is the durable layer. A user's priorities (how much truth is worth, at what cost, at what speed, and *when* each dominates) live in a portable **preference vector** owned by the agent and applied identically whether the substrate is Claude, Grok, Gemini, or a local SLM. Today those trade-offs exist in our code as **global constants**; this spec makes them **per-user** and makes the ratings that tune them **un-gameable by agreement**.

## 1. What already exists (build ON these — do not rebuild)
| Piece | File | State |
|---|---|---|
| Stakes-scaled decision thresholds | `src/hal/sbfa-consensus.ts` — `ACT_BAR` {low .6 / medium .67 / high .8 / irreversible .9}, `IGNORANCE_CAP` {.5/.45/.35/.25}, `MIN_CONFIDENCE_TO_ACT` {.4/.5/.6/.7} | REAL, pure fn, **global constants** |
| Participant-rating edges + Five Laws (earned-rating gate, ground-truth anchor, rater-rep weight, anti-gaming, multi-axis fairness) | `src/engine/participant-rating.ts` | REAL, pure, enforced in `validateRatingEdge` |
| Rating ledger writer | `src/engine/participant-rating-ledger.ts` (`shadow \| live`) | REAL, shadow-gated |
| Model trust leaderboard | `/leaderboard/models`, llm-trust surfaces | LIVE |
| Fact-check quorum + comma-BFT veto | `src/hal/fact-check.ts` | LIVE (now gates score events, PR #277) |
| ANFIS policy fabric | — | **shadow-only + starved [R]** — treat as roadmap, not capability |

**The gap is narrow:** thresholds are global, ratings aren't calibration-scored, and no preference vector exists.

## 2. The preference vector (the portable artifact)

Stored per user, applied to every substrate. **Never store absolute budgets** — $20/day is meaningless across users. Store **marginal rates of substitution** (exchange rates), which are wealth-portable and compose directly into an objective function.

```
UserPreferenceVector {
  // exchange rates — elicited, not asked
  cents_per_avoided_error: number      // what one prevented wrong answer is worth
  seconds_per_avoided_error: number    // latency the user will spend to avoid one
  error_deductible: number             // errors/1000 absorbed before escalating (insurance framing)

  // stakes mapping — user-specific, overrides the global constants
  stakes_overrides: Partial<Record<StakesLevel, {
    act_bar?: number; ignorance_cap?: number; min_confidence_to_act?: number;
  }>>

  // domain escalation — categories this user always treats as high-stakes
  always_high_stakes: string[]         // e.g. ['health','financial','legal']

  provenance: 'declared' | 'revealed' | 'default'
  updated_at: string
}
```

**Elicitation by revealed preference, not a settings form.** Offer the fast-cheap answer beside the slow-verified one and record which is chosen at which stakes level; the exchange rate falls out of the choices. Declared preferences seed it; revealed preferences overwrite them (people mis-report what they'll pay for accuracy). A user who never opens settings still gets a tuned agent.

**Resolution order:** user override → org default → global constant. Absent a vector, behavior is byte-identical to today.

## 3. Scoring that flattery cannot win

**The failure to design against:** an end-of-chat satisfaction rating *trains sycophancy*, because agreement reliably produces satisfaction. That is most of why models flatter. Do not build it.

**Use a strictly proper scoring rule.** Every answer carries a stated confidence; the ledger later scores it against outcome with Brier or log loss. Under a strictly proper rule an agent maximizes expected score **only** by reporting its true belief — agreement-to-please becomes arithmetically costly rather than merely discouraged. This is the same Brier/log calibration the hardened RepID spec already names as the truthfulness floor, pointed at conversation.

```
CalibrationLedgerEntry {
  claim_id, session_id, participant_id      // agent | model | human
  claim: string
  stated_confidence: number                 // 0..1, REQUIRED at emit time
  stakes: StakesLevel
  outcome: 'true' | 'false' | 'unresolved'
  verification_strength: <L2 hierarchy from participant-rating.ts>
  brier: number                             // (conf - outcome)^2, lower is better
  resolved_at: string | null
}
```

Two axes, never collapsed (L5): **calibration** (is stated confidence honest) and **accuracy** (is the answer right). An agent that says "0.5" and is right half the time is perfectly calibrated and only moderately useful — the user needs to see both.

**Score outcomes, not form.** If the score rewards carrying an `[R]` tag, everything gets tagged and nothing is communicated. This is the T3 lesson: the delayed held-up-in-use signal is highest-weighted *because* it is hardest to game.

## 4. Consequence must change policy, not prompt

A rating loaded into context at session start is a **prior** sitting far from the generation point — structurally identical to the stale `CLAUDE.md` line that caused incident 001. Present and ignored.

The score must instead move **policy**:
1. **Routing** — which model for this (task-class, stakes, budget), from measured per-class performance.
2. **Verification depth** — how many independent families must agree before emit; escalate when the expected cost of error exceeds `cents_per_avoided_error`.
3. **Gating** — below `MIN_CONFIDENCE_TO_ACT` for this user at this stakes level, the answer does not ship; it abstains or asks.
4. **Abstention** — "I don't know" is a valid, *scored* output. Under a proper rule, honest abstention beats confident error.

**Sequencing note (borrowed from the same incident):** proximity to the generation point governs influence. In-loop consequence (this turn blocked, this route changed) shapes behavior; out-of-loop consequence (a score reviewed next week) does not.

## 5. Agents rating models vs. agents rating each other
Both reduce to edges in the existing participant-rating graph — nodes are already `agents / LLMs / SLMs / humans`.

- **Agents → models** (higher value now): produces the routing signal. Anchored in execution-verified outcomes, the top of the L2 hierarchy.
- **Agents → agents** (lower value until outcome data exists): produces quorum trust weights. Without ground-truth anchoring this degenerates into opinion — L1's earned-rating gate (no verified engagement receipt ⇒ edge rejected) is what keeps it honest.
- **Bilateral user ↔ agent** — borrow **double-entry bookkeeping**: both sides post an entry for the same interaction and they must reconcile. The *discrepancy* (agent claims delivered, user says not) is the highest-value signal, because it localizes where expectation and delivery diverged. That makes "manage expectations" measurable.

## 6. Build order (each independently shippable, all shadow-first)
| # | Deliverable | Depends on | Acceptance |
|---|---|---|---|
| 1 | `stakes-policy.ts` — resolve thresholds via (user → org → global); `sbfa-consensus` reads the resolver instead of module constants | none | absent a vector, outputs byte-identical to today (property test over the existing suite) |
| 2 | Calibration ledger (table + writer, shadow) | — | Brier computed on resolved claims; unresolved never scored |
| 3 | Stated-confidence at emit | 2 | every scored answer carries `stated_confidence`; missing ⇒ rejected, not defaulted |
| 4 | Revealed-preference elicitation (paired fast/verified offers) | 1 | ≥N choices ⇒ inferred exchange rate; provenance flips `default`→`revealed` |
| 5 | Policy application: routing + verification depth from the vector | 1,2,4 | measured cost/accuracy delta vs. the global-constant baseline |
| 6 | Bilateral reconciliation entries | participant-rating-ledger | unreconciled pairs surfaced as a rate |

**Promotion gate for each:** shadow ≥1 week, read the log, promote only on a measured false-positive rate <10% — the same discipline as `provenance-check.js` and `HAL_QUORUM_WEIGHT_DEDUP`.

## 7. Honest risks
1. **Goodhart.** Any score becomes a target. Mitigation: score outcomes not form; keep axes uncollapsed; keep T3-style delayed signals highest-weighted.
2. **Preference profiles are sensitive.** A vector describing how much a person will pay to avoid being wrong is behavioral data. It must be user-owned, exportable, deletable, and never a routing input to third parties.
3. **Calibration needs resolution.** Brier requires outcomes. Most conversational claims never resolve — expect a thin scored subset and do not let `unresolved` silently count as correct.
4. **ANFIS is not real yet [R].** Anything phrased as "ANFIS learns the weights" is roadmap. v0 must work with explicit resolution and simple regression.
5. **Cold-start.** A new user has no revealed preferences; defaults must be safe (today's global constants) and the system must say it is using defaults.

## 8. Open questions (for Grok — see the cold brief)
Q1 Is the agent-side preference vector the right locus, or does it belong in a protocol layer both agent and model read?
Q2 Does a strictly proper scoring rule survive contact with users who *want* agreement — or does it just relocate the sycophancy?
Q3 Are exchange rates elicitable in practice, or does revealed preference collapse under context effects?
Q4 Is agent↔agent rating worth building before there is outcome data to anchor it?
Q5 What breaks first at 10k users — the ledger, the elicitation, or the thresholds?
Q6 What discipline outside CS has solved user-specific risk thresholds at scale, that we haven't borrowed?
