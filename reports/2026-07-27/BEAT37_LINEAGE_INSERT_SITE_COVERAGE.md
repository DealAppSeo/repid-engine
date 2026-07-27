# Beat 37 — closing FINDING 3, and pinning the enumeration that let it happen

**Date:** 2026-07-27 · **Branch:** stacked onto `feat/cc-2026-07-27-lineage-depth-budget` (repid-engine PR #217)
**Scope:** the item Beat 36 named for this beat — lineage-tag `POST /directives` — plus the root cause behind it.

## The finding, re-derived before acting

Beat 36's independent verifier reported that #217's "all six enqueue chokepoints, enumerated by grep"
missed a seventh: `POST /api/v1/controller/directives`, operator task injection, with no lineage
tagging at all. A verifier's example can itself be wrong (Beat 32), so this was re-enumerated here
rather than taken on report. Walking `src/**/*.ts` for every `.insert(` whose statement targets
`trinity_tasks`, deduped by the offset of the `.insert(` token:

| # | site | lineage |
|---|---|---|
| 1 | `routes/v1/controller.ts` — `POST /directives` | **NONE** ← the finding |
| 2 | `routes/v1/controller.ts` — `POST /wake/:agent_id` | `...rootLineage()` |
| 3 | `routes/v1/controller.ts` — `POST /sprint/:agent_id` | `...guarded.fields` / `...lineage` |
| 4 | `services/peer-verification-reader.ts` — blind panel dispatch | `...rootLineage()` |
| 5 | `services/peer-verification-reader.ts` — legacy single-verifier dispatch | `...rootLineage()` |
| 6 | `services/receipt-indexer.ts` — receipt validation task | `...rootLineage()` |

**Six distinct sites, five tagged, one not.** The finding is confirmed exactly [V].

## The fix that matters is not the missing line

`/directives` now writes `...rootLineage()` explicitly, with the reason at the call site. That is four
lines. The defect it represents is bigger: **the enumeration lived in prose and could not be re-run.**
This is the same shape as the emergency-halt hole two beats running — a "global" switch that reached
3 of 14 tick loops — and it gets the same treatment: `tests/task-lineage-coverage.test.ts` walks the
filesystem in CI. A `trinity_tasks` insert added next month fails there until someone classifies it.

**Counted PER INSERT SITE, not per file — that is the whole lesson.** The halt pin originally counted
per FILE and six loops hid behind one justification. Here `controller.ts` holds three inserts and
`peer-verification-reader.ts` holds two: a file-granular check would have reported both files covered
while `/directives` sat untagged, which is precisely what happened. Exemption keys are
`<file>#<site index>` and the pin refuses a bare file path, so a blanket exemption cannot come back.

## A caveat stated now rather than discovered later

Root means `/directives` is **exempt from the depth budget by construction**. That is correct while
`operator` is a human credential, and it stops being correct the moment an autonomous caller holds an
operator token — at which point this is an unbounded spawn path. Written at the call site, with the
fix named (accept an optional `parent_task_id`, exactly as `POST /sprint/:agent_id` does). Not built
today: no caller knows a parent, and duplicating `/sprint`'s ~25-line parent resolution to serve a
hypothetical would be the refactor CLAUDE-RULE-3 exists to prevent.

## Verification

- **7 of 7 mutations killed**, each run against the absence of the property it asserts:
  untag `/directives` · add a new untagged insert to an already-covered file · blind the enumerator ·
  `isTagged` always true · stop stripping comments · a blanket file-wide exemption · untag the
  receipt-indexer site. Baseline pass → post-restore pass → **zero `MUTMARK37` residue on disk
  (checked, not assumed)**.
- **Two mutations first reported NOT-LANDED** because these files are CRLF and the patterns used
  `\n`. That is the guard doing its job — under a harness without the marker check they would have
  been two free passes. Same trap as Beat 36; the harness now normalises EOL.
- `tsc --noEmit` clean. **65 tests across the 3 touched suites** — taken from jest's own total, never
  by summing the suites I happened to watch (Beat 36 FINDING 2).
- Full local suite: see the beat entry; the only expected failures are `hal-accuracy-summary` and
  `trinity-swarm-health`, which fail identically at baseline (credential-dependent ENV/CONFIG).

## What this does not cover

The pin proves every insert **site** carries a lineage decision. It does not prove the decision is the
*right* one — a site that spreads `...rootLineage()` when it genuinely has a parent would pass. The
one known instance is documented in `task-lineage.ts`'s header (the peer-verify queue hop carries no
task reference; closing it needs the upstream producer in `trinity-symphony-shared`), and breaker 2.3
is what bounds that loop today.
