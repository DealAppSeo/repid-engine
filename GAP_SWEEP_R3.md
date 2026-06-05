# Gap Sweep — HAL / scoring / consensus (R3 Phase 4, 2026-06-03)

Each item: finding → fix → rollback. Items in GA's **in-flight** files are flagged for GA (not
edited this sprint — RULE / sprint header). Items in CC's lane note whether they're already armed.

## 1. `checkPythagoreanComma` misnomer — FLAG for GA (do not edit in-flight `cross-llm-client.ts`)
- **Finding:** `src/hal/cross-llm-client.ts:464` `checkPythagoreanComma(beliefs)` does **not** use the
  comma ratio (531441/524288). It vetoes on `gap < 0.05 && avg > 0.85` — a **coordinated-bias** veto.
  The name implies a load-bearing comma it does not contain (and R1/R2 proved the comma isn't
  discriminative anyway).
- **Fix (GA):** rename to `checkCoordinatedBiasVeto` (and the `comma_*` result fields to `bias_*`),
  pure rename, **no behavior change**. Keeps the constants 0.05/0.85.
- **Rollback:** the rename is non-semantic; revert the symbol if any external caller breaks. Callers:
  `CrossValidationServiceHandler` (update import in the same PR).
- **Lane:** GA owns `cross-llm-client.ts` (actively edited on `feat/ga-2026-06-03-total-package`) — this
  is a handoff recommendation, not a CC edit.

## 2. HAL path still calling the blind extractor — ALREADY ARMED (flip flag)
- **Finding:** `pipeline.resolveHalStrictness()` defaults to **1 = extractor** (AUC ~0.36, the blind
  path) unless `HAL_STRICTNESS=2`. So prod scoring still runs the non-discriminative extractor.
- **Fix:** flip `HAL_STRICTNESS=2` → routes through the cross-LLM fact-check quorum (AUC 0.92 quorum /
  0.77 fact-check). Armed + documented in `DEPLOY_READINESS_R3.md`; safe-default (unset = no change).
- **Rollback:** unset `HAL_STRICTNESS` (or `=1`). Pure env, no migration.
- **Lane:** CC — flag exists; the flip is Sean's deploy action.

## 3. ANFIS-routing cost-cascade — DOCUMENTED gap (design + flag, not implemented this sprint)
- **Finding:** when `HAL_STRICTNESS=2`, `pipeline.runScoreEvent` calls `halService.evaluate` (3-provider
  fact-check) on **every** scoring event → quorum runs 3× LLMs on everything (cost-cascade) once the
  truth path is flipped on. There is no routing predicate to skip the quorum for low-stakes/clearly-
  clean events.
- **Fix (CC lane, next):** gate the quorum behind an ANFIS routing predicate — run the cheap extractor
  first; escalate to the 3-LLM quorum only when ANFIS routing flags the event (high stake, borderline
  extractor score, or high-value contract). Behind `HAL_QUORUM_ROUTING` (default OFF = current behavior).
- **Rollback:** `HAL_QUORUM_ROUTING=false` → quorum-on-everything (current behavior). Reversible by flag.
- **Why not now:** `HAL_STRICTNESS=2` is not yet deployed, so the cascade isn't live; implementing the
  routing predicate is a real feature best done with the flip, not late in this sprint. Flagged so it
  ships *with* the flip, not after a cost surprise.

## Sanity items (no action)
- Drain gate (`9dbeb98`) + truth flip are both safe-default reversible toggles (see DEPLOY_READINESS_R3).
- The R2 comma verdict (B≈C, drift below chance) is recorded by the `comma-verdict` crosscheck so the
  P-003 claim can't drift from the data.
