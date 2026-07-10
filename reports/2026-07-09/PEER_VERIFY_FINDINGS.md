# Peer-Verification: Findings, Root Cause, and Results-Weighting Plan
**Date:** 2026-07-09 · **Author:** Claude (CC) · **Status:** measured [V], plan proposed
**Trigger:** "peer_verify is flooding T12 — is it needed at all, and can we make it results-weighted?" (Sean)

## Objective
Decide whether the peer-verification loop earns its cost, and if so, how to **reduce cost AND increase benefit** (Sean's framing: prequalify so we don't verify every claim; keep the catches; let the hit-rate compound).

## Method
Direct SQL against prod (`qnnpjhlxljtqyigedwkb`): `peer_verification_queue`, `peer_verification_votes`, `trinity_tasks (task_type='peer_verify')`. Code read of the live path in `repid-engine` (`src/index.ts:991`, `src/services/peer-verification-reader.ts`, `peer-verification-writer.ts`, `peer-verify-consensus.ts`) and the enqueue at `src/services/chronic-flag-accumulator.ts:80`.

## Results (verified)
**Volume / cost.** `trinity_tasks` peer_verify ≈ **145k lifetime** (87,909 done · 27,612 archived · **17,107 pending, oldest 10 days** · 12,045 failed). Each queued claim spawns a **blind 3-verifier panel** (`PEER_VERIFY_PANEL_ENABLED` on in prod; pool = mel/shofet/gcm). This is a large, ongoing free-LLM + free-pool sink.

**Effectiveness is near-zero as run:**
- `peer_verification_votes` ≈ 9,931 total → **timeout 84.0% · disputed 14.6% · verified 1.4%.**
- Of votes that actually *land* (non-timeout): **disputed 91% vs verified 9%.**
- Dispute rate is **flat at 84–100% across every certainty band** → the verdict does **not discriminate** (a detector that flags ~everything has no precision). `certainty_at_claim` is mostly a degenerate **0.000**, so the existing "verify band" has no real signal to act on.

**Root cause — garbage in.** The "claims" being verified are **not checkable factual claims.** Samples:
- *"The CAIT Bias and Toxic Content Scan is complete. Here's the summary…"*
- *"The EVERGREEN RepID Audit is complete…"*, *"The CAIT Adversarial Red Team Drill is complete…"*
- *"Peer verification completed with verdict: timeout. Response ID: …"* → **peer-verify is verifying its own prior outputs (recursive).**

These are the fleet's **drill/cron status summaries** (and self-referential loops), which are unverifiable by construction — hence the 84–100% dispute/timeout. So the disputes are **not catches of false-claims-that-would-pass**; they are a verifier choking on non-claims.

## Verdict
Not "verification is useless" — **it is mis-fed and never calibrated.** The mechanism is sound in principle (dogfooding "verify, don't trust"); the failure is (1) enqueuing drill/cron/recursive text instead of real claims, (2) no calibration of what "disputed" means, (3) 84% verifier timeouts. All three are fixable, and the fix is exactly the results-weighting Sean asked for.

## Plan — reduce cost AND increase benefit (compounding)
1. **Prequalify the source (huge cost↓ + benefit↑).** Only verify substantive, checkable claims from real deliverables. **Never** drills/cron/EVERGREEN/CAIT status summaries or self-referential peer-verify text. Implemented as a **prefilter in the reader** (repid-engine — in our control, deploys via the working pipeline) with `off | shadow | enforce` modes. Skipped entries → `verification_status='skipped'`.
2. **Break the recursion** — the prefilter rejects "Peer verification completed…" claim_text; `scripts/purge-recursive-tasks.ts` already exists for cleanup.
3. **Calibrate on known answers (benefit becomes provable).** Run the canary corpus (T12 #388679/#388680 — real TRUE/FALSE) through the verifier → an actual precision/recall number. Only then does "disputed" mean something.
4. **Certainty/risk band on real claims** — enforce the writer's `threshold_used` (0.85) at the caller; spend budget on the uncertain middle, skip high-confidence-correct. Learn which claim-types yield catches → the filter sharpens each round (Sean's "3–4 more times").
5. **Fix the 84% timeout** — raise the verify LLM timeout / route the verify call to a fast provider so votes land.

## Measurement (automated, adaptive cadence)
In-DB, near-zero cost (pg_cron 1.6 installed): `snapshot_peer_verify_metrics()` writes a daily row to `peer_verify_metrics_history` (volume, timeout%, disputed/verified, answered%, dispute-of-answered%, est. skippable%, queue depth). **Cadence: daily while we actively tweak; step to weekly once run-over-run deltas flatten** (reschedule the one cron job). Trend = `SELECT … FROM peer_verify_metrics_history ORDER BY captured_at`.

**Success = est-skippable% → high (cost down), dispute-of-answered% falls toward a calibrated precision on the canary set (signal real), timeout% down.**

## Interim (stop the bleed while we rebuild — not a hard kill)
- Panel 3→1: `PEER_VERIFY_PANEL_ENABLED=false` (Railway toggle, Sean).
- Archive the 17,107 stuck pending + 46k `in_review` graveyard (reversible status flips; Sean's OK — auto-guard blocked the mass update).
