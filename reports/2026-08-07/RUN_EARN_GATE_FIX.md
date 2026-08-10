# RUN_EARN_GATE_FIX — the trustshell `/run` "+19 RepID per prompt" theater fix

**Date:** 2026-08-07
**Repos:** `repid-engine` (engine gate) · `trustshell` (UI verdict)
**PRs:** repid-engine #371 (engine earn-gate) · trustshell #58 (UI verdict)
**Status:** committed; **shadow / default-OFF** behind `REPID_RUN_EARN_GATE` (Rule 23 — it changes live RepID)
**Peer-review posture:** every claim below is either quoted from committed code (with file:line) or from a passing test. Numbers carry their source.

---

## Objective

Stop the trustshell `/run` product from awarding a flat positive RepID reward (observed as roughly **+19 per prompt**) regardless of answer quality. The owner's observation was that it "looked like another chatbot that gives 19 points per question" — i.e. the surface credited *asking* rather than *delivering*. The goal of this change is to prove the scoring **machine discriminates**: an open-ended advisory answer that was merely *not vetoed* should earn ~0, while a real deliverable or a fact-checked-clean claim still earns.

This is explicitly **not** a claim that the reward weights are stranger-calibrated. It is a claim that the earn path now requires an affirmative signal instead of treating "not vetoed" as "earned."

---

## Method

1. Traced the `/run` request path from the trustshell Run page to the engine scoring handler.
2. Identified the exact body values the UI hardcodes on every prompt.
3. Read the engine `score-event` handler to see what HAL actually evaluates for a non-verifiable prompt and where the positive reward is computed.
4. Located the existing purpose-classification machinery (`src/scoring/task-purpose.ts`) and its `deliverable`-by-default asymmetry.
5. Added a reward gate that requires an affirmative earn signal, gated shadow-first behind an env flag, with per-event measurement fields.
6. Added a unit test asserting the policy, and mirrored the UI to render an honest verdict.

---

## Root cause (verified)

- The Run page (`trustshell` `app/run/[agentId]/page.tsx`) posts every prompt to the engine endpoint `POST /api/v1/agents/:id/score-event` with **hardcoded** body values `outcome: 'success'`, `task_domain: 'general'`, `certainty: 0.85`.
- In the engine handler (`repid-engine` `src/routes/agents-external.ts`), HAL runs, but its fact-check quorum only judges **verifiable** categories (factual / time-sensitive / math). An open-ended advisory prompt such as *"can you scrape websites"* is **not verifiable**, so HAL only ran the **dissonance** path.
- `halApproved` for such a prompt means only that dissonance is below threshold — "**not obviously harmful**" — which is **not** verification that the answer is good. As the handler comment now records (`agents-external.ts:617–621`): `halApproved` "only means dissonance is below threshold … which is NOT verification that the answer is good. Without this, every plausible chatbot answer farms a flat reward (the '+19 per prompt' theater)."
- `calculateFullReward` then paid the positive reward (~+19). The system was treating **"not vetoed"** as **"earned."**

### Why the existing purpose machinery did not already stop it

`classifyTaskPurpose()` in `src/scoring/task-purpose.ts` **defaults unknown domains to `deliverable`** (`task-purpose.ts:204–206`). That default is **correct for the penalty direction** — an unknown/new domain should not be able to dodge a HAL veto — but it is **wrong for earning**: a free-form advisory chat run (`task_domain: 'general'`) must not be granted a positive reward merely for being unrecognized. That asymmetry (penalties default-on, earning must not) is the direct source of the bug.

---

## The fix (verified, committed)

### 1. New earn-signal helper — `isDeliverableDomain()` (`src/scoring/task-purpose.ts:74–76`)

A new exported pure function that returns true only when `task_domain` is in the existing `DELIVERABLE_DOMAINS` set (`service_contract`, `code`, `build`, `deploy`, `development`, `feature`, `engineering`, `code_contribution`, `bugfix`, `refactor`, …). It is deliberately **distinct** from `classifyTaskPurpose`: the doc comment (`task-purpose.ts:63–73`) spells out that the classifier's `deliverable` default is right for penalties and wrong for earning, and that "A positive reward needs an affirmative work signal — this returning true, or a HAL fact-check that returned clean." Case-insensitive; `null`/`undefined`/`'general'` → false.

### 2. Reward gate in the `score-event` handler (`src/routes/agents-external.ts:617–640`)

A **positive** reward now requires an affirmative signal:

```
factCheckClean = factCheckDecision !== null
                 && factCheckDecision !== 'vetoed'
                 && factCheckDecision !== 'flagged'
positiveEarned = isDeliverableDomain(task_domain) || factCheckClean
```

If `preClamp > 0 && !positiveEarned`, the positive reward is zeroed (when enforced). **Penalties are unchanged** — a HAL veto/flag still costs; `preClamp` for a non-approved event stays `-Math.abs(baseDelta)` and is never touched by this gate.

