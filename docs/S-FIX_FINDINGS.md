# S-FIX — findings + surfaced items (2026-06-02)

What shipped as code is in the PR; this captures the analysis + the items that need a human trigger.

## Phase 1 — rating button (FIXED, code) ✅
- The PATCH `/session/:id/rate` endpoint works (repid-engine). The "0 ratings / 49 sessions" gap is
  **deployment, not code**: the frontend repoint to repid-engine lives in **S-WIRE PR #4** (unmerged,
  on GA's brand branch) — merge + deploy that and the button works.
- Shipped here: the rate handler now writes the **real `hal_agreement` column** (was stashed in
  `rating_feedback`) and, on `hal_agreement='disagree'`, logs an **`agent_learning_events`** row
  (`event_type: hal_verdict_disputed`) so HAL miscalls feed calibration.

## Phase 2 — HAL completeness (SHIPPED, gated) ✅
- `src/hal/completeness.ts`: opt-in 6th dimension (does the answer cover the major aspects?). Gated by
  `HAL_COMPLETENESS=true`, **default OFF**. The default 5-signal score formula is **not** changed —
  wiring completeness into the weighted score needs recalibration (it would shift every score). The
  checker is injectable (unit-tested offline). Enable + recalibrate weights before scoring on it.

## Phase 3 — injection hardening (SHIPPED) ✅
- `src/hal/injection-guard.ts` (`scanForInjection`): 10 pattern families, score 0.35/match → one
  pattern flags, two block. Wired into `POST /api/v1/hal/evaluate` (reported always; hard-block only
  when `HAL_INJECTION_BLOCK=true`, default off). 6 unit tests.

## Phase 4 — on-chain minting (SURFACED — needs an explicit human trigger) ⚠️
**Feasibility verified, but NOT executed autonomously.** The IdentityRegistry is **Marco's contract**
(a CLAUDE.md hard-stop — "never touch without explicit permission"), mints are **irreversible**, and
the spec's update code is wrong (`erc8004_address = tx.hash`).
- Deployer `0xdf6b…271d`: **0.0479 ETH** on Base Sepolia — funded for the mints.
- Contract `0x8004A818…` is deployed on Base Sepolia (chain 84532).
- The **correct** path already exists: `src/services/erc8004-minter.ts` `Erc8004Minter.mint()` →
  `register(string agentURI)` → reads `Registered(uint256,…)` → stores **`erc8004_token_id`** +
  `mint_tx_hash` (with a double-mint guard). Use this, NOT the spec snippet.
- **Triage:** only **10 canonical Trinity agents** are genuinely unminted; ~34 of the "unminted" are
  **mock/test** (`mock|test|z2|demo`) and must NOT be minted — mark them `agent_type='TEST'` first.
- **Recommended:** mark the mock agents TEST, then mint the 10 real ones via the existing
  `/api/v1/agents-onchain` mint flow (canary one → verify on sepolia.basescan → batch the rest). This
  is a conscious on-chain operation, deferred to Sean/an explicit trigger.

## Phase 5 — rate-limit + CORS (verify) 
- Global token-bucket rate limiter + per-route limiters exist (`src/middleware/rate-limit.ts`).
- CORS: `origin/main` still uses the **explicit allowlist** (trustrepid/trustshell + localhost) — the
  `trust*.dev` pattern (so `trustchat.dev` can call repid-engine) is in **S-WIRE PR #82**, unmerged.
  Merge #82 to let the live frontend reach these endpoints cross-origin.

## Phase 6 — HAL calibration (analysis) 
- `trustchat_sessions.hal_score` distribution (49 rows): clusters **0.2–0.6** (bucket1 n=10 avg .06,
  bucket2 n=23 avg .31, bucket3 n=13 avg .43, bucket4 n=3 avg .70). This is the **blind strictness-1
  extractor** (AUC ~0.5, confirmed across prior sprints). **The fix is strictness-2** (cross-LLM
  fact-check, AUC 1.00) — already implemented + merged in **S-QUORUM #81**, gated behind
  `HAL_STRICTNESS=2`. **Enable it in Railway** rather than retuning the blind extractor's weights.
  (Do NOT hand-tune the 5-signal weights — sensitive scoring; the real lever is the strictness flag.)

## Phase 7 — leaderboard
- 49 real sessions + 21 cc-seed rows already provide differentiation (see S-WIRE). No extra seed needed.

## Bottom line
The biggest live wins are **operational, not code**: deploy S-WIRE #4 (rating button) + #82 (CORS),
and flip `HAL_STRICTNESS=2` (S-QUORUM #81). The code gaps that were real — hal_agreement column wiring,
the learning-event hook, injection screening, and the completeness capability — are fixed here.
