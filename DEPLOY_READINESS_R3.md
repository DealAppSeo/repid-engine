# DEPLOY READINESS — Truth Path + Drain Stop (R3, 2026-06-03)

**One merge + one deploy turns on the truth path and stops the RepID drain.** Both changes are behind
safe-default, reversible env toggles — merging changes **nothing** until the flags are flipped.

## What's ready (unmerged on `feat/cc-2026-06-03-r3-armtruth`, carries `9dbeb98` drain gate)

| Item | Commit | Toggle | Default | Effect of default |
|---|---|---|---|---|
| Drain gate (penalty needs `hallucination_caught`) | `9dbeb98` | `HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION` | **ON** (`!== 'false'`) | drain stops the moment code deploys (no flip needed) |
| Truth-path scorer (cross-LLM fact-check) | prior (`HAL_STRICTNESS` path) | `HAL_STRICTNESS` | **unset → 1 (extractor)** | prod unchanged on merge; flip to `2` routes scoring through fact-check |

> Note: the sprint's `HAL_SCORER=extractor→factcheck` is the real flag **`HAL_STRICTNESS`** (`1`=extractor,
> `2`=fact-check). `HAL_SCORER` does not exist in code; use `HAL_STRICTNESS`.

## Deploy sequence (Sean — one action each)

1. **Merge** `feat/cc-2026-06-03-r3-armtruth` (incl. `9dbeb98`) to `main`. *(Optionally merge GA `51ea68a1` for the hardened client — integration verified conflict-free; not required for the drain stop.)*
2. **Deploy** `main` to Railway (normal deploy; no env change yet).
   - On boot, the drain gate is ON by default → the 9 floor-pinned agents **stop being re-clamped** on new HAL_SCORE_EVENTs.
   - **Verify:** `npm run verify:crosscheck -- --only repid-floor` — over a clean window, `current_repid` rises off the floor as agents earn positive deltas. (The gate stops *further* drain; it does not restore already-lost RepID — a backfill-to-peak is a separate XC/Sean call.)
3. **Shadow (optional, recommended before flip):** set `HAL_STRICTNESS=2` on a canary instance / 10% only; compare fact-check vs extractor on live traffic.
4. **Flip:** set `HAL_STRICTNESS=2` in prod env → scoring routes through the cross-LLM fact-check quorum (the discriminative path; see Grok evidence). Tie to ANFIS routing so quorum isn't run 3× on everything (Phase 4 gap item).

## Rollback (each independently reversible)

- Truth path: unset `HAL_STRICTNESS` (or `=1`) → instant revert to extractor.
- Drain gate: set `HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION=false` → restores prior (draining) behavior.
- No DB migration is involved; both are pure env toggles. No code revert needed to roll back.

## Pre-merge gate (current state)

`verify:crosscheck` is **RED** (correctly) on real findings that are **not** in the truth-path code:
`f2-authz` + `controller-sanitizer` (GA's fix list), `repid-floor` (clears post-deploy), `zkp-anchor`
(XC's EAS), `hal` (F1 0.571 — measurement of the *extractor*; the flip to fact-check is the fix).
None block the *drain stop*, which is the safe-default behavior of merging `9dbeb98`.
