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

PULL-NEXT: HAL-degraded inventory (this repo, sprint 3)

---

## Sprint 3 — HAL quorum inventory

No keys spent. No production env change.

Engine already has `degraded` (<2 succeeded) and `quorum: full|partial|low|outage`.
Pinned: 2-of-3 HTTP500 → `degraded: false`, `quorum: 'partial'`.
```
npx jest tests/hal/fact-check.test.ts --no-coverage
```
Exit: **0**. 23 passed.

Live 6-provider why-table: `reports/2026-09-09/HAL-QUORUM-INVENTORY.md` (dated CC-ASSESS / MCP probe, not re-run).

Did not add a second degraded field. README "live-degraded" ≠ engine `degraded`.

---

PROMOTE: (later) fact-check quorum-partial pin + HYP-5 host inventory.

HOLD: feat/hyp-5-egress-inventory — do not merge.

KILL: nothing.

PULL-NEXT: trustmarket deepen shadow verify-a-claim (buy stays false)

---

## Sprint 2026-09-10 — HYP-5 shadow ratchet only

`src/hal/shadow-provider-fetch.ts` throws on use. No CALLSITE imports it.
Live ceiling still 12. Live fetch paths untouched.

```
npx jest tests/provider-egress-shadow.test.ts tests/provider-egress-guard.test.ts --no-coverage
```

Exit: **0**. 10 passed.

---

PROMOTE: (later) shadow chokepoint after a wrap that lowers CALLSITE_CEILING.

HOLD: feat/hyp-5-egress-inventory — do not merge. Do not wrap live callers.

KILL: nothing.

PULL-NEXT: trustmarket deepen shadow verify-a-claim (buy stays false)
