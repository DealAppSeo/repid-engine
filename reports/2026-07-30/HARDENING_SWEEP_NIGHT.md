# Hardening sweep — HAL scores, RepID math, TrustShell/TrustMarket antifragility
**Date:** 2026-07-30 (overnight) · **Author:** CC · **Trigger:** Sean's GO: "improve HAL scores, harden the RepID math, improve the antifragile aspects of TrustShell and TrustMarket as much as you can tonight" · **Method:** live E2E test-first (find the real break, fix at the root, re-verify on prod)

## Objective
Make the publicly-testable loop (npm install / web onboarding → run → HAL verdict → RepID movement) real and self-defending before tester invites go out.

## What the live E2E found (before any fix)
1. **Track-A scoring outage, ~65% of agents.** `POST /agents/:id/score-event` 500'd with `value "322194662852" is out of range for type integer`. Root cause [V, reproduced locally + SQL-verified]: `repid_agents.wisdom_score` carries three scale conventions (57 rows at 1.0 / Postgres DEFAULT 50.0 on every external registration / canonical 1000-centered, max 1500) and the reward path read it raw into an exponential unclamped factor: φ⁴⁹ ≈ 1.7e10 → reward ≈ 4e11 → int4 overflow. φ^1499 = Infinity for correctly-created agents. Prod φ/impact-cap config verified sane first.
2. **TrustShell web runs never scored.** The run page sent `{prompt, response}` (contract requires the full decision event + Bearer agent key) and the create flow dropped the once-only `api_key` — every failure was swallowed and rendered as "RepID Δ: 0.00". Two independent breaks, both invisible to the user.
3. **TrustMarket split-brain.** The code serving production (agentic/machine-discovery surfaces) existed only on an unpushed local branch promoted to Vercel by CLI; the default branch lacked it.

## Fixes shipped
| PR | Repo | Content | Status |
|---|---|---|---|
| #274 | repid-engine | `normalizeWisdomForReward()` (each scale's neutral → 1.0, clamp [0.5,2.0], loud-log) + `clampEventDelta()` backstop (±9990, non-finite→0). Formula untouched (hard-stop); data untouched (1000-scale canonical for its consumers). 13 tests incl. end-to-end property over every observed prod wisdom value with live prod φ/cap. | **MERGED** |
| #50 | trustshell | Create flow persists the one-time `api_key`; run page sends the full decision-event contract with Bearer auth; HAL verdict chip per run; 403 Constitutional block rendered as VETOED (product working); failures show "⚠ Not scored: reason" — never a fake Δ; legacy keyless agents get a recreate notice. | green, awaiting Sean's merge (classifier blocks CC) |
| #2 | trustmarket | Cherry-picks the deployed agentic commit onto the default branch, ending the drift; deploy-flow note: prod only via branch merges from now on. | green, awaiting Sean's merge |

## Antifragility principles applied
- **Fail loud, degrade narrow:** a poisoned row now costs accuracy on one factor of one event (logged), never the scoring path; UI failures say "not scored" instead of lying with 0.00.
- **Neutral-point mapping over data rewrites:** the reward read defends itself against all three scale conventions and any future one (clamped), instead of a fragile one-time data repair that would break the 1000-scale consumers.
- **A veto is a feature:** HAL's constitutional block is now rendered as a verdict, not an error.
- **Prod reached only through branch merges** (TrustMarket note; same lesson as the July trustshell drift).

## Mistakes / limitations (honest)
- The earlier browser test read "Δ 0.00" as absence-neutral scoring; it was a swallowed 400. Lesson: a zero that can't be distinguished from a failure is a failure of the surface — fixed by the honesty rules above.
- `certainty` on web runs is a fixed 0.85 (UI collects no confidence); labeled as such in code.
- The wisdom-scale *data* divergence (three conventions in one column) still exists — normalization contains it, but a schema-level cleanup (single convention + column default aligned to canonical 1000) needs a Sean-approved migration.
- Score-event deltas for fresh agents are now formula-sane, but the tuning of those magnitudes is exactly the open weights work.

## Verification (to complete post-deploy)
- Re-run SDK E2E (register → good/bad score-events) → expect 200s, sane deltas, RepID movement; RED→GREEN vs yesterday's failure. Recorded below when run.
- Browser re-run after #50 merges → verdict chip + real delta or honest error.

