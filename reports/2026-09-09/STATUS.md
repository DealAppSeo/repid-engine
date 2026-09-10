# LOOP SPRINTS — HAL shadow quorum (Sprint 1 this morning)

Date: 2026-09-10
Repo: DealAppSeo/repid-engine
Branch: `feat/hal-shadow-quorum` off `main`
No merge. No publish. No production env. No card spend. No new folders.
Copy freeze: README / trustshell.dev not touched.

TrustShell PR https://github.com/DealAppSeo/trustshell/pull/121 stays OPEN. HOLD. Not this repo.

## What this sprint did

Shadow planner `src/hal/shadow-quorum.ts`: claimed slots = 6, live stop = 2 families
(same as `MIN_QUORUM_FOR_VETO`). Names who live would call vs who a 6-slot
shadow would still dial. Failover: if the free wave gets zero families, later
tiers are still planned. Never fetches.

```
npx jest tests/hal/shadow-quorum.test.ts --no-coverage
```

Exit: **0**. 4 passed.

Live `factCheck` wave-break is unchanged. 2/6 on the hosted engine stays live-degraded.

---

PROMOTE: (later) shadow planner after review.

HOLD: feat/hal-shadow-quorum — do not merge. Do not turn on 6-wide live calls.

KILL: nothing.

PULL-NEXT: HYP-5 shadow ratchet only
