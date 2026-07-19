# Ship Merge-Prep — HAL precision + RRL + retrieval → one hardened branch (2026-07-18)

**Goal:** turn the tested branch stack into one clean, co-signable branch so the hardened HAL/RRL is what ships to NPM/CLI/MCP/SDK. Prep done solo (branch-only, zero-cost); merge + deploy remain Sean-gated (no self-merge).

## What the "5-branch stack" actually was
The branches were a **linear chain**, not five parallel merges. `feat/rrl-calibration` already contained cycle2+cycle3+corpus+honesty-sim+shadow; `feat/hal-outcome-labeling` and `feat/rrl-shadow-ws2.3` were just labels pointing inside that chain (no unique work). The **only** real divergence was `feat/hal-retrieval-ws1.2a` (one commit, `ec82d42`).

**Assembled:** `integration/ship-2026-07-18` = `feat/rrl-calibration` + cherry-pick `ec82d42`. 7 commits on top of `main` (01a46f0):
| commit | content |
|---|---|
| 8a407f4 | LAO/cache/HAL two-agent runtime + ground-truth labels (gemini base — **not yet on main**) |
| 8c006ed | HAL precision cycle2 — plurality guard + Grok tiebreak |
| 458a815 | HAL precision cycle3 — confidence-gated pre-veto Grok override |
| 283b1fc | decontaminated corpus v1 (SimpleQA-Verified + HaluBench) |
| 15473c1 | RRL WS2.2 honesty-dominance sim + results |
| acfe445 | RRL WS2.3 Stage-0 shadow scorer + shadow ledger |
| ebf5c7f | RRL calibration-correction |
| f8e7b47 | HAL WS1.2a dual-path retrieval + CRAG (cherry-picked) |

## Verification (all [V], run by orchestrator)
- **Build:** `npm run build` (tsc) → exit 0, clean.
- **Deterministic tests:** 1948/1948 green. Fixed 1 stale test + added 3 new plurality-guard tests (see below).
- **Only red suite:** `tests/hal/golden-math.test.ts` (2 real-provider tests). **ENV, not code** — fails identically on `main`; cause = jest loads the committed dummy `.env` (dead groq key `…gzDf0` → HTTP 401) + gemini/cerebras 429 rate limits. Real-provider golden-math is designed for GA's keyed CI, not local `npm test`.
- **Patent core:** `src/hal/lib/*` untouched across the whole stack.
- **Secrets:** 0 hardcoded-secret patterns in the committed diff.
- **Conflicts:** none (read-only merge-tree + cherry-pick both clean).

## The one behavior change on merge
**Plurality guard is default-ON** (`HAL_PLURALITY_GUARD !== 'false'`, `fact-check.ts:895`): a FALSE minority can no longer veto a TRUE plurality (would-be veto → `clean` on a TRUE majority, else `flagged`). This IS the cycle2/3 precision win (FP ~halved). Reversible via `HAL_PLURALITY_GUARD=false`.

Everything else is default-OFF and dormant until flagged: `HAL_RETRIEVAL_ENABLED`, `HAL_ESCALATE_GROK` (+ CRAG/override tuning), `ANFIS_RETUNE_ENABLED`. `HAL_SBFA_SHADOW` stays shadow (observe-only; pre-existing).

## Regression found + fixed (overturned the "cycle3 = clean winner" premise)
`tests/hal/fact-check.test.ts › lower veto threshold flips flagged→vetoed` **passed on main, failed on cycle3** — cycle3's default-on plurality guard downgraded the low-threshold veto to `clean` for its TRUE-plurality mock. The eval F1 improved but this deterministic unit test was never updated. Fixes (branch-only):
1. Scoped the stale test to `HAL_PLURALITY_GUARD=false` (it tests threshold mechanics, not the guard).
2. Added `describe('plurality guard (cycle2, default-on)')` — 3 tests covering the default, the opt-out, and the FALSE-majority no-op. Closes a coverage gap: the default-on guard had **zero** prior tests.

## NOT in the ship (accurate scope)
- Outcome-labeling (`src/hal/outcome.ts`, `scripts/hal/label-run.ts`, `migrations/2026-07-18-hal-outcomes.sql`) is **uncommitted/loose** — never committed to any branch. So **this merge needs no DB migration.** Wire it as a separate follow-up if wanted.
- The ship includes `8a407f4` (gemini LAO/cache base) because cycle2/3 were built on it. If that scope isn't wanted in this merge, it's a rebase decision.

## Remaining Sean-gated chain (the only touches needed)
1. Co-sign + merge the PR (no self-merge).
2. Trigger the Railway redeploy of repid-engine so NPM/CLI/MCP/SDK serve the hardened build (merge ≠ ship).

## Optional low-value follow-ups (not blockers, no action needed now)
- Committed dummy `.env` holds a dead groq key (`…gzDf0`) → local real-provider tests hard-fail instead of skip. Could null it or make golden-math skip on present-but-invalid keys.
- Deployed Railway groq key vs `.env.master` UAdQO: production works (AITSZKP key used today per dashboard); sync only if the old key gets revoked.