## Second wave (Sean's follow-up GO: "test x402 also in A2A transactions")

The A2A E2E kept finding real faults; each was fixed at the root and re-verified. Chain of findings:

| # | Finding [all V, live prod] | Fix | PR | Verified after deploy |
|---|---|---|---|---|
| 4 | Score-event insert 500: `agent_repid_history.payment_proof_hash` UNIQUE + constant fallback literal → every keyless delta event died (unmasked by #274) | per-event `idempotency_key` UUID (app-side, no DDL) | #275 MERGED | ✅ score-events HTTP 200, +19 vested |
| 5 | **HAL discrimination gap**: fabricated decision_text ("Eiffel Tower in Berlin, built 1611 by Newton") earned +19 (hal 0.326) — the agreement signal judges provider consensus about the PROMPT, never the agent's ANSWER (fact-check.ts header documents exactly this) | fact-check quorum (the `trustshell verify` evaluator) on decision_text for factual/time-sensitive/math; vetoed → 403 block, flagged → no reward; kill-switch env | #277 MERGED | ✅ same hallucination now → `403 fact-check quorum veto` (`fact_check_decision:"vetoed"`); accurate answer unchanged (+19) |
| 6 | f2-authz over-reach #1: contract UUID in path read as agent id → ALL bound keys 403'd on `/contracts/<id>/*` — A2A was operator-key-only | contract-party membership check (buyer/provider), stronger than before | #276 MERGED | ✅ per-agent keys drive the loop |
| 7 | f2-authz over-reach #2: last-segment word-whitelist 403'd `/services`, `/contracts` for bound keys | scoped to `/agents/` paths; body-binding governs collections | #278 MERGED | ✅ service listed + contract created with own keys |
| 8 | Falsy zero: `min_repid_to_purchase: 0` stored as 500 (`0 ‖ 500`) → fresh buyers 403'd off open services | `?? 500` | #279 | test-pinned |
| 9 | **BURN TRAP**: wallet provisioning silently fails at registration (ALL fresh agents `wallet_address NULL` [V SQL]) and escrow fell back to `payTo = 0x0` — a real x402 v2 challenge that would burn the buyer's USDC (observed live in the 402 envelope) | validate provider wallet (isAddress + non-zero) → honest `409 provider_wallet_missing`; never a zero-address challenge | #279 | 409 verified post-deploy |

**A2A x402 state after tonight [V]:** self-serve with per-agent keys through list-service (201) → create-contract (201) → escrow, where prod (`X402_ENFORCEMENT_ENABLED=true`) correctly demands a real EIP-3009 payment (x402 v2 envelope, Base Sepolia USDC `0x036cbd…`, correct amount). The **paid leg is blocked on one Sean-gated root cause**: custody env `AGENT_KEY_MASTER` is set nowhere (not on Railway — provisioning fails silently; not in `.env.master` [V names-only grep]) — so no fresh agent has a wallet to receive or pay from. Generate + set `AGENT_KEY_MASTER` (Railway + .env.master), then fund a test buyer with Base Sepolia USDC, and the full paid loop can run.

**Also fixed this wave (first wave, recap):** #274 wisdom-scale (scoring outage for 104/161 agents), trustshell #50 (run-page scoring honesty — awaiting Sean merge), trustmarket #2 (split-brain — awaiting Sean merge).

**Residuals for Sean:**
1. Set `AGENT_KEY_MASTER` (new secret — nothing to reuse) on Railway + .env.master; consider a follow-up backfill provisioning for existing NULL-wallet agents.
2. Merge trustshell #50 + trustmarket #2 (classifier blocks CC on those repos).
3. Wallet-provisioning failure is still SILENT at registration (best-effort catch) — consider surfacing `wallet_provisioned:false` in the register response so callers know.
4. T2/T3 sim-gate (F1) — in flight in Sean's other session.
5. ~13 throwaway `cc-*`/`trinity-cc-*` smoke agents + 2 throwaway services created tonight, all named/described safe-to-delete.
6. The wisdom-scale DATA divergence (three conventions in one column) is contained by normalization but deserves a schema-level cleanup migration (single convention + aligned column default).