### 3. Shadow-first per Rule 23 (`agents-external.ts:629–640`)

The gate changes live RepID, so it is **OFF by default**, controlled by env flag `REPID_RUN_EARN_GATE`:

- **OFF (default):** logs what it *would* do (`earn-gate SHADOW: would zero unverified non-deliverable reward …`) and records the counterfactual on every event for measurement — it does **not** alter the score.
- **ON (`REPID_RUN_EARN_GATE=true`):** logs `earn-gate ENFORCED: … → 0` and actually zeroes the unverified positive reward.

Every event's metadata now carries an `earn_gate` block (`agents-external.ts:693–701`): `positive_earned`, `fact_check_clean`, `deliverable_domain`, `would_suppress` (what the gate would do this event regardless of enforcement — the shadow-measurement field), `enforced`, and `suppressed`.

### 4. Honest response fields + UI verdict

The handler response now returns `purpose_suppressed` and an `earn_gate` object (`agents-external.ts:898–905`). The trustshell UI (`app/run/[agentId]/page.tsx` + `lib/db.ts`, PR #58) reads these and renders **"0 earned — conversational, not a deliverable"** when suppressed, or an honest shadow note otherwise. The UI **degrades gracefully** if the fields are absent (older engine build), so the two PRs are not order-coupled.

---

## Evidence

- **`tests/earn-gate.test.ts` — 7/7 passing.** Coverage:
  - `isDeliverableDomain` TRUE for work-product domains (`code`, `service_contract`, `build`, `bugfix`, `refactor`, `engineering`) and case-insensitive.
  - `isDeliverableDomain` FALSE for advisory/conversational/unknown (`general`, `chat`, `conversation`, `qa`, `advice`, `random`, `''`, `null`, `undefined`).
  - Policy unit (`positiveEarned = deliverableDomain OR factCheckClean`): `general` + not-fact-checked → **NOT earned** (the +19 bug); `general` + fact-check-clean → **earned**; `code` → earned without a fact-check; deliverable + fact-check-clean → earned.
- **`npx tsc --noEmit` clean** across the full `repid-engine` project.
- **trustshell app typecheck clean.**
- **PRs:** repid-engine #371 (engine earn-gate), trustshell #58 (UI verdict).

---

## Mistakes / risks

- **Asymmetry is the trap, and it is deliberate here.** Reusing `classifyTaskPurpose` directly would have been wrong: its `deliverable` default is load-bearing for the *penalty* path. The fix adds a **separate** earn-only predicate rather than repurposing the classifier, precisely so a future edit to one direction does not silently move the other. Anyone extending this must keep the two directions separate.
- **`DELIVERABLE_DOMAINS` is an allowlist, so it can under-credit.** A genuine deliverable submitted under an unrecognized `task_domain` string will not earn unless HAL fact-check comes back clean. The mitigation is that the set is epoch-tunable (Sean owns the final set) and the safe direction here is under-crediting an earn, not over-crediting one. The shadow numbers will surface any false-negatives before enforcement.
- **The gate only governs the positive branch.** By design it never softens a penalty; a regression that accidentally routed penalties through it would be a real defect. The handler keeps the penalty `preClamp` path (`-Math.abs(baseDelta)`) entirely outside the gate.
- **Not stranger-calibrated.** This proves the machine *discriminates* deliverable vs. conversational; it does not prove the reward magnitudes are correct for arbitrary users. That remains open work.

---

## Learnings

- **"Not vetoed" is not "earned."** A safety veto (dissonance below threshold) and an earn signal (verified-good delivery) are different judgments; conflating them turns any scoring surface into a participation-trophy dispenser. The bug was structural, not a bad constant.
- **A default that is correct in one direction can be a bug in the other.** The `deliverable`-by-default classifier was right for penalties and wrong for earning; the same predicate used for both directions hid that. Naming the earn path its own function makes the asymmetry explicit and auditable.
- **Shadow-first buys the measurement before the behavior change.** Recording `earn_gate.would_suppress` on every event while enforcement is OFF means the enforcement flip can be justified with real observed suppression rates rather than a guess.

---

## How to make it live

1. **Merge** repid-engine **#371** (engine earn-gate) and trustshell **#58** (UI verdict). Order is not coupled — the UI degrades gracefully without the engine fields — but merging both keeps the receipt honest end-to-end.
2. **Deploy** the engine to the `repid-engine` Railway service and the trustshell UI to its Vercel project.
3. **Observe the shadow numbers.** With `REPID_RUN_EARN_GATE` unset/OFF, read `earn_gate.would_suppress` across `/run` events to see how many positive rewards the gate *would* zero and confirm no real deliverables are being caught (false-negatives).
4. **Enforce** once the shadow data looks right: set `REPID_RUN_EARN_GATE=true` on the `repid-engine` service. From that point, unverified non-deliverable positive rewards are actually zeroed; penalties remain unchanged throughout.
