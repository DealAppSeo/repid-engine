# LOOP SPRINTS — HYP-5 (Sprint 2)

Date: 2026-09-09
Repo: DealAppSeo/repid-engine (local `C:\Users\Cash4\repos\repid-engine`)
Branch: `feat/hyp-5-egress-inventory` off `main`
Linear: HYP-5 — P0 Shrink CALLSITES → 0
No merge. No publish. No live egress change. No new product folders.

## What this sprint did

Pinned CALLSITE → host inventory in `tests/provider-egress-guard.test.ts` (`CALLSITE_HOSTS`).
Wrote `reports/2026-09-09/HYP-5-CALLSITES.md`.

```
npx jest tests/provider-egress-guard.test.ts --no-coverage
```

Exit: **0**. 8 passed, including `every CALLSITE has a pinned host inventory, measured not assumed`.

`CALLSITE_CEILING` remains **12**. Linear 13→0: already 12 after `src/selfhost.ts` retired. Remaining shrink would reroute live callers — out of "tests + inventory only".

## Did not do

- No `src/egress/` chokepoint (new folder = stop).
- No caller rewrite.
- No production env / key spend.

---

PROMOTE: (later) the host-inventory test on this branch, after review.

HOLD: feat/hyp-5-egress-inventory — do not merge. Do not wrap callers this loop.

KILL: nothing. Guard still fails both ways; inventory matches the tree.

PULL-NEXT: HAL-degraded inventory (repid-engine)
